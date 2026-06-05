/**
 * @forumall/shared — OFSCP protocol primitives shared by provider and client.
 *
 * P1: request signing + verification (canonical string, content digest,
 * sign/verify, provider-signed variant), dmId derivation, and the Zod schemas
 * mirroring the OFSCP v0.1 object model (`./schemas`).
 */
export const OFSCP_VERSION = "0.1.0" as const;

export * from "./dm.ts";
export * from "./signing.ts";
export * from "./ws-auth.ts";
export * from "./schemas/index.ts";
