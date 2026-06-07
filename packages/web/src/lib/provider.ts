/**
 * Provider connection (P8, spec §3.1).
 *
 * The first-run "connect to your provider" step: given a provider host (domain),
 * fetch its `/.well-known/ofscp-provider` discovery document to confirm it is a
 * real OFSCP provider and surface its name + protocol version. The chosen host
 * is persisted so the app reconnects to the same provider on reload.
 *
 * Host vs. transport: the host the user types (e.g. `providera.com`, or a dev
 * `localhost:5173`) is the LOGICAL provider domain = the §4.4.2 signing
 * authority. Transport (the `baseUrl` the `OfscpClient`/`OfscpWsClient` use) is
 * derived from it. In dev/test the page is served by the provider itself, so the
 * current origin both is the transport and carries the signing authority.
 */
import { ProviderDiscoverySchema } from "@forumall/shared";

const PROVIDER_HOST_KEY = "forumall.provider.host";

/** A confirmed OFSCP provider, distilled from its discovery document. */
export interface ProviderInfo {
  /** Logical provider domain (signing authority), e.g. `providera.com`. */
  host: string;
  /** Software name advertised in discovery (e.g. `forumall`). */
  name: string;
  /** Software version. */
  version: string;
  /** OFSCP protocol version the provider speaks. */
  protocolVersion: string;
}

/**
 * Resolve the transport base URL for a logical provider host. When the host
 * matches the current page origin's host we reuse the page's scheme+origin (so a
 * dev server on an ephemeral `http://localhost:PORT` works); otherwise default
 * to `https://{host}`.
 */
export function baseUrlForHost(host: string): string {
  if (typeof location !== "undefined" && location.host === host) {
    return location.origin;
  }
  const insecure = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `${insecure ? "http" : "https"}://${host}`;
}

/**
 * The default provider host to suggest on first run. A client hosted separately
 * from its provider can bake in the target at build time via `VITE_PROVIDER_HOST`
 * (e.g. `providera.com`); otherwise it falls back to the current origin's host,
 * which is correct for the combined single-process deployment. Either way the
 * user can still override the host on the first-run connect screen.
 */
export function defaultProviderHost(): string {
  const configured = import.meta.env.VITE_PROVIDER_HOST;
  if (typeof configured === "string" && configured.length > 0) return configured;
  return typeof location !== "undefined" ? location.host : "";
}

/**
 * Confirm `host` is an OFSCP provider by fetching + validating its discovery
 * document. Returns the distilled {@link ProviderInfo}, or throws if the host is
 * unreachable or does not serve a valid `ofscp-provider` document.
 */
export async function probeProvider(
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderInfo> {
  const base = baseUrlForHost(host);
  const res = await fetchImpl(`${base}/.well-known/ofscp-provider`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`not an OFSCP provider (HTTP ${res.status})`);
  }
  const json = await res.json().catch(() => {
    throw new Error("provider discovery document was not valid JSON");
  });
  const parsed = ProviderDiscoverySchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("response was not a valid OFSCP provider discovery document");
  }
  const { provider } = parsed.data;
  return {
    host,
    name: provider.software.name,
    version: provider.software.version,
    protocolVersion: provider.protocolVersion,
  };
}

/** Persist the chosen provider host (survives reload). */
export function storeProviderHost(host: string): void {
  try {
    localStorage.setItem(PROVIDER_HOST_KEY, host);
  } catch {
    /* private mode / no storage: best-effort */
  }
}

/** The previously-chosen provider host, if any. */
export function loadProviderHost(): string | null {
  try {
    return localStorage.getItem(PROVIDER_HOST_KEY);
  } catch {
    return null;
  }
}

/** Forget the chosen provider host (full reset). */
export function clearProviderHost(): void {
  try {
    localStorage.removeItem(PROVIDER_HOST_KEY);
  } catch {
    /* best-effort */
  }
}
