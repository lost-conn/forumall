/**
 * Invite creation checks and token handling (spec §5.6): the `role` and
 * `channelId` `400`s, the subset-rule `403`, the bearer `token` only in the
 * `201`, its entropy, storage as a SHA-256 digest (and migration 0043, which
 * converts stored plaintext tokens), and `Referrer-Policy: no-referrer` on the
 * join-link page. Shared setup is `helpers/membership-app.ts`.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type Channel,
  type Invite,
  type InviteCreateResponse,
  InviteCreateResponseSchema,
} from "@forumall/shared";
import { sha256 } from "@noble/hashes/sha2";
import { eq } from "drizzle-orm";

import { createApp } from "../src/app.ts";
import { openDb } from "../src/db/index.ts";
import { migrate, migrations, runMigrations } from "../src/db/migrate.ts";
import { invites } from "../src/db/schema.ts";
import {
  type App,
  type Signer,
  createGroup,
  registerUserWithKey,
  seedMember,
  signedRequest,
  useMembershipApp,
} from "./helpers/membership-app.ts";

const freshApp = useMembershipApp("invite-creation");

function postInvite(app: App, signer: Signer, groupId: string, body: Record<string, unknown>) {
  return signedRequest(app, signer, "POST", `/api/groups/${groupId}/invites`, body);
}

async function createChannel(app: App, signer: Signer, groupId: string): Promise<Channel> {
  const res = await signedRequest(app, signer, "POST", `/api/groups/${groupId}/channels`, {
    name: "general",
    type: "text",
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Channel;
}

function hexSha256(token: string): string {
  return Buffer.from(sha256(new TextEncoder().encode(token))).toString("hex");
}

describe("Invite creation field checks (§5.6)", () => {
  test("`role` must be a known role other than `owner`, else 400", async () => {
    const { app } = freshApp("role-400");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, {
      name: "G",
      roles: [{ name: "admin" }, { name: "member" }, { name: "guest" }, { name: "helper" }],
    });

    for (const role of ["owner", "no-such-role"]) {
      const res = await postInvite(app, alice, group.id, { role });
      expect({ role, status: res.status }).toEqual({ role, status: 400 });
    }
    // Canonical roles and catalogue roles are accepted.
    for (const role of ["admin", "member", "guest", "helper"]) {
      const res = await postInvite(app, alice, group.id, { role });
      expect({ role, status: res.status }).toEqual({ role, status: 201 });
    }
  });

  test("`channelId` must name a channel of the group, else 400", async () => {
    const { app } = freshApp("channel-400");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G" });
    const other = await createGroup(app, alice, { name: "Other" });
    const own = await createChannel(app, alice, group.id);
    const foreign = await createChannel(app, alice, other.id);

    expect((await postInvite(app, alice, group.id, { channelId: "chn_missing" })).status).toBe(400);
    expect((await postInvite(app, alice, group.id, { channelId: foreign.id })).status).toBe(400);

    const ok = await postInvite(app, alice, group.id, { channelId: own.id });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as Invite).channelId).toBe(own.id);
  });

  test("subset rule: the creator must hold every permission of the granted role, else 403", async () => {
    const { app, db } = freshApp("subset-403");
    const alice = await registerUserWithKey(app, "alice");
    const steward = await registerUserWithKey(app, "steward");
    // `steward` may manage but not post or moderate.
    const group = await createGroup(app, alice, {
      name: "G",
      permissions: { post: ["admin", "member"], moderate: ["admin"], manage: ["admin", "steward"] },
      roles: [{ name: "admin" }, { name: "member" }, { name: "guest" }, { name: "steward" }],
    });
    seedMember(db, group.id, steward.actor, "steward");

    // `admin` holds `moderate`/`post`, which the steward lacks.
    expect((await postInvite(app, steward, group.id, { role: "admin" })).status).toBe(403);
    // An absent role grants `member`, which holds `post`: bound by the rule too.
    expect((await postInvite(app, steward, group.id, {})).status).toBe(403);
    expect((await postInvite(app, steward, group.id, { role: "member" })).status).toBe(403);
    // `guest` and `steward` hold nothing the steward lacks.
    expect((await postInvite(app, steward, group.id, { role: "guest" })).status).toBe(201);
    expect((await postInvite(app, steward, group.id, { role: "steward" })).status).toBe(201);
    // The owner holds every permission.
    expect((await postInvite(app, alice, group.id, { role: "admin" })).status).toBe(201);
  });
});

describe("Invite tokens (§5.6)", () => {
  test("the 201 alone carries a ≥128-bit token; the listing omits it", async () => {
    const { app } = freshApp("token-201");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G" });

    const tokens = new Set<string>();
    let created: InviteCreateResponse | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await postInvite(app, alice, group.id, {});
      expect(res.status).toBe(201);
      created = InviteCreateResponseSchema.parse(await res.json());
      // Opaque base64url: at least 128 bits of decoded entropy.
      expect(created.token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(created.token, "base64url").length).toBeGreaterThanOrEqual(16);
      tokens.add(created.token);
    }
    expect(tokens.size).toBe(20);

    const list = await signedRequest(app, alice, "GET", `/api/groups/${group.id}/invites`);
    expect(list.status).toBe(200);
    const { items } = (await list.json()) as { items: Invite[] };
    expect(items).toHaveLength(20);
    for (const item of items) expect(item.token).toBeUndefined();
    expect(items.map((i) => i.id)).toContain(created?.id ?? "");
  });

  test("only a SHA-256 digest of the token is stored", async () => {
    const { app, db } = freshApp("token-digest");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G" });
    const res = await postInvite(app, alice, group.id, {});
    const invite = InviteCreateResponseSchema.parse(await res.json());

    const row = db.drizzle.select().from(invites).where(eq(invites.id, invite.id)).all()[0];
    expect(row?.tokenDigest).toBe(hexSha256(invite.token));
    // The plaintext appears in no column.
    const raw = db.sqlite.query("SELECT * FROM invites WHERE id = ?").get(invite.id);
    expect(JSON.stringify(raw)).not.toContain(invite.token);
  });

  test("the join-link page is sent with `Referrer-Policy: no-referrer`", async () => {
    const { app, config } = freshApp("join-link-page");
    await Bun.write(join(config.webDir, "index.html"), "<!doctype html><title>SPA</title>");

    const res = await app.request("/invite/tok_secret");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("SPA");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("migration 0043 (invite tokens → digests)", () => {
  test("converts stored plaintext tokens, so existing links keep working", async () => {
    const { config } = freshApp("m0043-config");
    const db = openDb(join(config.dataDir, "m0043.sqlite"));
    runMigrations(
      db,
      migrations.filter((m) => m.id !== "0043_invites_token_digest"),
    );
    const app = createApp(config, { testOnlySkipReplayWarmup: true, db });
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G" });
    const token = "legacy-plaintext-token-0123456789abcdef";
    db.sqlite
      .query(
        `INSERT INTO invites (id, group_id, token, role, grants_guest, uses, created_by, created_at)
         VALUES ('inv_legacy', ?, ?, 'member', 0, 0, ?, 1)`,
      )
      .run(group.id, token, alice.actor);

    expect(migrate(db)).toEqual(["0043_invites_token_digest"]);
    const raw = db.sqlite.query("SELECT * FROM invites WHERE id = 'inv_legacy'").get();
    expect(raw).toMatchObject({ token_digest: hexSha256(token), group_id: group.id });
    expect(JSON.stringify(raw)).not.toContain(token);

    const redeem = await signedRequest(app, bob, "POST", `/api/invites/${token}/redeem`);
    expect(redeem.status).toBe(200);
    expect(await redeem.json()).toEqual({ groupId: group.id, role: "member" });
    expect(migrate(db)).toEqual([]);
    db.sqlite.close();
  });
});
