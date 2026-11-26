/**
 * Process shutdown (§7.1 "Close codes"): the first signal closes WebSockets
 * with 1001 and stops gracefully; a stop that outlasts the grace period, or a
 * second signal, is forced; the process exits exactly once.
 */
import { describe, expect, test } from "bun:test";

import { type ShutdownTarget, createShutdownHandler } from "../src/lib/shutdown.ts";

interface Fake extends ShutdownTarget {
  calls: string[];
  resolveGraceful(): void;
}

/** A server whose graceful stop hangs until `resolveGraceful`; forced stop resolves at once. */
function fakeServer(): Fake {
  const calls: string[] = [];
  let resolveGraceful = () => {};
  return {
    calls,
    resolveGraceful: () => resolveGraceful(),
    closeWebSockets: () => calls.push("close1001"),
    stop: (force?: boolean) => {
      calls.push(force ? "stop(force)" : "stop");
      if (force) return Promise.resolve();
      return new Promise<void>((resolve) => {
        resolveGraceful = resolve;
      });
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("shutdown", () => {
  test("graceful stop: closes WebSockets with 1001, stops, exits once", async () => {
    const s = fakeServer();
    const exits: number[] = [];
    const handle = createShutdownHandler(s, {
      graceMs: 1_000,
      exit: (c) => exits.push(c),
      log: () => {},
    });
    handle("SIGTERM");
    expect(s.calls).toEqual(["close1001", "stop"]);
    s.resolveGraceful();
    await sleep(5);
    expect(exits).toEqual([0]);
  });

  test("a stop that outlasts the grace period is forced", async () => {
    const s = fakeServer();
    const exits: number[] = [];
    const handle = createShutdownHandler(s, {
      graceMs: 20,
      exit: (c) => exits.push(c),
      log: () => {},
    });
    handle("SIGTERM");
    await sleep(60);
    expect(s.calls).toEqual(["close1001", "stop", "stop(force)"]);
    expect(exits).toEqual([0]);
    // The hung graceful stop finishing later does not exit again.
    s.resolveGraceful();
    await sleep(5);
    expect(exits).toEqual([0]);
  });

  test("a second signal forces the stop at once", async () => {
    const s = fakeServer();
    const exits: number[] = [];
    const handle = createShutdownHandler(s, {
      graceMs: 10_000,
      exit: (c) => exits.push(c),
      log: () => {},
    });
    handle("SIGINT");
    handle("SIGINT");
    await sleep(5);
    expect(s.calls).toEqual(["close1001", "stop", "stop(force)"]);
    expect(exits).toEqual([0]);
  });
});
