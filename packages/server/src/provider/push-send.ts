/**
 * Web Push delivery (provider-LOCAL, fire-and-forget). Given a LOCAL recipient
 * actor and a small payload, encrypt + POST a real Web Push to each of the
 * recipient's registered browser subscriptions.
 *
 * Contract (honour at every call site):
 *  - **Fire-and-forget**: never blocks or fails the triggering message/DM send —
 *    callers do NOT await, and every error is swallowed/logged here.
 *  - **Local recipients only**: a remote actor (domain ≠ `config.domain`) is a
 *    no-op (we don't hold their subscriptions; their home provider pushes).
 *  - **Gating is the caller's job**: this is only invoked when the recipient has
 *    no live WS connection (`hub.liveConnectionCount(actor) === 0`).
 *  - **410/404 → cleanup**: a push service reporting the endpoint gone deletes
 *    the dead subscription; `ok` stamps `lastDeliveredAt`.
 */
import { canonicalAuthority } from "@forumall/shared";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { buildPushRequest } from "../lib/web-push.ts";
import { type Resolver, guardedFetch } from "./federation/egress-guard.ts";
import { isProviderAllowed } from "./federation/policy.ts";
import {
  deleteSubscriptionByEndpoint,
  getVapidKey,
  listSubscriptions,
  markDelivered,
} from "./push.ts";

/** The notification payload delivered to the service worker (kept small). */
export interface PushPayload {
  /** Notification title (e.g. the author / "New mention"). */
  readonly title: string;
  /** Notification body (a short message preview). */
  readonly body: string;
  /** Coalescing tag (replaces a prior notification with the same tag). */
  readonly tag: string;
  /**
   * Click-through routing data (OFSCP §10.3): `type` plus the structured ids
   * any client can route on, and Forumall's own web-app `targetUrl`.
   */
  readonly data: {
    readonly type: string;
    readonly groupId?: string;
    readonly channelId?: string;
    readonly messageId?: string;
    readonly dmId?: string;
    readonly targetUrl: string;
  };
}

/** The minimal fetch surface, injectable so tests can simulate 410/ok. */
export type PushFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: Uint8Array<ArrayBuffer> },
) => Promise<{ status: number }>;

/** Options for {@link guardedPushFetch}. */
export interface GuardedPushFetchOptions {
  /** Forward proxy for push egress (`PUSH_PROXY`; a Bun `fetch` extension). */
  readonly proxy?: string;
  /** Name resolver for the egress check (tests). */
  readonly resolve?: Resolver;
  /** The underlying fetch (tests). Default: the global `fetch`. */
  readonly fetch?: (request: Request, init: RequestInit) => Promise<Response>;
}

/**
 * The production {@link PushFetch}. Push endpoints are supplied by browsers
 * via `/api/push/subscribe`, so each POST goes through {@link guardedFetch}
 * like any request to a host named by someone else (§8 "Outbound requests"):
 * `https` only, every resolved address public, redirects returned (never
 * followed), and one deadline covering DNS and the request.
 */
export function guardedPushFetch(opts: GuardedPushFetchOptions = {}): PushFetch {
  const underlying = opts.fetch ?? fetch;
  return async (url, init) => {
    const request = new Request(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    const res = await guardedFetch(request, {
      ...(opts.resolve ? { resolve: opts.resolve } : {}),
      fetch: (req, guardInit) => {
        // `proxy` is a Bun fetch extension; typed locally so this stays valid TS.
        const withProxy: RequestInit & { proxy?: string } = { ...guardInit };
        if (opts.proxy) withProxy.proxy = opts.proxy;
        return underlying(req, withProxy);
      },
    });
    await res.body?.cancel();
    return { status: res.status };
  };
}

/** Split a canonical actor (`handle@domain`) into its parts. */
function splitActor(actor: string): { handle: string; domain: string } | null {
  const at = actor.lastIndexOf("@");
  if (at <= 0) return null;
  return { handle: actor.slice(0, at), domain: actor.slice(at + 1) };
}

/**
 * Deliver `payload` as a real Web Push to every subscription of `recipientActor`
 * (a canonical `handle@domain`). Fire-and-forget: resolves when all attempts
 * settle, but callers should NOT await it on the hot path. Returns the number of
 * pushes accepted by a push service (mostly for tests).
 *
 * `fetchImpl` defaults to {@link guardedPushFetch}; tests inject one that returns a
 * fixed status (e.g. 410) to exercise the cleanup path without a real service.
 */
export async function sendPushToRecipient(
  db: Db,
  config: Config,
  recipientActor: string,
  payload: PushPayload,
  fetchImpl?: PushFetch,
): Promise<number> {
  try {
    const parts = splitActor(recipientActor);
    if (!parts) return 0;
    // Local recipients only — a remote actor is pushed by its home provider.
    if (canonicalAuthority(parts.domain) !== canonicalAuthority(config.domain)) return 0;

    const subs = listSubscriptions(db, parts.handle);
    if (subs.length === 0) return 0;

    const vapid = getVapidKey(db);
    const subject = `https://${canonicalAuthority(config.domain)}`;
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const doFetch: PushFetch =
      fetchImpl ?? guardedPushFetch(config.pushProxy ? { proxy: config.pushProxy } : {});

    let accepted = 0;
    await Promise.all(
      subs.map(async (sub) => {
        try {
          // §8: never send to a push host the federation policy denies, whatever
          // stored subscription names it (canonicalized by `isProviderAllowed`).
          if (!isProviderAllowed(config, new URL(sub.endpoint).host)) return;
          const req = await buildPushRequest(
            { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
            payloadBytes,
            vapid,
            subject,
          );
          const { status } = await doFetch(req.url, {
            method: "POST",
            headers: req.headers,
            body: req.body,
          });
          if (status === 404 || status === 410) {
            deleteSubscriptionByEndpoint(db, sub.endpoint);
          } else if (status >= 200 && status < 300) {
            markDelivered(db, sub.id);
            accepted += 1;
          } else {
            console.error(`web push to ${sub.endpoint} failed: status ${status}`);
          }
        } catch (err) {
          // Concise one-liner (the raw error otherwise dumps a source snippet).
          const code = (err as { code?: string })?.code ?? String(err);
          let host = sub.endpoint;
          try {
            host = new URL(sub.endpoint).host;
          } catch {
            /* keep the raw endpoint */
          }
          console.error(`web push to ${host} failed: ${code}`);
        }
      }),
    );
    return accepted;
  } catch (err) {
    console.error("sendPushToRecipient failed:", err);
    return 0;
  }
}

/** Strip newlines + clamp to `max` chars for a notification body preview. */
export function previewText(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
