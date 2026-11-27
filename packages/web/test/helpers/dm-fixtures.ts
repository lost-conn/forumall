/** Shared DM test fixtures: a sample reaction, a DM id, an in-memory sent-store backend. */
import type { Reaction } from "@forumall/shared";
import type { SentDmMessage } from "../../src/lib/dm-store.ts";

export function reaction(over: Partial<Reaction>): Reaction {
  return {
    id: over.id ?? "rct_1",
    author: over.author ?? "alice@h",
    key: over.key ?? "+1",
    reference: over.reference ?? { type: "message", id: "m1" },
    createdAt: "2026-06-05T00:00:00Z",
    metadata: [],
    ...(over.unicode !== undefined ? { unicode: over.unicode } : {}),
  } as Reaction;
}

export const DM = "dm_aaaa";

/** A fresh in-memory backend so each test is isolated from localStorage. */
export function memBackend() {
  const map = new Map<string, string>();
  return {
    read: (k: string) => map.get(k) ?? null,
    write: (k: string, v: string) => {
      map.set(k, v);
    },
    remove: (k: string) => {
      map.delete(k);
    },
    keys: () => [...map.keys()],
  };
}

export function sent(over: Partial<SentDmMessage>): SentDmMessage {
  return {
    id: over.id ?? "msg_1",
    author: over.author ?? "alice@h",
    content: over.content ?? { mime: "text/plain", text: "hi" },
    createdAt: over.createdAt ?? "2026-06-05T00:00:00.000Z",
    ...(over.editedAt !== undefined ? { editedAt: over.editedAt } : {}),
    ...(over.deletedAt !== undefined ? { deletedAt: over.deletedAt } : {}),
    ...(over.clientMessageId !== undefined ? { clientMessageId: over.clientMessageId } : {}),
  };
}
