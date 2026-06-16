/**
 * User profile / account / privacy / membership-listing routers (spec §5.1, §6).
 *
 * Three routers, all signed:
 *
 *  - {@link createMeUserRouter} (mounted at `/api/me`) — the caller-facing
 *    private endpoints: `GET /api/me` (the `UserAccount`), `PATCH /api/me/profile`
 *    (§6.3), and `GET/PUT /api/me/privacy` (§6.6).
 *  - {@link createUsersRouter} (mounted at `/api/users`) — the viewer-facing
 *    reads of another user, filtered by the subject's privacy policy:
 *    `GET /api/users/{userRef}/profile` (§6.2) and
 *    `GET /api/users/{userRef}/groups` (§6.5).
 *
 * ## Visibility filtering
 * The base `UserProfile` (id/handle/domain/displayName/avatar) is returned to any
 * authenticated caller; the profile **extra** `bio` is gated through the shared
 * resolver ({@link canView}) using the subject's `profileVisibility`. The group
 * listing is gated as a whole using `membershipVisibility`: when the viewer is
 * not permitted, an empty list is returned (never a 403) so a viewer cannot
 * distinguish "no groups" from "hidden". The subject viewing themselves always
 * sees everything (self-visibility is handled inside {@link canView}).
 *
 * Private account fields (password hash, recovery email, raw stored settings)
 * never appear in any response here.
 */
import {
  PresenceUpdateRequestSchema,
  PrivacySettingsSchema,
  PrivacySettingsUpdateRequestSchema,
  UserAccountSchema,
  UserGroupsResponseSchema,
  UserPublicProfileResponseSchema,
  UserUpdateProfileRequestSchema,
  canonicalAuthority,
} from "@forumall/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";

import { isProviderAdmin } from "../provider/admin.ts";
import { claimGuestAccount } from "../provider/claim.ts";
import { buildUserProfile, getUserRow, updateUserProfile } from "../provider/guests.ts";
import { groupIdsOf } from "../provider/membership.ts";
import { mergeGuestIntoAccount } from "../provider/merge.ts";
import {
  type ExplicitAvailability,
  fanOutPresence,
  filterPresenceFor,
  setExplicitPresence,
  toPresence,
} from "../provider/presence.ts";
import { getPrivacySettings, updatePrivacySettings } from "../provider/privacy.ts";
import { canView } from "../provider/visibility.ts";
import { AppError } from "./errors.ts";
import { requireSignature } from "./signature.ts";
import type { AppBindings, AuthenticatedActor } from "./types.ts";

/**
 * `POST /api/me/claim` body: the guest's chosen new handle + password (+ optional
 * display name). The handle is min-validated here and fully validated (format,
 * reserved prefix, availability) inside {@link claimGuestAccount}; the password
 * mirrors the §4.1 register minimum (`min(8)`).
 */
const ClaimRequestSchema = z
  .object({
    handle: z.string().min(1),
    password: z.string().min(8),
    displayName: z.string().optional(),
  })
  .strict();

/**
 * `POST /api/me/merge` body: the EXISTING target account's handle + password
 * (a login-equivalent credential check). The merge folds the calling guest's
 * content/identity into that account; see {@link mergeGuestIntoAccount}.
 */
