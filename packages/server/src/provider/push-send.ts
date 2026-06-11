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
  /** Click-through routing data. */
  readonly data: { readonly targetUrl: string };
}

/** The minimal fetch surface, injectable so tests can simulate 410/ok. */
export type PushFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: Uint8Array },
) => Promise<{ status: number }>;

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
 * `fetchImpl` defaults to the global `fetch`; tests inject one that returns a
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
      fetchImpl ??
      (async (url, init) => {
        const res = await fetch(url, {
          method: init.method,
          headers: init.headers,
          body: init.body as BodyInit,
        });
        return { status: res.status };
      });

    let accepted = 0;
    await Promise.all(
      subs.map(async (sub) => {
        try {
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
          console.error("web push delivery error:", err);
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
