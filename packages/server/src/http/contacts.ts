/**
 * Contacts routers (spec §6.7).
 *
 * The explicit, mutually-consented relationship that backs the `contacts`
 * visibility tier (§6.1). Two routers, both signed:
 *
 *  - {@link createMeContactsRouter} (mounted at `/api/me`) — the caller-facing
 *    request / accept / remove / list endpoints.
 *  - {@link createFederationContactsRouter} (mounted at `/api/federation/contacts`)
 *    — the cross-provider receiver: a user-signed `{ action, from, to }` event
 *    that converges the LOCAL `to` user's side of a relationship.
 *
 * ## Local vs. remote mirroring (§6.7)
 * A `Contact` row is held from a LOCAL owner's perspective. For a fully-LOCAL
 * pair both sides live here, so request / accept / remove update BOTH rows
 * directly. For a remote counterparty only the caller's local row is touched;
 * the acting client mirrors the change to the counterparty's provider via the
 * federation endpoint (P8 drives that delivery — here we just create the local
 * side + leave it deliverable, and implement the receiver for the reverse path).
 *
 * ## Federation receiver auth (§6.7)
 * The receiver authenticates the signer as `from` (the §4.5 middleware already
 * verified the signature against `from`'s key) and rejects **403** if the signed
 * actor ≠ the body `from`. It confirms `to` is a LOCAL user (**404** otherwise),
 * then applies the action to `to`'s row (`user = from`). Real remote key
 * resolution for `from` is P7; the test simulates the remote signer with a
 * locally-registered key.
 */
import {
  type Contact,
  ContactCreateRequestSchema,
  ContactEventSchema,
  ContactsResponseSchema,
  canonicalAuthority,
} from "@forumall/shared";
import { type Context, Hono } from "hono";

import {
  acceptContact,
  getContactRow,
  listContacts,
  removeContact,
  upsertContact,
} from "../provider/contacts.ts";
import { getUserRow } from "../provider/guests.ts";
import { AppError } from "./errors.ts";
import { requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Read a path param guaranteed present by the mounted route. */
function requireParam(c: Context<AppBindings>, name: string): string {
  return c.req.param(name) ?? "";
}

/**
 * If `actor` (`handle@domain`) is a LOCAL user of this provider, return its
 * handle; otherwise `null` (malformed actor, foreign domain, or unknown handle).
 */
function localHandleOf(c: Context<AppBindings>, actor: string): string | null {
  const { config, db } = c.var;
  const at = actor.lastIndexOf("@");
  if (at <= 0 || at === actor.length - 1) return null;
  const handle = actor.slice(0, at);
  const domain = canonicalAuthority(actor.slice(at + 1));
  if (domain !== canonicalAuthority(config.domain)) return null;
  return getUserRow(db, handle) ? handle : null;
}

/**
 * The caller-facing contacts router: `POST /contacts`, `POST /contacts/{userRef}/accept`,
 * `DELETE /contacts/{userRef}`, `GET /contacts`. Mounted at `/api/me`.
 */
export function createMeContactsRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  // -- POST /contacts (§6.7 — signed) -------------------------------------
  // Record an outgoing pending entry for the caller. If the counterparty is a
  // LOCAL user, also record their mirror incoming pending entry directly.
  router.post("/contacts", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const body = ContactCreateRequestSchema.parse(await c.req.json());
    const other = body.user;
    if (other === actor.actor) {
      throw AppError.badRequest({ detail: "cannot add yourself as a contact" });
    }

    const contact = upsertContact(db, actor.handle, other, "pending", "outgoing");

    // Local counterparty → mirror the incoming pending row on their side. A
    // remote counterparty's side is mirrored by the client (P8) via the
    // federation endpoint; here we leave only the caller's deliverable row.
    const otherHandle = localHandleOf(c, other);
    if (otherHandle !== null) {
      upsertContact(db, otherHandle, actor.actor, "pending", "incoming");
    }

    return c.json(contact, 201);
  });

  // -- POST /contacts/{userRef}/accept (§6.7 — signed) --------------------
  // Promote the caller's incoming pending entry to accepted. If the
  // counterparty is local, flip their outgoing row to accepted too.
  router.post("/contacts/:userRef/accept", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const other = decodeURIComponent(requireParam(c, "userRef"));

    const row = getContactRow(db, actor.handle, other);
    if (!row || row.state !== "pending" || row.direction !== "incoming") {
      throw AppError.notFound({ detail: "no incoming pending contact request from this user" });
    }

    const contact = acceptContact(db, actor.handle, other);

    const otherHandle = localHandleOf(c, other);
    if (otherHandle !== null) {
      // Flip their mirror row (user = this caller) to accepted as well.
      const mirror = getContactRow(db, otherHandle, actor.actor);
      if (mirror) acceptContact(db, otherHandle, actor.actor);
    }

    return c.json(contact, 200);
  });

  // -- DELETE /contacts/{userRef} (§6.7 — signed) -------------------------
  // Cancel an outgoing request, decline an incoming one, or remove an
  // established contact — removes the caller's row; if the counterparty is
  // local, remove their mirror too.
  router.delete("/contacts/:userRef", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const other = decodeURIComponent(requireParam(c, "userRef"));

    removeContact(db, actor.handle, other);

    const otherHandle = localHandleOf(c, other);
    if (otherHandle !== null) {
      removeContact(db, otherHandle, actor.actor);
    }

    return c.body(null, 204);
  });

  // -- GET /contacts (§6.7 — signed) --------------------------------------
  // List the caller's contacts, including outstanding pending in both
  // directions.
  router.get("/contacts", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const items: Contact[] = listContacts(db, actor.handle);
    return c.json(ContactsResponseSchema.parse({ contacts: items, metadata: [] }));
  });

  return router;
}

/**
 * The federation receiver: `POST /api/federation/contacts`. Mounted at
 * `/api/federation/contacts`. User-signed by `from`.
 */
export function createFederationContactsRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  router.post("/", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const body = ContactEventSchema.parse(await c.req.json());

    // The signer MUST be `from` (§6.7). The §4.5 middleware verified the
    // signature against the actor's key; here we bind that identity to the body.
    if (actor.actor !== body.from) {
      throw AppError.forbidden({ detail: "the request signer must equal `from`" });
    }

    // `to` MUST be a LOCAL user of this provider.
    const toHandle = localHandleOf(c, body.to);
    if (toHandle === null) {
      throw AppError.notFound({ detail: "`to` is not a local user of this provider" });
    }

    // Apply the action to `to`'s row (user = from).
    switch (body.action) {
      case "request": {
        const contact = upsertContact(db, toHandle, body.from, "pending", "incoming");
        return c.json(contact, 200);
      }
      case "accept": {
        const row = getContactRow(db, toHandle, body.from);
        if (!row) {
          throw AppError.notFound({ detail: "no contact row to accept for this user" });
        }
        const contact = acceptContact(db, toHandle, body.from);
        return c.json(contact, 200);
      }
      case "remove": {
        removeContact(db, toHandle, body.from);
        return c.body(null, 204);
      }
      default: {
        // Unreachable: ContactEventSchema constrains `action`.
        throw AppError.badRequest({ detail: "unknown contact action" });
      }
    }
  });

  return router;
}