const MergeRequestSchema = z
  .object({
    handle: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

/** Read a path param guaranteed present by the mounted route. */
function requireParam(c: Context<AppBindings>, name: string): string {
  return decodeURIComponent(c.req.param(name) ?? "");
}

/**
 * Resolve a `userRef` (a path param: `handle`, `handle@domain`, or the canonical
 * HTTPS URI `https://{domain}/api/users/{handle}`) to a LOCAL handle, or `null`
 * if it is not a local user of this provider.
 */
function localHandleOfRef(c: Context<AppBindings>, ref: string): string | null {
  const { config, db } = c.var;
  const host = canonicalAuthority(config.domain);

  let handle = ref;
  if (ref.startsWith("https://")) {
    // https://{domain}/api/users/{handle}
    try {
      const u = new URL(ref);
      if (canonicalAuthority(u.host) !== host) return null;
      const m = u.pathname.match(/\/api\/users\/([^/]+)$/);
      if (!m) return null;
      handle = decodeURIComponent(m[1] as string);
    } catch {
      return null;
    }
  } else {
    const at = ref.lastIndexOf("@");
    if (at > 0 && at < ref.length - 1) {
      if (canonicalAuthority(ref.slice(at + 1)) !== host) return null; // foreign domain
      handle = ref.slice(0, at);
    }
    // else: bare handle — treat as local.
  }

  return getUserRow(db, handle) ? handle : null;
}

/** The viewer shape {@link canView} expects, from the authenticated actor. */
function viewerOf(actor: AuthenticatedActor | undefined) {
  return actor ? { actor: actor.actor, handle: actor.handle, domain: actor.domain } : null;
}

/**
 * The caller-facing private router: `GET /api/me`, `PATCH /api/me/profile`,
 * `GET /api/me/privacy`, `PUT /api/me/privacy`. Mounted at `/api/me`.
 */
export function createMeUserRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  // -- GET /api/me (§5.1.2 — signed) --------------------------------------
  // The caller's private `UserAccount` = { profile, settings }. Never exposes
  // another user's fields; settings is a minimal placeholder bag. The
  // `isAdmin` field (Forumall extension, via UserAccountSchema's passthrough) is
  // attached ONLY on this self view — never on another user's public profile.
  router.get("/", signed, (c) => {
    const { config, db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const profile = buildUserProfile(db, canonicalAuthority(config.domain), actor.handle);
    if (!profile) throw AppError.notFound({ detail: "no such user" });

    const account = UserAccountSchema.parse({
      profile,
      settings: {},
      isAdmin: isProviderAdmin(db, config, actor.handle),
    });
    return c.json(account, 200);
  });

  // -- POST /api/me/claim (guest → full account, signed) ------------------
  // A signed-in GUEST upgrades to a full account by choosing a new permanent
  // handle + setting a password. This is a full identity rename across every
  // table that embeds the actor (`provider/claim.ts`); the caller keeps the
  // SAME device keypair + keyId, which now resolves to the new actor. Returns
  // `{ actor, keyId, profile }`. 409 if already a full account / handle taken;
  // 400 on an invalid or reserved handle.
  router.post("/claim", signed, async (c) => {
    const { config, db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = ClaimRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid claim request",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    const result = claimGuestAccount(db, config, actor.handle, {
      newHandle: parsed.data.handle,
      password: parsed.data.password,
      ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
    });

    const profile = buildUserProfile(db, canonicalAuthority(config.domain), result.handle);
    if (!profile) throw AppError.notFound({ detail: "no such user" });

    return c.json({ actor: result.actor, keyId: actor.keyId, profile }, 200);
  });

  // -- POST /api/me/merge (guest → EXISTING account, signed) --------------
  // A signed-in GUEST folds itself into an EXISTING full account by supplying
  // that account's handle + password (a login-equivalent credential check). All
  // of the guest's content/identity moves into the target actor with conflict
  // resolution (`provider/merge.ts`), the caller's device key is re-bound to the
  // target (so this device stays logged in — now as the target, SAME keyId), and
  // the guest row is deleted. Returns `{ actor, keyId, profile }` (the target's).
  // 401 on a bad handle/password (uniform, no enumeration); 409 if the caller is
  // already a full account.
  router.post("/merge", signed, async (c) => {
    const { config, db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = MergeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid merge request",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    const result = mergeGuestIntoAccount(db, config, actor.handle, {
      targetHandle: parsed.data.handle,
      password: parsed.data.password,
    });

    const profile = buildUserProfile(db, canonicalAuthority(config.domain), result.handle);
    if (!profile) throw AppError.notFound({ detail: "no such user" });

    return c.json({ actor: result.actor, keyId: actor.keyId, profile }, 200);
  });

  // -- PATCH /api/me/profile (§6.3 — signed) ------------------------------
  // Update displayName / avatar / bio / metadata; bump updatedAt; return the
  // updated public profile (with the caller's own bio, since self is visible).
  router.patch("/profile", signed, async (c) => {
    const { config, db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    if (!getUserRow(db, actor.handle)) throw AppError.notFound({ detail: "no such user" });

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = UserUpdateProfileRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid profile update request",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    updateUserProfile(db, actor.handle, parsed.data);

    const host = canonicalAuthority(config.domain);
    const profile = buildUserProfile(db, host, actor.handle);
    if (!profile) throw AppError.notFound({ detail: "no such user" });
    const row = getUserRow(db, actor.handle);
    // Self always sees their own bio.
    return c.json(
      UserPublicProfileResponseSchema.parse({
        ...profile,
        ...(row?.bio != null ? { bio: row.bio } : {}),
      }),
      200,
    );
  });

  // -- GET /api/me/privacy (§6.6 — signed) --------------------------------
  router.get("/privacy", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const settings = getPrivacySettings(db, actor.handle);
    return c.json(
      PrivacySettingsSchema.parse({
        presenceVisibility: settings.presenceVisibility,
        profileVisibility: settings.profileVisibility,
        membershipVisibility: settings.membershipVisibility,
        allowList: settings.allowList,
        denyList: settings.denyList,
        metadata: [],
      }),
      200,
    );
  });

  // -- PUT /api/me/privacy (§6.6 — signed) --------------------------------
  router.put("/privacy", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = PrivacySettingsUpdateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid privacy update request",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    // `allowList` / `denyList` are not in the shared update schema (passthrough
    // keeps them), so read them off the raw body when present.
    const body = raw as Record<string, unknown>;
    const allowList = Array.isArray(body.allowList)
      ? (body.allowList.filter((x) => typeof x === "string") as string[])
      : undefined;
    const denyList = Array.isArray(body.denyList)
      ? (body.denyList.filter((x) => typeof x === "string") as string[])
      : undefined;

    const settings = updatePrivacySettings(db, actor.handle, {
      ...(parsed.data.presenceVisibility !== undefined
        ? { presenceVisibility: parsed.data.presenceVisibility }
        : {}),
      ...(parsed.data.profileVisibility !== undefined
        ? { profileVisibility: parsed.data.profileVisibility }
        : {}),
      ...(parsed.data.membershipVisibility !== undefined
        ? { membershipVisibility: parsed.data.membershipVisibility }
        : {}),
      ...(allowList !== undefined ? { allowList } : {}),
      ...(denyList !== undefined ? { denyList } : {}),
    });

    return c.json(
      PrivacySettingsSchema.parse({
        presenceVisibility: settings.presenceVisibility,
        profileVisibility: settings.profileVisibility,
        membershipVisibility: settings.membershipVisibility,
        allowList: settings.allowList,
        denyList: settings.denyList,
        metadata: [],
      }),
      200,
    );
  });

  // -- PUT /api/me/presence (§6.4 — signed) -------------------------------
  // Equivalent to the WS `presence.set` (§7.5): update the caller's stored
  // EXPLICIT availability/status (the request body's enum rejects `offline`) and
  // fan out a privacy-filtered `presence.update` to subscribers over the shared
  // registry. The response echoes the caller's own (self-visible) presence.
  router.put("/presence", signed, async (c) => {
    const { config, db, hub, presenceRegistry } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    if (!getUserRow(db, actor.handle)) throw AppError.notFound({ detail: "no such user" });

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = PresenceUpdateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid presence update request",
        extensions: { errors: parsed.error.flatten() },
      });
    }
    // `offline` is connection-derived, never a settable value (§6.4/§7.5). The
    // shared Presence schema permits it (it is the read shape), so reject here.
    if (parsed.data.availability === "offline") {
      throw AppError.badRequest({ detail: "`offline` is not a settable availability" });
    }

    setExplicitPresence(
      db,
      actor.handle,
      parsed.data.availability as ExplicitAvailability,
      parsed.data.status ?? undefined,
    );
    fanOutPresence(db, hub, config, presenceRegistry, actor.handle);

    // The caller always sees their own real presence (self-visibility).
    const eff = filterPresenceFor(db, hub, config, actor.handle, {
      actor: actor.actor,
      handle: actor.handle,
      domain: actor.domain,
    });
    return c.json(toPresence(eff), 200);
  });

  return router;
}

