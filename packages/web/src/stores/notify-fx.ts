/**
 * Notify-FX coordinator — the side-effecting layer that turns inbound WS events
 * into an in-page chime, and the live unread total into out-of-app badges (tab
 * title, PWA app badge, favicon dot).
 *
 * The pure decision rules (eligibility / suppression / dedupe / total) live in
 * `notify-fx-core.ts`; this module owns the WebAudio chime, the favicon canvas,
 * the badge effects, and the single WS listener set (installed once per
 * connection by the auth controller BEFORE `ws.connect()`, mirroring the
 * read-marker / notification controllers — no missed-event race, torn down on
 * logout).
 *
 * Everything here is defensive: a missing AudioContext, a rejected `setAppBadge`,
 * a private-mode storage error, or an SSR-ish absent `document` must never throw.
 */
import type { Notification, WsDmMessage, WsEnvelope, WsMessageCreated } from "@forumall/shared";
import { createEffect, createRoot } from "solid-js";
import type { OfscpWsClient } from "../lib/ofscp-ws.ts";
import { activeThread, installFocusTracker, isAppFocused } from "./active-thread.ts";
import { unseenCountFor } from "./notifications.ts";
import {
  Deduper,
  type SoundCandidate,
  badgeLabel,
  computeTotalUnread,
  soundEligible,
  suppressedByPresence,
} from "./notify-fx-core.ts";
import { badgeEnabled, soundEnabled } from "./notify-prefs.ts";
import { totalUnread } from "./read-markers.ts";
import { session } from "./session.ts";

// ---------------------------------------------------------------------------
// WebAudio chime (synthesized; no audio asset)
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;
let gestureUnlockInstalled = false;

/** Lazily create (or reuse) the shared AudioContext. Null if unsupported. */
function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (audioCtx) return audioCtx;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    return audioCtx;
  } catch {
    return null;
  }
}

/**
 * Install a one-time global gesture listener that resumes the AudioContext.
 * Browsers gate audio behind a user gesture; the first pointer/key event unlocks
 * playback, then the listeners remove themselves.
 */
function installGestureUnlock(): void {
  if (gestureUnlockInstalled) return;
  if (typeof window === "undefined") return;
  gestureUnlockInstalled = true;
  const unlock = (): void => {
    const ctx = getAudioContext();
    try {
      void ctx?.resume();
    } catch {
      /* ignore */
    }
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
}

/**
 * Play a short, gentle two-note blip (~120ms). Synthesized via oscillators — no
 * audio file. Never throws; a no-op when sound is disabled or audio is
 * unavailable / still locked.
 */
function playChime(): void {
  if (!soundEnabled()) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    // If a gesture hasn't unlocked playback yet, resume() is a harmless no-op.
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = 0.0001;
    master.connect(ctx.destination);

    // Two soft notes (a rising minor-third-ish blip): 660Hz → 880Hz.
    const notes: [number, number][] = [
      [660, 0],
      [880, 0.06],
    ];
    for (const [freq, offset] of notes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + offset;
      const end = start + 0.09;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.08, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(g);
      g.connect(master);
      osc.start(start);
      osc.stop(end + 0.02);
    }
    // Bring the master up after wiring so the ramps above are audible.
    master.gain.setValueAtTime(0.6, now);
  } catch {
    /* never throw on audio failures */
  }
}

// ---------------------------------------------------------------------------
// Out-of-app badges: tab title, PWA app badge, favicon dot
// ---------------------------------------------------------------------------

const BASE_TITLE = "Forumall";
const FAVICON_SVG = "/forumall-mark.svg";

/** Set the tab title to reflect the unread total (capped 99+). */
function applyTitle(total: number): void {
  if (typeof document === "undefined") return;
  try {
    document.title = total > 0 ? `(${badgeLabel(total)}) ${BASE_TITLE}` : BASE_TITLE;
  } catch {
    /* ignore */
  }
}

/** Reflect the total on the PWA app badge (feature-detected; promise may reject). */
function applyAppBadge(total: number): void {
  if (typeof navigator === "undefined") return;
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (typeof nav.setAppBadge !== "function") return;
    if (total > 0) void nav.setAppBadge(total).catch(() => undefined);
    else void nav.clearAppBadge?.().catch(() => undefined);
  } catch {
    /* ignore */
  }
}

// Favicon management: cache the base SVG rendered to a canvas, then overlay a dot.
let baseFaviconImg: HTMLImageElement | null = null;
let baseImgReady = false;
let faviconDotApplied = false;

function ensureBaseFaviconImage(): void {
  if (baseFaviconImg || typeof Image === "undefined") return;
  try {
    const img = new Image();
    img.onload = (): void => {
      baseImgReady = true;
    };
    img.src = FAVICON_SVG;
    baseFaviconImg = img;
  } catch {
    /* ignore */
  }
}

/** Find or create the managed favicon <link>. */
function faviconLink(): HTMLLinkElement | null {
  if (typeof document === "undefined") return null;
  try {
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    return link;
  } catch {
    return null;
  }
}

