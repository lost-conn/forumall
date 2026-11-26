/**
 * Process shutdown on SIGTERM / SIGINT (§7.1 "Close codes": `1001` on
 * shutdown).
 *
 * The first signal closes every WebSocket with `1001`, then stops the server
 * gracefully. A graceful stop waits for in-flight requests and for clients to
 * answer the close handshake, and a client that never answers would keep the
 * process alive forever. So:
 *
 * - after `graceMs` the stop is forced (open connections are dropped), and
 * - a second signal forces it at once.
 *
 * Under `bun --hot` this module's caller is re-evaluated on every reload. The
 * signal listeners are therefore installed once per process (keyed on
 * `globalThis`) and always act on the most recently installed server, so
 * reloads neither stack listeners nor keep old apps reachable.
 */

/** What shutdown needs from the running server. */
export interface ShutdownTarget {
  /** Close every open WebSocket with `1001`. */
  closeWebSockets(): void;
  /** Bun's `server.stop(closeActiveConnections)`. */
  stop(force?: boolean): Promise<void>;
}

export interface ShutdownOptions {
  /** How long a graceful stop may take before it is forced. Default 5 s. */
  graceMs?: number;
  /** Process exit; injectable for tests. */
  exit?: (code: number) => void;
  /** Logger; injectable for tests. */
  log?: (line: string) => void;
}

/** Returned for tests: run the handler as if `signal` had been received. */
export type SignalHandler = (signal: string) => void;

/** Build the signal handler for `target`. Pure: installs nothing. */
export function createShutdownHandler(
  target: ShutdownTarget,
  options: ShutdownOptions = {},
): SignalHandler {
  const graceMs = options.graceMs ?? 5_000;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((line: string) => console.log(line));
  let shuttingDown = false;
  let exited = false;
  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };
  const force = () => target.stop(true).finally(() => finish(0));

  return (signal: string) => {
    if (shuttingDown) {
      log(`[server] ${signal} received again — forcing shutdown`);
      void force();
      return;
    }
    shuttingDown = true;
    log(`[server] ${signal} received — closing connections and shutting down`);
    target.closeWebSockets();
    const timer = setTimeout(() => {
      log(`[server] graceful stop exceeded ${graceMs} ms — forcing shutdown`);
      void force();
    }, graceMs);
    void target.stop().finally(() => {
      clearTimeout(timer);
      finish(0);
    });
  };
}

const CURRENT = Symbol.for("forumall.shutdown.current");
const INSTALLED = Symbol.for("forumall.shutdown.installed");

type ShutdownGlobal = typeof globalThis & {
  [CURRENT]?: SignalHandler;
  [INSTALLED]?: boolean;
};

/**
 * Make `target` the server that SIGTERM / SIGINT shut down. Listeners are
 * added only on the first call in a process; later calls (hot reloads) just
 * replace the target.
 */
export function installShutdown(target: ShutdownTarget, options?: ShutdownOptions): void {
  const g = globalThis as ShutdownGlobal;
  g[CURRENT] = createShutdownHandler(target, options);
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => g[CURRENT]?.(signal));
  }
}