/**
 * The viewer-facing router: `GET /api/users/{userRef}/profile` (§6.2) and
 * `GET /api/users/{userRef}/groups` (§6.5). Mounted at `/api/users`.
 */
export function createUsersRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  // -- GET /api/users/{userRef}/profile (§6.2 — signed) -------------------
  // The base UserProfile is visible to any authenticated caller; `bio` is gated
  // on the subject's profileVisibility. 404 if no such local user.
  router.get("/:userRef/profile", signed, (c) => {
    const { config, db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const host = canonicalAuthority(config.domain);
    const subjectHandle = localHandleOfRef(c, requireParam(c, "userRef"));
    if (!subjectHandle) throw AppError.notFound({ detail: "no such user" });

    const profile = buildUserProfile(db, host, subjectHandle);
    if (!profile) throw AppError.notFound({ detail: "no such user" });

    const settings = getPrivacySettings(db, subjectHandle);
    const row = getUserRow(db, subjectHandle);

    // Gate the `bio` extra on profileVisibility; the base profile is always
    // returned to the authenticated caller.
    const bioVisible =
      row?.bio != null &&
      canView(db, {
        subjectHandle,
        subjectDomain: host,
        viewerActor: viewerOf(actor),
        policy: settings.profileVisibility,
        allowList: settings.allowList,
        denyList: settings.denyList,
      });

    return c.json(
      UserPublicProfileResponseSchema.parse({
        ...profile,
        ...(bioVisible ? { bio: row?.bio } : {}),
      }),
      200,
    );
  });

  // -- GET /api/users/{userRef}/groups (§6.5 — signed) --------------------
  // Only the subject's groups visible to the viewer per membershipVisibility.
  // Not permitted → empty list (never a 403), so the viewer can't distinguish
  // "no groups" from "hidden". Permitted → the subject's group memberships as
  // `{ id }` HTTPS-URI refs.
  router.get("/:userRef/groups", signed, (c) => {
    const { config, db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const host = canonicalAuthority(config.domain);
    const subjectHandle = localHandleOfRef(c, requireParam(c, "userRef"));
    if (!subjectHandle) throw AppError.notFound({ detail: "no such user" });

    const settings = getPrivacySettings(db, subjectHandle);
    const allowed = canView(db, {
      subjectHandle,
      subjectDomain: host,
      viewerActor: viewerOf(actor),
      policy: settings.membershipVisibility,
      allowList: settings.allowList,
      denyList: settings.denyList,
    });

    const subjectActor = `${subjectHandle}@${host}`;
    const ids = allowed ? [...groupIdsOf(db, subjectActor)] : [];
    return c.json(
      UserGroupsResponseSchema.parse({
        groups: ids.map((id) => ({ id: `https://${host}/api/groups/${id}` })),
        metadata: [],
      }),
      200,
    );
  });

  // -- GET /api/users/{userRef}/presence (§6.4 — signed) ------------------
  // The subject's presence, filtered for the caller EXACTLY as the WS fan-out /
  // snapshot would be (same `canView` + effective-state derivation, §7.5): a
  // viewer not permitted by the subject's `presenceVisibility` gets a uniform
  // `offline` (no status/lastSeen); a permitted viewer gets the real effective
  // presence (offline if the subject has no live WS connection). 404 if no such
  // local user.
  router.get("/:userRef/presence", signed, (c) => {
    const { config, db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const subjectHandle = localHandleOfRef(c, requireParam(c, "userRef"));
    if (!subjectHandle) throw AppError.notFound({ detail: "no such user" });

    const eff = filterPresenceFor(db, hub, config, subjectHandle, viewerOf(actor));
    return c.json(toPresence(eff), 200);
  });

  return router;
}
