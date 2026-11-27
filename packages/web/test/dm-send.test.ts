/** DM send (`dm-send.ts`): one idempotency key per logical send, and `mentions` on the wire. */
import { beforeEach, describe, expect, test } from "bun:test";
import { DmUnconfirmedError } from "../src/components/dms/dm-errors.ts";
import { retrySendDm, sendDm } from "../src/components/dms/dm-send.ts";
import { DmSentStore } from "../src/lib/dm-store.ts";
import { OfscpClient } from "../src/lib/ofscp-client.ts";
import { type DmMessage, clearDms, dmThread } from "../src/stores/dms.ts";
import { DM, memBackend } from "./helpers/dm-fixtures.ts";

/**
 * Defect (B): a send used to carry TWO ids — a temporary `local_…` key for the
 * optimistic echo and a separate `clientMessageId` minted inside `sendDmMessage`
 * — so neither survived a retry. `retrySendDm` re-sent under a FRESH id, the
 * recipient's provider saw a new message, and a send that had committed without
 * acknowledging was delivered TWICE. One id per logical send fixes that: the echo
 * key IS the §7.1 idempotency key on the wire, and the retry threads it through.
 */
describe("sendDm / retrySendDm: one clientMessageId per logical send", () => {
  beforeEach(() => clearDms());

  /**
   * A client whose transport is scripted per attempt (the last entry repeats),
   * recording every request body so a test can assert what went ON THE WIRE.
   */
  const scriptedClient = (
    steps: (() => Promise<Response>)[],
  ): { client: OfscpClient; bodies: Record<string, unknown>[] } => {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const client = new OfscpClient({
      baseUrl: "https://h",
      fetch: ((_url: string, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
        const step = steps[Math.min(call, steps.length - 1)] as () => Promise<Response>;
        call += 1;
        return step();
      }) as unknown as typeof fetch,
    });
    return { client, bodies };
  };

  /** The provider's stored canonical message (201 first store / 200 duplicate). */
  const stores =
    (id: string, status = 201) =>
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id,
            author: "me@h",
            content: { mime: "text/plain", text: "hi" },
            createdAt: "2026-06-05T00:00:00Z",
          }),
          { status, headers: { "content-type": "application/json" } },
        ),
      );
  const rejects = (status: number) => () =>
    Promise.resolve(
      new Response(JSON.stringify({ detail: "no" }), {
        status,
        headers: { "content-type": "application/problem+json" },
      }),
    );
  const drops = () => Promise.reject(new TypeError("Failed to fetch"));
  const aborts = () => Promise.reject(new DOMException("aborted", "AbortError"));

  const args = (client: OfscpClient, sentStore: DmSentStore) => ({
    client,
    dmId: DM,
    me: "me@h",
    counterparty: "bob@h",
    text: "hi",
    sentStore,
  });

  test("the echo key IS the clientMessageId sent on the wire (not a second id)", async () => {
    const { client, bodies } = scriptedClient([stores("msg_1")]);
    const sentStore = new DmSentStore("me@h", memBackend());
    const returned = await sendDm(args(client, sentStore));

    expect(bodies).toHaveLength(1);
    expect(returned).toBe(bodies[0]?.clientMessageId as string);
    // Confirmed: the echo collapsed into ONE row carrying the canonical id.
    expect(dmThread(DM)).toHaveLength(1);
    expect(dmThread(DM)[0]?.id).toBe("msg_1");
    expect(dmThread(DM)[0]?.pending).toBe(false);
    expect(dmThread(DM)[0]?.clientMessageId).toBe(returned);
    expect(sentStore.list(DM)).toHaveLength(1);
    expect(sentStore.list(DM)[0]?.clientMessageId).toBe(returned);
  });

  test("`mentions` lists the users the text names; a bare handle is on the recipient's provider", async () => {
    const { client, bodies } = scriptedClient([stores("msg_1")]);
    const sentStore = new DmSentStore("me@h", memBackend());
    await sendDm({
      ...args(client, sentStore),
      counterparty: "bob@b.example",
      text: "ask @carol and @dave@d.example, not mail@x.example",
    });
    expect(bodies[0]?.mentions).toEqual(["carol@b.example", "dave@d.example"]);
  });

  test("text naming nobody sends no `mentions`", async () => {
    const { client, bodies } = scriptedClient([stores("msg_1")]);
    await sendDm(args(client, new DmSentStore("me@h", memBackend())));
    expect(bodies[0] && "mentions" in bodies[0]).toBe(false);
  });

  test("a retry re-sends under the ORIGINAL clientMessageId (server dedupes)", async () => {
    // Attempt 1 dies with the outcome unknown (the server may have committed);
    // attempt 2 is answered by the idempotency guard with the FIRST message (200).
    const { client, bodies } = scriptedClient([drops, stores("msg_1", 200)]);
    const sentStore = new DmSentStore("me@h", memBackend());

    await expect(sendDm(args(client, sentStore))).rejects.toBeInstanceOf(DmUnconfirmedError);
    const echo = dmThread(DM)[0] as DmMessage;
    const originalCmid = bodies[0]?.clientMessageId as string;
    // The echo is keyed by the very id that went out — the retry has something
    // real to thread through (this is what the two-id split made impossible).
    expect(echo.clientMessageId).toBe(originalCmid);

    await retrySendDm({
      ...args(client, sentStore),
      clientMessageId: echo.clientMessageId as string,
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.clientMessageId).toBe(originalCmid);
    // One row, the canonical one: the retry's echo collapsed into the message the
    // server returned rather than leaving a duplicate behind.
    expect(dmThread(DM)).toHaveLength(1);
    expect(dmThread(DM)[0]?.id).toBe("msg_1");
    expect(sentStore.list(DM)).toHaveLength(1);
  });

  for (const status of [400, 403]) {
    test(`a ${status} marks the echo failed (the send certainly did not land)`, async () => {
      const { client } = scriptedClient([rejects(status)]);
      const sentStore = new DmSentStore("me@h", memBackend());

      await expect(sendDm(args(client, sentStore))).rejects.toThrow(new RegExp(String(status)));
      const echo = dmThread(DM)[0];
      expect(echo?.failed).toBe(true);
      expect(echo?.pending).toBe(false);
      // Nothing was stored, so nothing is retained locally either.
      expect(sentStore.list(DM)).toHaveLength(0);
    });
  }

  for (const [label, fail] of [
    ["an aborted fetch", aborts],
    ["a network drop", drops],
    ["a 5xx", rejects(500)],
  ] as const) {
    test(`${label} leaves the echo PENDING and throws DmUnconfirmedError`, async () => {
      const { client } = scriptedClient([fail]);
      const sentStore = new DmSentStore("me@h", memBackend());

      const err = await sendDm(args(client, sentStore)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DmUnconfirmedError);
      expect((err as DmUnconfirmedError).cause).toBeDefined();
      // Still "sending…" — never "failed": the message may be in the recipient's
      // inbox already, and the UI must not assert a failure it cannot observe.
      const echo = dmThread(DM)[0];
      expect(echo?.pending).toBe(true);
      expect(echo?.failed).toBeUndefined();
    });
  }
});
