/**
 * Follows migrations on existing data:
 *  - 0043 drops the client-supplied `group_id` column (§7.6: the `Follow`
 *    `groupId` is derived from the channel), keeping every row and the index;
 *  - 0044 rewrites legacy channel refs to the one stored spelling (§2.2): this
 *    provider's own channel URI → the bare id (folding duplicates into the
 *    earliest follow), a remote URI's query/fragment stripped, and refs that
 *    name no object (remote `http://`, non-channel local URIs) deleted. It
 *    defers without a configured DOMAIN.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Db, openDb } from "../src/db/index.ts";
import { migrate, migrations, runMigrations } from "../src/db/migrate.ts";

const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-follows-migrations-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A database migrated up to (not including) migration `id` and later ones. */
function dbBefore(name: string, id: string): Db {
  const db = openDb(join(tmp, `${name}.sqlite`));
  const at = migrations.findIndex((m) => m.id === id);
  expect(at).toBeGreaterThan(0);
  runMigrations(db, migrations.slice(0, at));
  return db;
}

interface Row {
  owner: string;
  channel: string;
  created_at: number;
  metadata: string;
}

function followRows(db: Db): Row[] {
  return db.sqlite
    .query<Row, []>(
      "SELECT owner, channel, created_at, metadata FROM follows ORDER BY owner, channel",
    )
    .all();
}

describe("migration 0043_follows_drop_group_id", () => {
  test("drops group_id, keeping every row and the owner index", () => {
    const id = "0043_follows_drop_group_id";
    const db = dbBefore("m0043", id);
    db.sqlite.exec(`
      INSERT INTO follows (owner, channel, group_id, created_at, metadata) VALUES
        ('alice', 'chn_a', 'grp_evil', 10, '[]'),
        ('alice', 'https://remote.example/api/groups/grp_x/channels/chn_b', NULL, 20, '[]'),
        ('bob', 'chn_a', 'grp_a', 30, '[]');
    `);
    expect(
      runMigrations(db, migrations.slice(0, migrations.findIndex((m) => m.id === id) + 1)),
    ).toEqual([id]);

    const cols = db.sqlite
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('follows') ORDER BY cid")
      .all()
      .map((c) => c.name);
    expect(cols).toEqual(["owner", "channel", "created_at", "metadata"]);
    expect(followRows(db)).toEqual([
      { owner: "alice", channel: "chn_a", created_at: 10, metadata: "[]" },
      {
        owner: "alice",
        channel: "https://remote.example/api/groups/grp_x/channels/chn_b",
        created_at: 20,
        metadata: "[]",
      },
      { owner: "bob", channel: "chn_a", created_at: 30, metadata: "[]" },
    ]);
    const indexes = db.sqlite
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'follows' AND sql IS NOT NULL",
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual(["idx_follows_owner"]);
  });
});

describe("migration 0044_follows_canonical_channel_refs", () => {
  const id = "0044_follows_canonical_channel_refs";
  const local = (g: string, c: string) => `https://${DOMAIN}/api/groups/${g}/channels/${c}`;
  const remote = "https://remote.example/api/groups/grp_x/channels/chn_r";

  function seed(db: Db): void {
    const insert = db.sqlite.prepare(
      "INSERT INTO follows (owner, channel, created_at, metadata) VALUES (?, ?, ?, '[]')",
    );
    // alice: chn_a by id (later) and by URI (earlier) → one follow at 5.
    insert.run("alice", "chn_a", 50);
    insert.run("alice", local("grp_1", "chn_a"), 5);
    // alice: chn_b only by an http:// own URI with a query → chn_b.
    insert.run("alice", `http://${DOMAIN}/api/groups/grp_1/channels/chn_b?x=1`, 60);
    // alice: a remote URI with a fragment and without → one follow at 7.
    insert.run("alice", remote, 70);
    insert.run("alice", `${remote}#top`, 7);
    // alice: refs naming no followable object → deleted.
    insert.run("alice", "http://remote.example/api/groups/grp_x/channels/chn_r", 80);
    insert.run("alice", `https://${DOMAIN}/api/users/alice`, 90);
    // bob: chn_a by its URI → chn_a (another owner, no fold with alice).
    insert.run("bob", local("grp_1", "chn_a"), 100);
  }

  test("rewrites own URIs to bare ids, strips query/fragment, folds into the earliest, deletes non-objects", () => {
    const db = dbBefore("m0044", id);
    seed(db);
    const log: string[] = [];
    expect(migrate(db, { domain: DOMAIN, log: (l) => log.push(l) })).toEqual([id]);

    expect(followRows(db)).toEqual([
      { owner: "alice", channel: "chn_a", created_at: 5, metadata: "[]" },
      { owner: "alice", channel: "chn_b", created_at: 60, metadata: "[]" },
      { owner: "alice", channel: remote, created_at: 7, metadata: "[]" },
      { owner: "bob", channel: "chn_a", created_at: 100, metadata: "[]" },
    ]);
    expect(log).toEqual([
      "0044: follows — 2 channel ref(s) rewritten, 2 folded into an existing follow, 2 non-object ref(s) deleted",
    ]);
  });

  test("defers without a configured DOMAIN, leaving rows untouched; runs once it is set", () => {
    const db = dbBefore("m0044-deferred", id);
    seed(db);
    const before = followRows(db);
    const deferred: string[] = [];
    expect(migrate(db, { onDeferred: (m) => deferred.push(m) })).toEqual([]);
    expect(deferred).toEqual([id]);
    expect(followRows(db)).toEqual(before);

    expect(migrate(db, { domain: DOMAIN, log: () => {} })).toEqual([id]);
    expect(followRows(db).map((r) => r.channel)).toEqual(["chn_a", "chn_b", remote, "chn_a"]);
  });

  test("with only bare ids it needs no DOMAIN and changes nothing", () => {
    const db = dbBefore("m0044-bare", id);
    db.sqlite.exec(
      "INSERT INTO follows (owner, channel, created_at, metadata) VALUES ('alice', 'chn_a', 1, '[]')",
    );
    expect(migrate(db)).toEqual([id]);
    expect(followRows(db)).toEqual([
      { owner: "alice", channel: "chn_a", created_at: 1, metadata: "[]" },
    ]);
  });
});
