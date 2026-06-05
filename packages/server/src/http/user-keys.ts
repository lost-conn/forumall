/**
 * Root-level public key discovery router (spec §4.6).
 *
 * Serves `GET /.well-known/ofscp/users/{handle}/keys`, the unauthenticated
 * endpoint remote providers use to fetch a user's **active** (non-revoked)
 * device keys for signature verification (§4.5 step 6). Like the discovery
 * document, it lives at the *root* and MUST be mounted before the SPA static
 * handler so the index.html fallback never shadows it.
 *
 * ## Unknown-handle posture: empty list + 200 (not 404)
 * We return `200` with an empty `keys` array for a handle we don't host, rather
 * than `404`. This matches the non-enumeration posture of login (§4.1.2, which
 * returns a byte-identical 401 for unknown vs wrong-password) and avoids leaking
 * which handles exist via status code. A verifier treats "no matching key" the
 * same whether the actor is unknown or simply has no active key, so an empty
 * list is the correct, information-minimal answer.
 *
 * `cache_until` is `now + config.userKeysCacheSeconds` (default 3600s, capped at
 * 1 hour, §4.7.1) so verifiers re-fetch promptly after a revocation.
 */
import { type UserKeysResponse, UserKeysResponseSchema, rfc3339Timestamp } from "@forumall/shared";
import { Hono } from "hono";

import { resolveActorKeys } from "../provider/device-keys.ts";
import type { AppBindings } from "./types.ts";

export function createUserKeysRouter() {
  const router = new Hono<AppBindings>();

  router.get("/.well-known/ofscp/users/:handle/keys", (c) => {
    const { config, db } = c.var;
    const handle = c.req.param("handle");

    // Non-revoked keys only (§4.6). Unknown handle → empty list (no enumeration).
    const keys = resolveActorKeys(db, handle).map((k) => ({
      key_id: k.keyId,
      algorithm: k.algorithm as "Ed25519",
      public_key: k.publicKey,
      created_at: rfc3339Timestamp(new Date(k.createdAt)),
    }));

    const cacheUntil = new Date(Date.now() + config.userKeysCacheSeconds * 1000);

    const body: UserKeysResponse = UserKeysResponseSchema.parse({
      actor: `${handle}@${config.domain}`,
      keys,
      cache_until: rfc3339Timestamp(cacheUntil),
    });

    return c.json(body);
  });

  return router;
}
