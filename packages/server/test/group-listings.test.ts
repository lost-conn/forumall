/**
 * The invite and join-request listings as §7.2 pages (spec §5.6, §5.7):
 * `GET /api/groups/{groupId}/invites` (by `createdAt`) and
 * `GET /api/groups/{groupId}/requests` (pending only, by `requestedAt`), both
 * newest first for `backward` (the default), ties broken by id. A cursor is a
 * position in that order, so it stays valid after the item at it is revoked,
 * approved or denied. Shared setup is `helpers/membership-app.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  type InvitesPage,
  InvitesPageSchema,
  type JoinRequestsPage,
  JoinRequestsPageSchema,
} from "@forumall/shared";

import { invites, joinRequests } from "../src/db/schema.ts";
import {
  type App,
  type MembershipApp,
  type Signer,
  createGroup,
  registerUserWithKey,
  signedRequest,
  useMembershipApp,
} from "./helpers/membership-app.ts";

const freshApp = useMembershipApp("group-listings");

/** A fixed base time; seeded rows sit at `BASE + offset` millis. */
const BASE = Date.UTC(2026, 0, 1);

/** Seed a pending (or other-state) join request at `BASE + at`. */
function seedRequest(
  db: MembershipApp["db"],
  groupId: string,
  id: string,
  at: number,
  state: "pending" | "approved" | "denied" = "pending",
): void {
  db.drizzle
    .insert(joinRequests)
    .values({ id, groupId, user: `${id}@providera.test`, state, requestedAt: BASE + at })
    .run();
}

/** Seed an invite created at `BASE + at`. */
function seedInvite(
  db: MembershipApp["db"],
  groupId: string,
  id: string,
  at: number,
  createdBy: string,
): void {
  db.drizzle
    .insert(invites)
    .values({ id, groupId, token: `tok-${id}`, createdBy, createdAt: BASE + at })
    .run();
}

async function getRequests(
  app: App,
  signer: Signer,
  groupId: string,
  query = "",
): Promise<JoinRequestsPage> {
  const res = await signedRequest(app, signer, "GET", `/api/groups/${groupId}/requests${query}`);
  expect(res.status).toBe(200);
  return JoinRequestsPageSchema.parse(await res.json());
}

async function getInvites(
  app: App,
  signer: Signer,
  groupId: string,
  query = "",
): Promise<InvitesPage> {
  const res = await signedRequest(app, signer, "GET", `/api/groups/${groupId}/invites${query}`);
  expect(res.status).toBe(200);
  return InvitesPageSchema.parse(await res.json());
}

