/**
 * Web Push schemas (a provider-local extension — NOT in the OFSCP v0.1 object
 * model). Cover the browser's `PushSubscription` registration request, the
 * unsubscribe request, and the VAPID public-key response.
 *
 * All objects are `.passthrough()` per the §2.3 forward-compatibility convention.
 */
import { z } from "zod";

/**
 * A browser `PushSubscription`'s server-relevant fields: the push service
 * `endpoint` URL and the two base64url key materials (`p256dh` + `auth`) the
 * server encrypts to (RFC 8291).
 */
export const PushSubscribeRequestSchema = z
  .object({
    /** The push service endpoint URL the encrypted body is POSTed to. */
    endpoint: z.string().url(),
    /** The subscription's P-256 public key + auth secret (base64url). */
    keys: z
      .object({
        p256dh: z.string().min(1),
        auth: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequestSchema>;

/** The unsubscribe request: addressed by the push service `endpoint`. */
export const PushUnsubscribeRequestSchema = z
  .object({
    endpoint: z.string().url(),
  })
  .passthrough();
export type PushUnsubscribeRequest = z.infer<typeof PushUnsubscribeRequestSchema>;

/**
 * `GET /api/push/public-key` response: the provider's VAPID application-server
 * public key (base64url, uncompressed P-256), which the browser passes as
 * `applicationServerKey` when subscribing.
 */
export const PushPublicKeyResponseSchema = z
  .object({
    publicKey: z.string().min(1),
  })
  .passthrough();
export type PushPublicKeyResponse = z.infer<typeof PushPublicKeyResponseSchema>;
