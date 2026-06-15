/**
 * Web Push enrolment (client side). Bridges the browser PushManager to the
 * provider's `/api/push/*` endpoints, all signed through the OFSCP client.
 *
 * Lifecycle:
 *  - {@link enablePush}  — request Notification permission, fetch the provider's
 *    VAPID public key, `pushManager.subscribe(...)`, and POST the resulting
 *    subscription to `/api/push/subscribe`. Persists the enabled flag.
 *  - {@link disablePush} — unsubscribe the browser subscription and POST
 *    `/api/push/unsubscribe`. Clears the flag.
 *  - {@link isPushSupported} / {@link pushPermission} — capability + permission
 *    probes the settings toggle reads to render its enabled/disabled state.
 *
 * The service worker only registers in PROD (see `main.tsx`), so in dev there is
 * no SW/PushManager and {@link enablePush} fails gracefully (the toggle reflects
 * unavailability). The enabled flag is device-local (localStorage).
 */
import type { OfscpClient } from "./ofscp-client.ts";

const ENABLED_KEY = "forumall.notify.push";
const PROMPT_DISMISSED_KEY = "forumall.notify.push-prompt-dismissed";

/** How long to wait for a registered service worker before giving up (ms). */
const SW_READY_TIMEOUT_MS = 5000;

/**
 * Pure visibility predicate for the first-load push nudge. Kept DOM-free so it
 * can be unit-tested without a browser env. The banner shows only when push is
 * supported, permission is still un-asked (`default`), the user hasn't already
 * enabled push, and they haven't dismissed the nudge on this device.
 */
export function shouldShowPushPrompt(args: {
  supported: boolean;
  permission: NotificationPermission;
  enabledPref: boolean;
  dismissed: boolean;
}): boolean {
  return args.supported && args.permission === "default" && !args.enabledPref && !args.dismissed;
}

/** Has the user dismissed the first-load push nudge on this device? */
export function pushPromptDismissed(): boolean {
  try {
    return localStorage.getItem(PROMPT_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist that the first-load push nudge was dismissed (never show again). */
export function setPushPromptDismissed(dismissed: boolean): void {
  try {
    if (dismissed) localStorage.setItem(PROMPT_DISMISSED_KEY, "true");
    else localStorage.removeItem(PROMPT_DISMISSED_KEY);
  } catch {
    /* private mode — best effort */
  }
}

/** Whether this browser exposes the Service Worker + Push + Notification APIs. */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** The current Notification permission (`default` when unsupported). */
export function pushPermission(): NotificationPermission {
  if (typeof Notification === "undefined") return "default";
  return Notification.permission;
}

/** Reactive-friendly read of the persisted enabled flag (device-local). */
export function pushEnabledPref(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

function setPushEnabledPref(on: boolean): void {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, "true");
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    /* private mode — best effort */
  }
}

/** Decode a base64url VAPID key into the `Uint8Array` `subscribe` expects. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Encode an `ArrayBuffer` subscription key as base64url for the server. */
function arrayBufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Await the registered service worker, but race it against a timeout that
 * REJECTS. `navigator.serviceWorker.ready` never resolves when no SW is (or
 * will be) registered — which is the case in dev/`vite dev`, where the SW only
 * registers in PROD. Without this guard `enablePush` would hang forever (the
 * banner Enable + Settings toggle would spin); with it both fail gracefully.
 */
function serviceWorkerReady(): Promise<ServiceWorkerRegistration> {
  return new Promise<ServiceWorkerRegistration>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("No service worker is registered (push is unavailable here)"));
    }, SW_READY_TIMEOUT_MS);
    navigator.serviceWorker.ready.then(
      (reg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(reg);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** The serialisable view of a browser PushSubscription the server stores. */
function serializeSubscription(sub: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  return {
    endpoint: sub.endpoint,
    keys: {
      p256dh: arrayBufferToBase64Url(sub.getKey("p256dh")),
      auth: arrayBufferToBase64Url(sub.getKey("auth")),
    },
  };
}

/**
 * Enable push on THIS device for the signed-in `client`:
 *  1. request Notification permission (rejects if the user denies),
 *  2. await the registered service worker,
 *  3. fetch the provider VAPID public key,
 *  4. `pushManager.subscribe(...)` (reusing an existing subscription),
 *  5. POST the subscription to `/api/push/subscribe` (signed).
 *
 * Resolves `true` on success. Throws on a genuine failure (no SW, permission
 * denied, network) so the caller can surface it and revert the toggle.
 */
export async function enablePush(client: OfscpClient): Promise<boolean> {
  if (!isPushSupported()) throw new Error("Push notifications are not supported on this device");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted");

  const reg = await serviceWorkerReady();

  const keyRes = await client.get<{ publicKey: string }>("/api/push/public-key", {
    anonymous: true,
  });
  const publicKey = keyRes.data.publicKey;
  if (!publicKey) throw new Error("Server did not return a VAPID public key");

  const existing = await reg.pushManager.getSubscription();
  const subscription =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));

  await client.post("/api/push/subscribe", serializeSubscription(subscription));
  setPushEnabledPref(true);
  return true;
}

/**
 * Disable push on THIS device: tell the server to forget the subscription and
 * unsubscribe the browser PushSubscription. Best-effort — always clears the
 * local flag even if a step fails.
 */
export async function disablePush(client: OfscpClient): Promise<void> {
  try {
    if (isPushSupported()) {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await client
          .post("/api/push/unsubscribe", { endpoint: sub.endpoint })
          .catch(() => undefined);
        await sub.unsubscribe().catch(() => undefined);
      }
    }
  } finally {
    setPushEnabledPref(false);
  }
}