/** Restore the original SVG favicon (unread cleared). */
function restoreFavicon(): void {
  if (!faviconDotApplied) return;
  const link = faviconLink();
  if (!link) return;
  try {
    link.type = "image/svg+xml";
    link.href = FAVICON_SVG;
    faviconDotApplied = false;
  } catch {
    /* ignore */
  }
}

/** Draw the base mark + a small red dot, set as a data-URL favicon. */
function applyFaviconDot(): void {
  if (typeof document === "undefined" || typeof HTMLCanvasElement === "undefined") return;
  ensureBaseFaviconImage();
  const link = faviconLink();
  if (!link) return;
  const draw = (): void => {
    try {
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const cx = canvas.getContext("2d");
      if (!cx) return;
      if (baseFaviconImg && baseImgReady) {
        cx.drawImage(baseFaviconImg, 0, 0, size, size);
      }
      // Red dot in the top-right corner.
      const r = size * 0.22;
      const dx = size - r - 2;
      const dy = r + 2;
      cx.beginPath();
      cx.arc(dx, dy, r, 0, Math.PI * 2);
      cx.fillStyle = "#e5484d";
      cx.fill();
      cx.lineWidth = size * 0.05;
      cx.strokeStyle = "rgba(0,0,0,0.35)";
      cx.stroke();
      link.type = "image/png";
      link.href = canvas.toDataURL("image/png");
      faviconDotApplied = true;
    } catch {
      /* ignore */
    }
  };
  // If the base image isn't decoded yet, draw the dot now (on a blank canvas) and
  // again once it loads so we don't block on the async decode.
  draw();
  if (baseFaviconImg && !baseImgReady) {
    baseFaviconImg.addEventListener("load", draw, { once: true });
  }
}

/** Apply all three surfaces for a total (respects the badge pref). */
function applyBadges(total: number): void {
  if (!badgeEnabled()) {
    // Pref off → keep everything in the cleared state.
    applyTitle(0);
    applyAppBadge(0);
    restoreFavicon();
    return;
  }
  applyTitle(total);
  applyAppBadge(total);
  if (total > 0) applyFaviconDot();
  else restoreFavicon();
}

// ---------------------------------------------------------------------------
// WS wiring
// ---------------------------------------------------------------------------

const dedup = new Deduper();
const installed = new WeakSet<OfscpWsClient>();
let badgeRootDisposed: (() => void) | null = null;

/** The active thread's scope id (channel id or dm id), or null. */
function activeScopeId(): string | null {
  return activeThread()?.id ?? null;
}

/** Evaluate a candidate: eligible → not suppressed → not a dupe → chime. */
function maybeSound(c: SoundCandidate): void {
  const me = session.actor;
  if (!soundEligible(c, { me, activeScopeId: activeScopeId() })) return;
  if (
    suppressedByPresence(c.scopeId, { appFocused: isAppFocused(), activeScopeId: activeScopeId() })
  )
    return;
  if (!dedup.shouldSound(c.sourceMessageId)) return;
  playChime();
}

/**
 * Install the single set of FX listeners on `ws` (idempotent). Called once per
 * connection by the auth controller BEFORE connecting. Reacts to `dm.message`,
 * `notification.created`, and channel `message.created`.
 */
export function installNotifyFx(ws: OfscpWsClient): void {
  // One-time global setup (focus tracker, audio gesture unlock, badge effect).
  installFocusTracker();
  installGestureUnlock();
  installBadgeEffect();

  if (installed.has(ws)) return;
  installed.add(ws);

  ws.on("dm.message", (e: WsEnvelope) => {
    const data = (e as WsDmMessage).data;
    if (!data?.message) return;
    const m = data.message;
    maybeSound({
      source: "dm.message",
      scopeId: data.dmId,
      sourceMessageId: m.id,
      author: m.author,
      mine: m.author === session.actor,
    });
  });

  ws.on("notification.created", (e: WsEnvelope) => {
    const data = (e as { data?: { notification?: Notification } }).data;
    const n = data?.notification;
    if (!n) return;
    maybeSound({
      source: "notification.created",
      scopeId: n.channelId,
      sourceMessageId: n.sourceMessageId,
      author: n.author,
    });
  });

  ws.on("message.created", (e: WsEnvelope) => {
    const data = (e as WsMessageCreated).data;
    if (!data?.message) return;
    const m = data.message;
    maybeSound({
      source: "message.created",
      scopeId: data.channelId,
      sourceMessageId: m.id,
      author: m.author,
    });
  });
}

/**
 * Install the reactive badge effect once (in its own root so it lives for the
 * app's lifetime and isn't torn down with a component). Recomputes the total
 * unread from the read-marker scopes + the notification counts and pushes it to
 * the three surfaces whenever any of them — or the badge pref — changes.
 */
function installBadgeEffect(): void {
  if (badgeRootDisposed) return;
  createRoot((dispose) => {
    badgeRootDisposed = dispose;
    createEffect(() => {
      const total = computeTotalUnread(
        totalUnread(),
        unseenCountFor("mention"),
        unseenCountFor("reply"),
      );
      applyBadges(total);
    });
  });
}

/** Clear the badges (logout): reset title / app badge / favicon to the base. */
export function clearNotifyFx(): void {
  applyTitle(0);
  applyAppBadge(0);
  restoreFavicon();
}
