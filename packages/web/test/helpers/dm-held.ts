/**
 * Shared fixtures for the DM edit/delete ordering tests (`dm-mutation-chain.ts`):
 * a client whose requests wait for the test to answer them, the message `m1` as
 * the provider stores it and as a live `dm.message` copy, and accessors for the
 * thread's and the sent store's copies of it.
 */
import type { DmSentStore } from "../../src/lib/dm-store.ts";
import { OfscpClient } from "../../src/lib/ofscp-client.ts";
import { type DmMessage, dmThread } from "../../src/stores/dms.ts";
import { DM } from "./dm-fixtures.ts";

export const ME = "alice@h.example";
export const CREATED = "2026-11-27T10:00:00Z";
/** The provider's stamps on the first and second edit. */
export const E1 = "2026-11-27T10:05:00Z";
export const E2 = "2026-11-27T10:05:01Z";
/** A later edit made from another device. */
export const E3 = "2026-11-27T10:06:00Z";

/** One request the provider has received and not answered yet. */
export interface Held {
  method: string;
  body: { content?: { text?: string } } | null;
  /** The request's abort signal (set when the request is bounded). */
  signal: AbortSignal | undefined;
  answer(status: number, body?: unknown): void;
}

/**
 * A client whose every request waits until the test answers it, or until its
 * signal aborts (as a real `fetch` does).
 */
export function heldClient(): { client: OfscpClient; requests: Held[] } {
  const requests: Held[] = [];
  const fetchImpl = (_input: unknown, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      requests.push({
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        signal,
        answer: (status, body) =>
          resolve(
            new Response(body === undefined ? null : JSON.stringify(body), {
              status,
              headers: {
                "content-type": status >= 400 ? "application/problem+json" : "application/json",
              },
            }),
          ),
      });
    });
  return {
    client: new OfscpClient({ baseUrl: "https://h", fetch: fetchImpl as unknown as typeof fetch }),
    requests,
  };
}

/** Let pending promise callbacks run until `done()` holds (bounded). */
export async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !done(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!done()) throw new Error("condition never held");
}

/** Let every queued callback run. */
export async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The provider's stored copy of the message at a version. */
export function stored(text: string, editedAt?: string): Record<string, unknown> {
  return {
    id: "m1",
    type: "message",
    author: ME,
    content: { mime: "text/markdown", text },
    createdAt: CREATED,
    ...(editedAt !== undefined ? { editedAt } : {}),
    attachments: [],
    metadata: [],
  };
}

/** A live `dm.message` copy of the message, as the DM controller folds it. */
export function echo(text: string, editedAt: string): DmMessage {
  return {
    id: "m1",
    author: ME,
    content: { mime: "text/markdown", text },
    createdAt: CREATED,
    editedAt,
    mine: true,
  };
}

/** The thread's copy of the message. */
export function shown(): DmMessage {
  const m = dmThread(DM).find((x) => x.id === "m1");
  if (m === undefined) throw new Error("message not in the thread");
  return m;
}

/** The sent store's copy of the message. */
export function retained(sentStore: DmSentStore) {
  const m = sentStore.list(DM).find((x) => x.id === "m1");
  if (m === undefined) throw new Error("message not retained");
  return m;
}
