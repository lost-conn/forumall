/**
 * Outbound egress guard (SSRF defence, OFSCP §8 "Outbound requests").
 *
 * Every host this provider fetches from is chosen by someone else: the domain
 * in a caller's `X-OFSCP-Actor` header (key + discovery lookups), a peer's
 * known-providers list, a user's notification webhook `target`, a browser's
 * Web Push `endpoint`. Without a guard, any of them can point the provider at
 * its own loopback, the cloud metadata service, or an internal network.
 *
 * {@link assertPublicHttpsUrl} enforces:
 *  - `https:` only;
 *  - the host — a literal IP, or EVERY address its name resolves to — is a
 *    public unicast address (no loopback, private, link-local, CGNAT,
 *    documentation, benchmarking, multicast, reserved, or unspecified ranges,
 *    including IPv4-mapped IPv6 forms).
 *
 * {@link guardedFetch} applies that check, refuses to follow redirects (a 3xx
 * from a public host could otherwise bounce the request inward), and bounds
 * every request with a timeout.
 *
 * Known gap: the check resolves the name, then `fetch` resolves it again, so a
 * DNS-rebinding peer could answer differently the second time. Closing that
 * needs connecting to the vetted address directly, which Bun's `fetch` cannot
 * do while keeping TLS SNI/Host correct; the timeout and no-redirect rules
 * still apply.
 */
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

/** Default per-request timeout for outbound federation/push calls. */
export const DEFAULT_EGRESS_TIMEOUT_MS = 10_000;

/** Thrown when an outbound request targets a forbidden scheme or address. */
export class EgressBlockedError extends Error {
  readonly code = "EGRESS_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "EgressBlockedError";
  }
}

/** IPv4 CIDR blocks that are never a legitimate federation peer. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata 169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + limited broadcast
];

function v4ToInt(addr: string): number {
  return addr.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isBlockedV4(addr: string): boolean {
  const ip = v4ToInt(addr);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (v4ToInt(base) & mask);
  });
}

/** Expand an IPv6 address to its 8 16-bit groups (handles `::` and a dotted-quad tail). */
function v6Groups(addr: string): number[] | null {
  let a = addr.toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  // A trailing dotted quad (e.g. ::ffff:10.0.0.1) becomes two hex groups.
  const lastColon = a.lastIndexOf(":");
  const tail = a.slice(lastColon + 1);
  if (isIPv4(tail)) {
    const n = v4ToInt(tail);
    a = `${a.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = a.split("::");
  const headParts = head ? head.split(":") : [];
  const restParts = rest ? rest.split(":") : [];
  const fill = a.includes("::") ? 8 - headParts.length - restParts.length : 0;
  const parts = [...headParts, ...Array(fill).fill("0"), ...restParts];
  if (parts.length !== 8) return null;
  const groups = parts.map((p) => Number.parseInt(p || "0", 16));
  return groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? null : groups;
}

function isBlockedV6(addr: string): boolean {
  const g = v6Groups(addr);
  if (!g) return true; // unparseable → refuse
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const allZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (allZeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) → judge the v4.
  if (allZeroPrefix && (g5 === 0xffff || g5 === 0)) {
    return isBlockedV4(`${g6 >>> 8}.${g6 & 0xff}.${g7 >>> 8}.${g7 & 0xff}`);
  }
  // NAT64 well-known prefix 64:ff9b::/96 → judge the embedded v4.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedV4(`${g6 >>> 8}.${g6 & 0xff}.${g7 >>> 8}.${g7 & 0xff}`);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  return false;
}

/** True iff `addr` (a literal IPv4/IPv6 address) must never be fetched from. */
export function isBlockedAddress(addr: string): boolean {
  if (isIPv4(addr)) return isBlockedV4(addr);
  if (isIPv6(addr)) return isBlockedV6(addr);
  return true; // not an IP literal → refuse (callers resolve names first)
}

/** A resolver returning every address for a hostname (injectable for tests). */
export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((r) => r.address);

/**
 * Throw {@link EgressBlockedError} unless `url` is `https:` and its host — or
 * every address it resolves to — is publicly routable.
 */
export async function assertPublicHttpsUrl(
  url: string | URL,
  resolve: Resolver = defaultResolver,
): Promise<void> {
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.protocol !== "https:") {
    throw new EgressBlockedError(`refusing non-https egress to ${u.protocol}//${u.host}`);
  }
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  let addrs: string[];
  if (isIPv4(host) || isIPv6(host)) {
    addrs = [host];
  } else {
    try {
      addrs = await resolve(host);
    } catch {
      throw new EgressBlockedError(`cannot resolve egress host ${host}`);
    }
  }
  if (addrs.length === 0 || addrs.some(isBlockedAddress)) {
    throw new EgressBlockedError(`refusing egress to non-public address for ${host}`);
  }
}

/**
 * `fetch` with the egress guard applied: public https targets only, redirects
 * returned (never followed), and a hard timeout.
 */
export async function guardedFetch(
  request: Request,
  opts: { timeoutMs?: number; resolve?: Resolver } = {},
): Promise<Response> {
  await assertPublicHttpsUrl(request.url, opts.resolve);
  return fetch(request, {
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_EGRESS_TIMEOUT_MS),
  });
}
