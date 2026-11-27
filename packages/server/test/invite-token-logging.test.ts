/**
 * Invite tokens are never logged (spec §5.6, §12 "do not log tokens"). Runs the
 * invite lifecycle — create, list, the join-link page, redeem (new member,
 * existing member), guest provisioning, and the error paths (unknown token
 * `404`, exhausted `409`, guest bound elsewhere `403`, and an unexpected
 * server error, whose `500` the problem handler logs with the error) — while
 * capturing everything written through `console` or to stdout/stderr, then
 * asserts that no token, and no token digest (the stored form), appears in it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InviteCreateResponseSchema, generateKeyPair } from "@forumall/shared";

import { inviteTokenDigest } from "../src/provider/invites.ts";
import {
  type App,
  type Signer,
  createGroup,
  registerUserWithKey,
  signedRequest,
  useMembershipApp,
} from "./helpers/membership-app.ts";

const freshApp = useMembershipApp("invite-token-logging");

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/** Everything written through `console.*` or `process.{stdout,stderr}.write`. */
let captured: string[] = [];
let restore: (() => void) | undefined;

function show(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  return Bun.inspect(value);
}

beforeEach(() => {
  captured = [];
  const originals = CONSOLE_METHODS.map((m) => [m, console[m]] as const);
  for (const m of CONSOLE_METHODS) {
    console[m] = (...args: unknown[]) => {
      captured.push(args.map(show).join(" "));
    };
  }
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  const capture = (chunk: unknown): boolean => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  restore = () => {
    for (const [m, fn] of originals) console[m] = fn;
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  };
});

afterEach(() => {
  restore?.();
  restore = undefined;
});

async function createInvite(
  app: App,
  signer: Signer,
  groupId: string,
  body: Record<string, unknown>,
): Promise<{ id: string; token: string }> {
  const res = await signedRequest(app, signer, "POST", `/api/groups/${groupId}/invites`, body);
  expect(res.status).toBe(201);
  return InviteCreateResponseSchema.parse(await res.json());
}

async function provisionGuest(app: App, token: string): Promise<Signer> {
  const { publicKey, privateKey } = generateKeyPair();
  const res = await app.request(`/api/invites/${token}/guest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "dev" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { actor: string; key_id: string };
  return { actor: body.actor, keyId: body.key_id, privateKey };
}

function expectNotLogged(tokens: readonly string[]): void {
  const log = captured.join("\n");
  for (const token of tokens) {
    expect(log.includes(token)).toBe(false);
    expect(log.includes(inviteTokenDigest(token))).toBe(false);
  }
}

describe("invite tokens never reach the logs (§5.6)", () => {
  test("create, list, join-link page, redeem, guest, and 404/409/403 paths", async () => {
    const b = freshApp("lifecycle");
    const alice = await registerUserWithKey(b.app, "alice");
    const bob = await registerUserWithKey(b.app, "bob");
    const group = await createGroup(b.app, alice, { name: "G" });
    const other = await createGroup(b.app, alice, { name: "Other" });
    const single = await createInvite(b.app, alice, group.id, { maxUses: 1 });
    const guestInvite = await createInvite(b.app, alice, group.id, { grantsGuest: true });
    const otherInvite = await createInvite(b.app, alice, other.id, {});

    expect(
      (await signedRequest(b.app, alice, "GET", `/api/groups/${group.id}/invites`)).status,
    ).toBe(200);
    await b.app.request(`/invite/${single.token}`);

    const redeem = (signer: Signer, token: string) =>
      signedRequest(b.app, signer, "POST", `/api/invites/${token}/redeem`);
    expect((await redeem(bob, single.token)).status).toBe(200);
    expect((await redeem(alice, guestInvite.token)).status).toBe(200); // existing member
    expect((await redeem(alice, single.token)).status).toBe(409); // exhausted
    const unknown = `${single.token.slice(0, -4)}AAAA`;
    expect((await redeem(bob, unknown)).status).toBe(404);

    const guest = await provisionGuest(b.app, guestInvite.token);
    expect((await redeem(guest, otherInvite.token)).status).toBe(403);

    expectNotLogged([single.token, guestInvite.token, otherInvite.token, unknown]);
  });

  test("an unexpected server error during redeem is logged without the token", async () => {
    const b = freshApp("server-error");
    const alice = await registerUserWithKey(b.app, "alice");
    const bob = await registerUserWithKey(b.app, "bob");
    const group = await createGroup(b.app, alice, { name: "G" });
    const invite = await createInvite(b.app, alice, group.id, {});

    // Make the token lookup itself fail, so the problem handler logs a 500.
    b.db.sqlite.exec("DROP TABLE invites");
    const res = await signedRequest(b.app, bob, "POST", `/api/invites/${invite.token}/redeem`);
    expect(res.status).toBe(500);

    expect(captured.join("\n")).toContain("[server] Unhandled error");
    expectNotLogged([invite.token]);
  });
});
