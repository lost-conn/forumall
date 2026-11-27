/**
 * Registration modes and account invites (§4.1.1): the advertised mode, the
 * mapping of the two registration-mode refusals (read from the problem
 * `errorCode`) to distinct messages, invite-link parsing, the request bodies
 * that carry an `inviteToken` (register and guest claim), and the
 * spent-token → login retry.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPair } from "@forumall/shared";
import { claimAccount } from "../src/lib/account-upgrade.ts";
import { register } from "../src/lib/auth.ts";
import { MemoryKeyStore } from "../src/lib/key-store.ts";
import { OfscpClient, OfscpHttpError } from "../src/lib/ofscp-client.ts";
import {
  inviteLinkFrom,
  registrationModeOf,
  registrationRefusalMessage,
  registrationRefusalOf,
} from "../src/lib/registration.ts";

const problem = (status: number, errorCode: string) =>
  new OfscpHttpError(
    status,
    { errorCode, title: errorCode, status },
    new Response(null, { status }),
  );

const discovery = (registration?: unknown) => ({
  provider: { authentication: registration === undefined ? {} : { registration } },
});

describe("registrationModeOf", () => {
  test("reads invite and closed", () => {
    expect(registrationModeOf(discovery("invite"))).toBe("invite");
    expect(registrationModeOf(discovery("closed"))).toBe("closed");
    expect(registrationModeOf(discovery("open"))).toBe("open");
  });

  test("absent or unknown means open", () => {
    expect(registrationModeOf(discovery())).toBe("open");
    expect(registrationModeOf(discovery("waitlist"))).toBe("open");
    expect(registrationModeOf({})).toBe("open");
    expect(registrationModeOf(null)).toBe("open");
  });
});

describe("registrationRefusalOf", () => {
  test("reads the two codes from a 403 problem", () => {
    expect(registrationRefusalOf(problem(403, "registration_closed"))).toBe("registration_closed");
    expect(registrationRefusalOf(problem(403, "invite_required"))).toBe("invite_required");
  });

  test("anything else is not a registration refusal", () => {
    expect(registrationRefusalOf(problem(403, "forbidden"))).toBeNull();
    expect(registrationRefusalOf(problem(400, "invite_required"))).toBeNull();
    expect(
      registrationRefusalOf(
        new OfscpHttpError(403, undefined, new Response(null, { status: 403 })),
      ),
    ).toBeNull();
    expect(registrationRefusalOf(new Error("invite_required"))).toBeNull();
  });
});

describe("registrationRefusalMessage", () => {
  const closed = problem(403, "registration_closed");
  const invite = problem(403, "invite_required");

  test("each refusal gets its own message", () => {
    const messages = new Set([
      registrationRefusalMessage(closed, { sentInvite: false }),
      registrationRefusalMessage(closed, { sentInvite: false, claiming: true }),
      registrationRefusalMessage(invite, { sentInvite: false }),
      registrationRefusalMessage(invite, { sentInvite: true }),
    ]);
    expect(messages.size).toBe(4);
    expect(messages.has(null)).toBe(false);
  });

  test("invite_required without a token asks for one; with one, says it is unusable", () => {
    expect(registrationRefusalMessage(invite, { sentInvite: false })).toContain("invite-only");
    expect(registrationRefusalMessage(invite, { sentInvite: true })).toContain("can't be used");
  });

  test("a claim refused as closed points at merging instead", () => {
    expect(registrationRefusalMessage(closed, { sentInvite: false, claiming: true })).toContain(
      "merge",
    );
  });

  test("other errors have no registration message", () => {
    expect(registrationRefusalMessage(problem(409, "conflict"), { sentInvite: false })).toBeNull();
  });
});

describe("inviteLinkFrom", () => {
  test("reads the token and canonical authority of a /register?invite= link", () => {
    expect(inviteLinkFrom(new URL("https://Chat.Example:443/register?invite=tok_1"))).toEqual({
      authority: "chat.example",
      token: "tok_1",
    });
    expect(inviteLinkFrom(new URL("http://localhost:3000/register?invite=x"))).toEqual({
      authority: "localhost:3000",
      token: "x",
    });
  });

  test("other paths, or a missing or blank token, are not invite links", () => {
    expect(inviteLinkFrom(new URL("https://a.example/invite/abc"))).toBeNull();
    expect(inviteLinkFrom(new URL("https://a.example/register"))).toBeNull();
    expect(inviteLinkFrom(new URL("https://a.example/register?invite=%20"))).toBeNull();
  });
});

type Call = { path: string; body: Record<string, unknown> };

/** A fetch stub answering by path; records each request's path and JSON body. */
function stubFetch(answers: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const raw = init?.body;
    calls.push({ path, body: typeof raw === "string" ? JSON.parse(raw) : {} });
    const answer = answers[path];
    if (!answer) throw new Error(`unexpected ${path}`);
    return answer();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown, type = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": type } });
const refusal = (errorCode: string) =>
  json(403, { errorCode, title: errorCode, status: 403 }, "application/problem+json");
const bootstrap = () => json(200, { bootstrap_token: "bt_1", expires_in: 300 });
const deviceKey = () => json(201, { key_id: "key_1" });

describe("register with an invite", () => {
  const input = { host: "a.example", handle: "alice", password: "longenough" };

  test("sends the inviteToken in the register body", async () => {
    const { calls, fetchImpl } = stubFetch({
      "/api/auth/register": bootstrap,
      "/api/auth/device-keys": deviceKey,
    });
    const res = await register({
      ...input,
      inviteToken: "tok_1",
      fetch: fetchImpl,
      keyStore: new MemoryKeyStore(),
    });
    expect(res.session.actor).toBe("alice@a.example");
    expect(calls[0]).toMatchObject({ path: "/api/auth/register", body: { inviteToken: "tok_1" } });
  });

  test("invite_required after sending a token retries as a login", async () => {
    const { calls, fetchImpl } = stubFetch({
      "/api/auth/register": () => refusal("invite_required"),
      "/api/auth/login": bootstrap,
      "/api/auth/device-keys": deviceKey,
    });
    const res = await register({
      ...input,
      inviteToken: "spent",
      fetch: fetchImpl,
      keyStore: new MemoryKeyStore(),
    });
    expect(res.session.actor).toBe("alice@a.example");
    expect(calls.map((c) => c.path)).toEqual([
      "/api/auth/register",
      "/api/auth/login",
      "/api/auth/device-keys",
    ]);
  });

  test("a failed login after invite_required surfaces the invite_required error", async () => {
    const { fetchImpl } = stubFetch({
      "/api/auth/register": () => refusal("invite_required"),
      "/api/auth/login": () => json(401, { errorCode: "unauthorized", status: 401 }),
    });
    const err = await register({ ...input, inviteToken: "bad", fetch: fetchImpl }).catch((e) => e);
    expect(registrationRefusalOf(err)).toBe("invite_required");
  });

  test("invite_required without a token does not try a login", async () => {
    const { calls, fetchImpl } = stubFetch({
      "/api/auth/register": () => refusal("invite_required"),
    });
    const err = await register({ ...input, fetch: fetchImpl }).catch((e) => e);
    expect(registrationRefusalOf(err)).toBe("invite_required");
    expect(calls.map((c) => c.path)).toEqual(["/api/auth/register"]);
  });

  test("registration_closed is never retried", async () => {
    const { calls, fetchImpl } = stubFetch({
      "/api/auth/register": () => refusal("registration_closed"),
    });
    const err = await register({ ...input, inviteToken: "t", fetch: fetchImpl }).catch((e) => e);
    expect(registrationRefusalOf(err)).toBe("registration_closed");
    expect(calls).toHaveLength(1);
  });
});

describe("claimAccount", () => {
  test("sends the inviteToken in the claim body when given", async () => {
    const { privateKey } = generateKeyPair();
    const { calls, fetchImpl } = stubFetch({
      "/api/me/claim": () => json(200, { actor: "bob@a.example", handle: "bob", keyId: "key_1" }),
    });
    const client = new OfscpClient({
      baseUrl: "https://a.example",
      actor: "guest_x@a.example",
      keyId: "key_1",
      privateKey,
      fetch: fetchImpl,
    });
    await claimAccount(client, { handle: "bob", password: "longenough", inviteToken: "tok_2" });
    await claimAccount(client, { handle: "bob", password: "longenough" });
    expect(calls[0]?.body).toEqual({ handle: "bob", password: "longenough", inviteToken: "tok_2" });
    expect(calls[1]?.body).toEqual({ handle: "bob", password: "longenough" });
  });
});
