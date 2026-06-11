/**
 * Web Push EGRESS DIAGNOSTIC (provider-local, ops-only). Answers one question a
 * deploy can't easily answer from inside a sandboxed VM: *can this host actually
 * reach the browser push services, and over which IP family?*
 *
 * For each well-known push host it resolves the A (IPv4) and AAAA (IPv6) records
 * and does a raw TCP connect to :443 per family, then also runs the real `fetch`
 * path so the report captures the exact error the delivery path hits. The result
 * distinguishes the two failure modes we care about:
 *   - IPv4 TCP ok + IPv6 TCP fails + default fetch fails → the runtime is picking
 *     an unroutable IPv6 address (IPv4-only-NAT host); force IPv4.
 *   - both families fail → genuine egress block; a proxy (or platform fix) is the
 *     only path out.
 *
 * Hosts are HARD-CODED (no caller input), so the endpoint that exposes this has
 * no SSRF surface. It opens a few short-lived sockets per call.
 */
import net from "node:net";

/** A single-family resolution + reachability probe for one host. */
export interface FamilyProbe {
  readonly family: 4 | 6;
  /** Resolved addresses for this family (empty if none / lookup failed). */
  readonly addresses: readonly string[];
  /** Raw TCP-connect result to the first address:443, or null if none resolved. */
  readonly tcp443: { readonly ok: boolean; readonly error?: string; readonly ms: number } | null;
}

/** The full egress picture for one push host. */
export interface HostEgress {
  readonly host: string;
  readonly v4: FamilyProbe;
  readonly v6: FamilyProbe;
  /** What the real `fetch` transport does (the delivery path's actual behaviour). */
  readonly fetch: {
    readonly ok: boolean;
    readonly status?: number;
    readonly error?: string;
    readonly ms: number;
  };
}

/** The diagnostic report returned by {@link egressCheck}. */
export interface EgressReport {
  /** The configured DNS order in effect (so the operator can confirm the build). */
  readonly dnsResultOrder: string;
  /** Whether a push proxy is configured (value redacted — boolean only). */
  readonly pushProxyConfigured: boolean;
  readonly hosts: readonly HostEgress[];
  /** Epoch millis the report was generated. */
  readonly at: number;
}

/** The push services we attempt to reach (resolvable hosts only — no wildcards). */
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com"] as const;

/**
 * Race a promise against a timer, resolving to `fallback` if it doesn't settle in
 * `ms`. Keeps the diagnostic gateway-safe: on a host where outbound DNS itself
 * hangs (blocked egress), the lookup can't stall the HTTP response past the proxy
 * timeout — it just reports an empty/failed probe instead.
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** Resolve a host's addresses for a single IP family (best-effort, bounded, never throws). */
async function lookupFamily(host: string, family: 4 | 6, timeoutMs: number): Promise<string[]> {
  const lookup = (async () => {
    try {
      const records = await Bun.dns.lookup(host, { family });
      return records.map((r) => r.address);
    } catch {
      return [];
    }
  })();
  return withTimeout(lookup, timeoutMs, []);
}

/**
 * Raw TCP connect to `host:port` (host should be an IP literal so no DNS family
 * ambiguity). Resolves ok=true on `connect`, ok=false with the error code on
 * `error`/`timeout`. Exported for deterministic offline testing.
 */
export function tcpConnect(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string; ms: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve({ ok, ...(error !== undefined ? { error } : {}), ms: Date.now() - start });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (e: NodeJS.ErrnoException) => finish(false, e.code ?? e.message));
  });
}

/** Resolve + TCP-probe one family of one host. */
async function probeFamily(host: string, family: 4 | 6, timeoutMs: number): Promise<FamilyProbe> {
  const addresses = await lookupFamily(host, family, timeoutMs);
  const first = addresses[0];
  const tcp443 = first !== undefined ? await tcpConnect(first, 443, timeoutMs) : null;
  return { family, addresses, tcp443 };
}

/** Run the real `fetch` transport (HEAD) so the report mirrors the delivery path. */
async function probeFetch(
  host: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status?: number; error?: string; ms: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`https://${host}/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true, status: res.status, ms: Date.now() - start };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, error: err.code ?? err.message ?? String(e), ms: Date.now() - start };
  }
}

/**
 * Probe egress to the known push services. `dnsResultOrder`/`pushProxyConfigured`
 * are surfaced verbatim from config so the report doubles as a "is the latest
 * build/config actually running?" check.
 */
export async function egressCheck(
  dnsResultOrder: string,
  pushProxyConfigured: boolean,
  timeoutMs = 3000,
): Promise<EgressReport> {
  const hosts = await Promise.all(
    PUSH_HOSTS.map(async (host): Promise<HostEgress> => {
      const [v4, v6, fetchProbe] = await Promise.all([
        probeFamily(host, 4, timeoutMs),
        probeFamily(host, 6, timeoutMs),
        probeFetch(host, timeoutMs),
      ]);
      return { host, v4, v6, fetch: fetchProbe };
    }),
  );
  return { dnsResultOrder, pushProxyConfigured, hosts, at: Date.now() };
}
