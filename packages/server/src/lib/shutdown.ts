/**
 * Process shutdown on SIGTERM / SIGINT (§7.1 "Close codes": `1001` on
 * shutdown).
 *
 * The first signal closes every WebSocket with `1001`, then stops the server
 * gracefully. A graceful stop waits for in-flight requests and for clients to
 * answer the close handshake, and a client that never answers would keep the
 * process alive forever. So:
 *
 * - after `graceMs` the stop is forced (open connections are dropped),
 * - a second signal forces it at once (and disarms the grace timer), and
 * - a stop that rejects is logged and forced, and the process exits with `1`;
 *   so does a forced stop that has not settled after another `graceMs`.
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
  let forcing = false;
  let failed = false;
  let exited = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };
  const exitCode = () => (failed ? 1 : 0);
  const cancelGraceTimer = () => {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    graceTimer = undefined;
  };
  // Forcing happens at most once, whichever of the grace timer, a repeated
  // signal or a failed graceful stop asks first; a stop rejection is logged
  // and turns the exit code to 1, never an unhandled rejection.
  const force = () => {
    cancelGraceTimer();
    if (forcing) return;
    forcing = true;
    // A forced stop that itself never settles must not keep the process up:
    // after another `graceMs`, exit 1 regardless.
    const deadline = setTimeout(() => {
      failed = true;
      log(`[server] forced stop did not finish within ${graceMs} ms — exiting`);
      finish(exitCode());
    }, graceMs);
    target
      .stop(true)
      .finally(() => clearTimeout(deadline))
      .then(
        () => finish(exitCode()),
        (err: unknown) => {
          failed = true;
          log(`[server] forced stop failed: ${describe(err)}`);
          finish(exitCode());
        },
      );
  };

  return (signal: string) => {
    if (shuttingDown) {
      log(`[server] ${signal} received again — forcing shutdown`);
      force();
      return;
    }
    shuttingDown = true;
    log(`[server] ${signal} received — closing connections and shutting down`);
    target.closeWebSockets();
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      log(`[server] graceful stop exceeded ${graceMs} ms — forcing shutdown`);
      force();
    }, graceMs);
    target.stop().then(
      () => {
        cancelGraceTimer();
        finish(exitCode());
      },
      (err: unknown) => {
        failed = true;
        log(`[server] graceful stop failed: ${describe(err)} — forcing shutdown`);
        force();
      },
    );
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
