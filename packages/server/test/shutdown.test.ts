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

interface FakeOptions {
  /** The graceful stop rejects at once instead of hanging. */
  gracefulRejects?: boolean;
  /** The forced stop rejects instead of resolving. */
  forceRejects?: boolean;
  /** The forced stop never settles. */
  forceHangs?: boolean;
}

/**
 * A server whose graceful stop hangs until `resolveGraceful` (or rejects) and
 * whose forced stop resolves (or rejects) at once.
 */
function fakeServer(opts: FakeOptions = {}): Fake {
  const calls: string[] = [];
  let resolveGraceful = () => {};
  return {
    calls,
    resolveGraceful: () => resolveGraceful(),
    closeWebSockets: () => calls.push("close1001"),
    stop: (force?: boolean) => {
      calls.push(force ? "stop(force)" : "stop");
      if (force) {
        if (opts.forceHangs) return new Promise<void>(() => {});
        return opts.forceRejects ? Promise.reject(new Error("force boom")) : Promise.resolve();
      }
      if (opts.gracefulRejects) return Promise.reject(new Error("graceful boom"));
      return new Promise<void>((resolve) => {
        resolveGraceful = resolve;
      });
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `body` and return every rejection left unhandled while it ran. */
async function unhandledDuring(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    await body();
    await sleep(5);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return seen;
}

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

  test("a second signal disarms the grace timer; later signals do not force again", async () => {
    const s = fakeServer();
    const exits: number[] = [];
    const lines: string[] = [];
    const handle = createShutdownHandler(s, {
      graceMs: 20,
      exit: (c) => exits.push(c),
      log: (l) => lines.push(l),
    });
    handle("SIGTERM");
    handle("SIGTERM");
    handle("SIGTERM");
    await sleep(60);
    expect(s.calls).toEqual(["close1001", "stop", "stop(force)"]);
    expect(lines.some((l) => l.includes("graceful stop exceeded"))).toBe(false);
    expect(exits).toEqual([0]);
  });

  test("a graceful stop that rejects is logged and forced, exit 1, nothing unhandled", async () => {
    const s = fakeServer({ gracefulRejects: true });
    const exits: number[] = [];
    const lines: string[] = [];
    const unhandled = await unhandledDuring(async () => {
      createShutdownHandler(s, {
        graceMs: 10_000,
        exit: (c) => exits.push(c),
        log: (l) => lines.push(l),
      })("SIGTERM");
      await sleep(5);
    });
    expect(unhandled).toEqual([]);
    expect(s.calls).toEqual(["close1001", "stop", "stop(force)"]);
    expect(lines.some((l) => l.includes("graceful stop failed: graceful boom"))).toBe(true);
    expect(exits).toEqual([1]);
  });

  test("a forced stop that rejects is logged, exit 1, nothing unhandled", async () => {
    const s = fakeServer({ forceRejects: true });
    const exits: number[] = [];
    const lines: string[] = [];
    const unhandled = await unhandledDuring(async () => {
      const handle = createShutdownHandler(s, {
        graceMs: 10_000,
        exit: (c) => exits.push(c),
        log: (l) => lines.push(l),
      });
      handle("SIGINT");
      handle("SIGINT");
      await sleep(5);
    });
    expect(unhandled).toEqual([]);
    expect(lines.some((l) => l.includes("forced stop failed: force boom"))).toBe(true);
    expect(exits).toEqual([1]);
  });

  test("a forced stop that never settles exits 1 after another grace period", async () => {
    const s = fakeServer({ forceHangs: true });
    const exits: number[] = [];
    const lines: string[] = [];
    createShutdownHandler(s, {
      graceMs: 50,
      exit: (c) => exits.push(c),
      log: (l) => lines.push(l),
    })("SIGTERM");
    await sleep(75);
    expect(s.calls).toEqual(["close1001", "stop", "stop(force)"]);
    expect(exits).toEqual([]);
    await sleep(75);
    expect(lines.some((l) => l.includes("forced stop did not finish"))).toBe(true);
    expect(exits).toEqual([1]);
  });
});
