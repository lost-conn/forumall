/**
 * Root-level public key discovery router (spec §4.6).
 *
 * Serves `GET /.well-known/ofscp/users/{handle}/keys`, the unauthenticated
 * endpoint remote providers use to fetch a user's **active** (non-revoked)
 * device keys for signature verification (§4.5 step 6). Like the discovery
 * document, it lives at the *root* and MUST be mounted before the SPA static
 * handler so the index.html fallback never shadows it.
 *
 * ## Unknown-handle posture: empty list + 200; invalid handle: 404
 * For a syntactically valid handle (§2.2.1) we answer `200` with an empty `keys`
 * array whether the handle is unknown or simply has no active key, with every
 * field (`actor`, `cache_until`) computed the same way, so the endpoint cannot
 * enumerate accounts (§4.6; compare login, §4.1.2). A handle that is not
 * syntactically valid (uppercase, `@`, whitespace, too short/long, …) names no
 * possible account and gets `404` `not_found` (§4.6, ofscp#31): there is no
 * canonical actor to put in an empty body, and the handle is never rewritten.
 *
 * `cache_until` is `now + config.userKeysCacheSeconds` (default 3600s, capped at
 * 1 hour, §4.7.1) so verifiers re-fetch promptly after a revocation.
 */
import {
  type UserKeysResponse,
  UserKeysResponseSchema,
  canonicalAuthority,
  rfc3339Timestamp,
} from "@forumall/shared";
import { Hono } from "hono";

import { resolveActorKeys } from "../provider/device-keys.ts";
import { HandleSchema } from "../provider/handle.ts";
import { AppError } from "./errors.ts";
import { optionalActorOrProviderSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

export function createUserKeysRouter() {
  const router = new Hono<AppBindings>();

  // Signed requests still run §4.5 so the §8 inbound policy applies (403).
  router.get("/.well-known/ofscp/users/:handle/keys", optionalActorOrProviderSignature(), (c) => {
    const { config, db } = c.var;
    // Hono has already percent-decoded the segment once (§2.2: exactly once).
    const handle = c.req.param("handle");
    if (!HandleSchema.safeParse(handle).success) {
      throw AppError.notFound({ detail: "no such handle" });
    }

    // Non-revoked keys only (§4.6). Unknown handle → empty list (no enumeration).
    const keys = resolveActorKeys(db, handle).map((k) => ({
      key_id: k.keyId,
      algorithm: k.algorithm,
      public_key: k.publicKey,
      created_at: rfc3339Timestamp(new Date(k.createdAt)),
    }));

    const cacheUntil = new Date(Date.now() + config.userKeysCacheSeconds * 1000);

    const body: UserKeysResponse = UserKeysResponseSchema.parse({
      actor: `${handle}@${canonicalAuthority(config.domain)}`,
      keys,
      cache_until: rfc3339Timestamp(cacheUntil),
    });

    return c.json(body);
  });

  return router;
}
