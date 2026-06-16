/**
 * Canonical local-handle validation (spec §4.1).
 *
 * The provider-scoped handle is lowercase alphanumeric plus `_`/`-`, 3–32 chars.
 * This is narrower than the shared wire `handle: string` schema (min 1) and is
 * applied at every boundary where a NEW canonical handle is minted: password
 * registration (`http/auth.ts`) and the guest → full-account claim
 * (`provider/claim.ts`). Centralized so the two paths can never drift.
 */
import { z } from "zod";

/**
 * Handle format: lowercase alphanumeric plus `_`/`-`, 3–32 chars. Narrower than
 * the shared `handle: string` schema (the wire min); applied at the boundary
 * where the canonical identifier is minted.
 */
export const HandleSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9_-]+$/, "handle must be lowercase alphanumeric, '_' or '-'");

/**
 * The reserved prefix for provider-minted guest handles (`guest_<hex>`). A
 * user-chosen handle MUST NOT start with this prefix, so a claimed full account
 * can never masquerade as a guest.
 */
export const GUEST_HANDLE_PREFIX = "guest_";