/** Follow `nextCursor` from the first page, collecting every id in order. */
async function walk(
  fetchPage: (query: string) => Promise<{ items: { id: string }[]; page: { nextCursor?: string } }>,
  params: string,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const query = `?${params}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await fetchPage(query);
    ids.push(...page.items.map((i) => i.id));
    cursor = page.page.nextCursor;
  } while (cursor !== undefined);
  return ids;
}

async function requestGroup(name: string) {
  const ctx = freshApp(name);
  const owner = await registerUserWithKey(ctx.app, "owner");
  const group = await createGroup(ctx.app, owner, {
    name: "Req",
    tier: "public",
    joinPolicy: "request",
  });
  return { ...ctx, owner, group };
}

describe("GET /requests is a §7.2 page of pending requests (§5.7)", () => {
  test("newest first by requestedAt, ties by id; only pending; paging covers each once", async () => {
    const { app, db, owner, group } = await requestGroup("req-order");
    seedRequest(db, group.id, "jrq_a", 10);
    seedRequest(db, group.id, "jrq_b", 20);
    seedRequest(db, group.id, "jrq_c", 20); // ties with b → id breaks the tie
    seedRequest(db, group.id, "jrq_d", 30);
    seedRequest(db, group.id, "jrq_x", 40, "denied");
    seedRequest(db, group.id, "jrq_y", 50, "approved");

    const first = await getRequests(app, owner, group.id);
    expect(first.items.map((r) => r.id)).toEqual(["jrq_d", "jrq_c", "jrq_b", "jrq_a"]);
    expect(first.page.nextCursor).toBeUndefined();
    expect(first.page.prevCursor).toBeString();

    const fetch = (q: string) => getRequests(app, owner, group.id, q);
    expect(await walk(fetch, "limit=1")).toEqual(["jrq_d", "jrq_c", "jrq_b", "jrq_a"]);
    expect(await walk(fetch, "limit=3&direction=forward")).toEqual([
      "jrq_a",
      "jrq_b",
      "jrq_c",
      "jrq_d",
    ]);
    // An unknown direction is `backward`.
    expect(await walk(fetch, "limit=2&direction=sideways")).toEqual([
      "jrq_d",
      "jrq_c",
      "jrq_b",
      "jrq_a",
    ]);
  });

  test("prevCursor walks back the other way", async () => {
    const { app, db, owner, group } = await requestGroup("req-prev");
    for (const [id, at] of [
      ["jrq_1", 1],
      ["jrq_2", 2],
      ["jrq_3", 3],
      ["jrq_4", 4],
    ] as const) {
      seedRequest(db, group.id, id, at);
    }
    const p1 = await getRequests(app, owner, group.id, "?limit=2");
    expect(p1.items.map((r) => r.id)).toEqual(["jrq_4", "jrq_3"]);
    const p2 = await getRequests(
      app,
      owner,
      group.id,
      `?limit=2&cursor=${encodeURIComponent(p1.page.nextCursor ?? "")}`,
    );
    expect(p2.items.map((r) => r.id)).toEqual(["jrq_2", "jrq_1"]);
    const back = await getRequests(
      app,
      owner,
      group.id,
      `?limit=2&direction=forward&cursor=${encodeURIComponent(p2.page.prevCursor ?? "")}`,
    );
    expect(back.items.map((r) => r.id)).toEqual(["jrq_3", "jrq_4"]);
  });

  test("limit: default 50, clamped to 100, fractional rounded down, junk = default", async () => {
    const { app, db, owner, group } = await requestGroup("req-limit");
    for (let i = 0; i < 120; i++) {
      seedRequest(db, group.id, `jrq_${String(i).padStart(3, "0")}`, i);
    }
    expect((await getRequests(app, owner, group.id)).items).toHaveLength(50);
    const clamped = await getRequests(app, owner, group.id, "?limit=1000");
    expect(clamped.items).toHaveLength(100);
    expect(clamped.page.nextCursor).toBeString();
    expect((await getRequests(app, owner, group.id, "?limit=2.9")).items).toHaveLength(2);
    expect((await getRequests(app, owner, group.id, "?limit=-3")).items).toHaveLength(50);
    expect((await getRequests(app, owner, group.id, "?limit=abc")).items).toHaveLength(50);
  });

  test("approving or denying the item at the cursor neither skips nor repeats", async () => {
    const { app, db, owner, group } = await requestGroup("req-cursor-approve");
    for (const [id, at] of [
      ["jrq_1", 1],
      ["jrq_2", 2],
      ["jrq_3", 3],
      ["jrq_4", 4],
      ["jrq_5", 5],
    ] as const) {
      seedRequest(db, group.id, id, at);
    }
    const p1 = await getRequests(app, owner, group.id, "?limit=2");
    expect(p1.items.map((r) => r.id)).toEqual(["jrq_5", "jrq_4"]);

    // Approve the item the cursor sits at, and deny the one before it.
    const approve = await signedRequest(
      app,
      owner,
      "POST",
      `/api/groups/${group.id}/requests/jrq_4/approve`,
    );
    expect(approve.status).toBe(200);
    const deny = await signedRequest(
      app,
      owner,
      "POST",
      `/api/groups/${group.id}/requests/jrq_5/deny`,
    );
    expect(deny.status).toBe(204);

    const p2 = await getRequests(
      app,
      owner,
      group.id,
      `?limit=2&cursor=${encodeURIComponent(p1.page.nextCursor ?? "")}`,
    );
    expect(p2.items.map((r) => r.id)).toEqual(["jrq_3", "jrq_2"]);
    const p3 = await getRequests(
      app,
      owner,
      group.id,
      `?limit=2&cursor=${encodeURIComponent(p2.page.nextCursor ?? "")}`,
    );
    expect(p3.items.map((r) => r.id)).toEqual(["jrq_1"]);
    expect(p3.page.nextCursor).toBeUndefined();
  });
});

describe("GET /invites is a §7.2 page (§5.6)", () => {
  async function inviteGroup(name: string) {
    const ctx = freshApp(name);
    const owner = await registerUserWithKey(ctx.app, "owner");
    const group = await createGroup(ctx.app, owner, {
      name: "Inv",
      tier: "public",
      joinPolicy: "invite",
    });
    return { ...ctx, owner, group };
  }

  test("newest first by createdAt, ties by id; forward is oldest first", async () => {
    const { app, db, owner, group } = await inviteGroup("inv-order");
    seedInvite(db, group.id, "inv_a", 10, owner.actor);
    seedInvite(db, group.id, "inv_b", 20, owner.actor);
    seedInvite(db, group.id, "inv_c", 20, owner.actor);
    seedInvite(db, group.id, "inv_d", 30, owner.actor);

    const fetch = (q: string) => getInvites(app, owner, group.id, q);
    expect(await walk(fetch, "limit=50")).toEqual(["inv_d", "inv_c", "inv_b", "inv_a"]);
    expect(await walk(fetch, "limit=1")).toEqual(["inv_d", "inv_c", "inv_b", "inv_a"]);
    expect(await walk(fetch, "limit=3&direction=forward")).toEqual([
      "inv_a",
      "inv_b",
      "inv_c",
      "inv_d",
    ]);
  });

  test("revoking the invite at the cursor neither skips nor repeats", async () => {
    const { app, db, owner, group } = await inviteGroup("inv-cursor-revoke");
    for (const [id, at] of [
      ["inv_1", 1],
      ["inv_2", 2],
      ["inv_3", 3],
      ["inv_4", 4],
    ] as const) {
      seedInvite(db, group.id, id, at, owner.actor);
    }
    const p1 = await getInvites(app, owner, group.id, "?limit=2");
    expect(p1.items.map((i) => i.id)).toEqual(["inv_4", "inv_3"]);

    const del = await signedRequest(app, owner, "DELETE", `/api/groups/${group.id}/invites/inv_3`);
    expect(del.status).toBe(204);

    const p2 = await getInvites(
      app,
      owner,
      group.id,
      `?limit=2&cursor=${encodeURIComponent(p1.page.nextCursor ?? "")}`,
    );
    expect(p2.items.map((i) => i.id)).toEqual(["inv_2", "inv_1"]);
    expect(p2.page.nextCursor).toBeUndefined();
  });

  test("a non-manager cannot list (403)", async () => {
    const { app, group } = await inviteGroup("inv-list-auth");
    const stranger = await registerUserWithKey(app, "stranger");
    const res = await signedRequest(app, stranger, "GET", `/api/groups/${group.id}/invites`);
    expect(res.status).toBe(403);
  });
});
