/**
 * Provider discovery document (spec §3.1) builder.
 *
 * Assembles the `.well-known/ofscp-provider` body from config + the persisted
 * provider signing key. The result MUST validate against
 * `ProviderDiscoverySchema` from `@forumall/shared`. The private key is never
 * referenced here — only `toPublicKey()` material is published.
 */
import { OFSCP_VERSION, type ProviderDiscovery, rfc3339Timestamp } from "@forumall/shared";

import packageJson from "../../package.json" with { type: "json" };
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { getProviderSigningKey, toPublicKey } from "./signing-key.ts";
import { TIER_IDS } from "./tiers.ts";

/** Build an absolute `https://{domain}{path}` URL for discovery endpoints. */
function absoluteUrl(domain: string, path: string): string {
  return `https://${domain}${path}`;
}

/**
 * Build the discovery document for this provider. Reads (and lazily generates)
 * the persisted provider signing key, publishing only its public half (§8.1).
 */
export function buildDiscoveryDocument(config: Config, db: Db): ProviderDiscovery {
  const signingKey = getProviderSigningKey(db);
  const pub = toPublicKey(signingKey);

  const doc: ProviderDiscovery = {
    provider: {
      domain: config.domain,
      protocolVersion: OFSCP_VERSION,
      software: {
        name: "forumall",
        version: packageJson.version,
      },
      authentication: {
        login_endpoint: absoluteUrl(config.domain, "/api/auth/login"),
        registration_endpoint: absoluteUrl(config.domain, "/api/auth/register"),
      },
      publicKeys: [
        {
          key_id: pub.keyId,
          algorithm: "Ed25519",
          public_key: pub.publicKey,
          created_at: rfc3339Timestamp(new Date(pub.createdAt)),
        },
      ],
      // `contact` is required by the discovery schema (§3.1). Use the
      // configured value, else derive a sensible non-empty default from the
      // domain (port stripped) so operators get a working discovery doc with
      // zero config and we never advertise an empty contact.
      contact: config.contact ?? `mailto:admin@${config.domain.split(":")[0]}`,
    },
    capabilities: {
      messageTypes: ["memo", "article", "message", "reaction"],
      tiers: [...TIER_IDS],
      limits: {
        maxUploadBytes: config.maxUploadBytes,
      },
      federation: {
        realtimeDelivery: "direct-ws",
      },
      discovery: {
        // Reflect the optional-feature toggles (§8.6, §11.2). Default config
        // leaves both OFF → both advertised `false` (and the endpoints 404).
        sharesKnownProviders: config.enableKnownProviders,
        discoverFeed: config.enableDiscoverFeed,
      },
    },
  };

  return doc;
}

/**
 * A weak ETag derived from the document content. Stable for a given body so
 * conditional requests can short-circuit; changes if the key or config change.
 */
export function discoveryETag(doc: ProviderDiscovery): string {
  const json = JSON.stringify(doc);
  const hash = Bun.hash(json).toString(16);
  return `W/"${hash}"`;
}
