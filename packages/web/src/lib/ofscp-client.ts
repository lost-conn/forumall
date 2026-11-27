/**
 * OFSCP signing HTTP client (spec §4.4 / §4.5).
 *
 * Wraps `fetch` so that authenticated requests carry the §4.4.2 canonical
 * signature the server's §4.5 middleware accepts. For each signed request it:
 *
 *   1. serializes the body (JSON) and computes `contentDigest` over the EXACT
 *      bytes that will be sent,
 *   2. generates a fresh nonce + RFC 3339 timestamp,
 *   3. builds the canonical string from { authority=target host, METHOD, path,
 *      raw query } via the shared `sign()`,
 *   4. attaches the resulting `X-OFSCP-*` headers.
 *
 * Crucially the digest is computed over the SAME serialized body string that is
 * passed to `fetch`, and the path/query handed to `sign()` are the exact path +
 * raw query string of the URL — so the canonical string the client signs is
 * byte-identical to the one the server reconstructs.
 *
 * Unauthenticated requests (discovery, public reads, register/login, and the
 * Bearer-authorized device-key bootstrap) go through the same plumbing with the
 * signing step skipped. The auth/chat/dm/feed UI cards consume this client.
 */
import {
  type AuthBootstrapResponse,
  type DeviceKeyResponse,
  contentDigest,
  generateNonce,
  parseRetryAfterMs,
  rfc3339Timestamp,
  sign,
} from "@forumall/shared";

/** Identity + target needed to produce signed requests. */
export interface OfscpClientConfig {
  /**
   * Provider base URL, e.g. `https://providera.com` or `http://localhost:8787`.
   * Relative request paths resolve against this. Used for transport only.
   */
  baseUrl: string;
  /**
   * The provider's LOGICAL domain used as the §4.4.2 signing authority — the
   * server verifies against its OWN `config.domain`, never the request Host
   * (which stops cross-host replay). Defaults to the `baseUrl` host. Set this
   * when transport differs from the provider identity (e.g. an ephemeral test
   * port, or a reverse proxy): it must equal the provider's configured domain.
   */
  authority?: string;
  /** Authenticated actor, e.g. `alice@providera.com`. Omit for an anonymous client. */
  actor?: string;
  /** Device key id (`X-OFSCP-Key-ID`). Required to sign. */
  keyId?: string;
  /** Base64 (or hex / raw) Ed25519 private seed used to sign. Required to sign. */
  privateKey?: string;
  /** Injectable fetch (defaults to global `fetch`); set for tests. */
  fetch?: typeof fetch;
  /**
   * Cap on the total time spent waiting out `503` + `Retry-After` answers before
   * giving up (ms). Default {@link DEFAULT_RETRY_MAX_WAIT_MS}. See
   * {@link OfscpClient.request} for the retry policy.
   */
  retryMaxWaitMs?: number;
  /**
   * Injectable sleep (tests). Defaults to a real timer. Receives the request's
   * `AbortSignal`, and must reject when it aborts.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Default cap on 503/`Retry-After` waits. Short on purpose: a person is waiting.
 * A provider in its §4.5 replay-store warm-up after a restart (300s on its
 * clock, longer if ours lags) that asks for longer gets surfaced as a clear
 * {@link OfscpHttpError} instead.
 */
export const DEFAULT_RETRY_MAX_WAIT_MS = 15_000;

/** Methods that are safe to resend (RFC 9110 idempotent methods). */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

/** Re-exported: the strict shared parser (positive delta-seconds or future IMF-fixdate, ≥1s). */
export { parseRetryAfterMs };

/** A real timer that rejects with the signal's reason if it aborts first. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `run` under the request's abort signal, bounded by `opts.timeoutMs` when
 * set: the signal handed to `run` aborts on the caller's `opts.signal` or, once
 * the time is up, with a `TimeoutError` `DOMException`.
 */
async function withDeadline<T>(
  opts: RequestOptions,
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const { timeoutMs, signal: outer } = opts;
  if (timeoutMs === undefined) return run(outer);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive number of ms, got ${timeoutMs}`);
  }
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(outer?.reason);
  if (outer?.aborted) controller.abort(outer.reason);
  else outer?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    const message = `The request did not complete within ${timeoutMs} ms.`;
    controller.abort(new DOMException(message, "TimeoutError"));
  }, timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

/** Per-request options. */
export interface RequestOptions {
  /** Extra headers (merged; signing headers win on conflict). */
  headers?: Record<string, string>;
  /** Force unauthenticated even on a configured client (discovery / public reads). */
  anonymous?: boolean;
  /** Bearer token to attach (e.g. the bootstrap token for device-key registration). */
  bearer?: string;
  /** AbortSignal forwarded to fetch. */
  signal?: AbortSignal;
  /**
   * Bound on the whole request, in ms: every attempt, every `Retry-After` wait
   * and reading the response body. When it passes, the request is aborted with
   * a `TimeoutError` `DOMException`, which (like any abort) is an UNKNOWN
   * outcome, not a rejection ({@link isDefinitiveRejection}): the provider may
   * already have applied it. Unset: no bound beyond `fetch`'s own.
   */
  timeoutMs?: number;
  /**
   * Mark a POST/PATCH as safe to resend — its body carries an idempotency key
   * the server dedupes on (e.g. a message/DM `clientMessageId`) or it replaces
   * state wholesale (an edit). GET/HEAD/PUT/DELETE are always retryable.
   */
  idempotent?: boolean;
}

/** A typed HTTP response wrapper. */
export interface OfscpResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Parsed JSON body (or `undefined` for empty / non-JSON responses). */
  data: T;
  raw: Response;
}

/** Thrown for non-2xx responses; carries the parsed problem body when present. */
export class OfscpHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly response: Response;
  /** Seconds the server asked us to wait (`Retry-After`), when it said. */
  readonly retryAfterSeconds?: number;
  constructor(status: number, body: unknown, response: Response) {
    const detail =
      body && typeof body === "object" && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : response.statusText;
    const retryMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const retryAfterSeconds = retryMs === null ? undefined : Math.ceil(retryMs / 1000);
    super(
      status === 503
        ? // A neutral user-facing message for any 503 (a §4.5 warm-up after a
          // restart, a full replay store, or an upstream outage).
          `The provider is temporarily unavailable. Please try again${
            retryAfterSeconds !== undefined
              ? ` in about ${formatWait(retryAfterSeconds)}`
              : " shortly"
          }.`
        : `OFSCP request failed (${status}): ${detail}`,
    );
    this.name = "OfscpHttpError";
    this.status = status;
    this.body = body;
    this.response = response;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

/**
 * Whether `err` is a DEFINITIVE rejection — the provider answered and refused, so
 * the request certainly did NOT take effect.
 *
 * Only a 4xx {@link OfscpHttpError} qualifies. Everything else is an UNKNOWN
 * OUTCOME and must not be treated as "it didn't happen":
 *   - `TypeError` — `fetch` never got a response (network drop, DNS, CORS
 *     pre-flight); the request may still have reached the server.
 *   - `DOMException` (`AbortError`, or `TimeoutError` from
 *     {@link RequestOptions.timeoutMs}) — the fetch was aborted (navigation, an
 *     `AbortSignal`, the deadline) AFTER the bytes may already have been written.
 *   - a 5xx — the server took the request and blew up; it may have committed
 *     before failing (or failed in a proxy after committing).
 *   - anything non-`Error` (a thrown string, `undefined`) — unclassifiable.
 *
 * Callers that apply a mutation optimistically use this to decide whether a
 * revert is SAFE: reverting on an unknown outcome can silently discard a change
 * the server actually applied. See `editDm`/`deleteDm` in the DM controller,
 * where §8.3 leaves the author no server copy to re-sync a bad revert from.
 */
export function isDefinitiveRejection(err: unknown): boolean {
  return err instanceof OfscpHttpError && err.status >= 400 && err.status < 500;
}

/** The §4.4.2 signing authority for a URL: host plus any non-default port. */
function authorityOf(url: URL): string {
  // `url.host` already omits the default port for the scheme; `canonicalAuthority`
  // in the shared signer further normalizes (lowercase, strip `:443`).
  return url.host;
}

/** Serialize a body to the exact string sent + the content-type, if any. */
function serializeBody(body: unknown): { text: string; contentType?: string } {
  if (body === undefined || body === null) return { text: "" };
  if (typeof body === "string") return { text: body };
  if (body instanceof Uint8Array) return { text: new TextDecoder().decode(body) };
  return { text: JSON.stringify(body), contentType: "application/json" };
}

export class OfscpClient {
  private readonly config: OfscpClientConfig;
  private readonly doFetch: typeof fetch;

  constructor(config: OfscpClientConfig) {
    this.config = config;
    this.doFetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** The configured provider host (signing authority), e.g. `providera.com`. */
  get host(): string {
    return this.config.authority ?? authorityOf(new URL(this.config.baseUrl));
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get actor(): string | undefined {
    return this.config.actor;
  }

  /** Return a NEW client with merged config (e.g. after login attaches identity). */
  withIdentity(identity: { actor: string; keyId: string; privateKey: string }): OfscpClient {
    return new OfscpClient({ ...this.config, ...identity });
  }

  /** True when this client holds the credentials needed to sign. */
  canSign(): boolean {
    return Boolean(this.config.actor && this.config.keyId && this.config.privateKey);
  }

  // -- Verb helpers --------------------------------------------------------

  get<T = unknown>(path: string, opts?: RequestOptions): Promise<OfscpResponse<T>> {
    return this.request<T>("GET", path, undefined, opts);
  }
  post<T = unknown>(
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<OfscpResponse<T>> {
    return this.request<T>("POST", path, body, opts);
  }
  patch<T = unknown>(
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<OfscpResponse<T>> {
    return this.request<T>("PATCH", path, body, opts);
  }
  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<OfscpResponse<T>> {
    return this.request<T>("PUT", path, body, opts);
  }
  delete<T = unknown>(path: string, opts?: RequestOptions): Promise<OfscpResponse<T>> {
    return this.request<T>("DELETE", path, undefined, opts);
  }

  /**
   * POST raw binary bytes (e.g. a `multipart/form-data` upload) signed over the
   * EXACT bytes — without the UTF-8 round-trip {@link request} applies to a
   * `Uint8Array` body (which corrupts binary content). The §4.4 digest is computed
   * over `bytes` verbatim and the same `bytes` are handed to `fetch`, so the
   * canonical string the server reconstructs is byte-identical. `contentType` MUST
   * include the multipart boundary. Used by media upload (§5.8).
   */
  async postBinary<T = unknown>(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    opts: RequestOptions = {},
  ): Promise<OfscpResponse<T>> {
    const url = new URL(path, this.config.baseUrl);
    const headers: Record<string, string> = { ...opts.headers, "content-type": contentType };
    if (!opts.anonymous && this.canSign()) {
      const { headers: signed } = sign({
        actor: this.config.actor as string,
        keyId: this.config.keyId as string,
        privateKey: this.config.privateKey as string,
        authority: this.config.authority ?? authorityOf(url),
        method: "POST",
        path: url.pathname,
        query: url.search,
        timestamp: rfc3339Timestamp(),
        nonce: generateNonce(),
        // Pass the exact bytes so `sign` digests them verbatim (no decode).
        body: bytes,
      });
      Object.assign(headers, signed);
    }
    // Copy into a fresh ArrayBuffer-backed view so `fetch` sends a plain BodyInit.
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return withDeadline(opts, async (signal) => {
      const res = await this.doFetch(url.toString(), {
        method: "POST",
        headers,
        body,
        ...(signal ? { signal } : {}),
      });
      // Not retried: an upload is a non-idempotent POST with no idempotency key.
      return parseResponse<T>(res);
    });
  }

  /**
   * Build (and optionally sign) a request, send it, and parse the response.
   * Throws {@link OfscpHttpError} on a non-2xx status.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<OfscpResponse<T>> {
    return withDeadline(opts, (signal) => this.send<T>(method, path, body, opts, signal));
  }

  /** {@link request}'s attempts and retries, under `signal`. */
  private async send<T>(
    method: string,
    path: string,
    body: unknown,
    opts: RequestOptions,
    signal: AbortSignal | undefined,
  ): Promise<OfscpResponse<T>> {
    const { text } = serializeBody(body);
    const send = (): Promise<Response> => {
      // Re-built (and so RE-SIGNED, with a fresh timestamp + nonce) per attempt:
      // a resent signed request can never pass the server's replay check (§4.5).
      const { url, headers } = this.buildRequest(method, path, body, opts);
      return this.doFetch(url.toString(), {
        method,
        headers,
        // Only send a body for methods that carry one.
        ...(method !== "GET" && method !== "HEAD" && text !== "" ? { body: text } : {}),
        ...(signal ? { signal } : {}),
      });
    };

    // Retry policy: a `503` carrying `Retry-After` (e.g. the provider's §4.5
    // replay-store warm-up after a restart) is retried — re-signed — after the
    // requested wait, but only for idempotent requests (GET/HEAD/PUT/DELETE, or
    // a POST/PATCH the caller marks `idempotent`), at most 4 attempts, and only
    // while the summed waits stay within `retryMaxWaitMs` (default 15s). Past
    // that the 503 surfaces as an OfscpHttpError with a user-facing message and
    // `retryAfterSeconds`.
    const retryable = IDEMPOTENT_METHODS.has(method.toUpperCase()) || opts.idempotent === true;
    const maxWait = this.config.retryMaxWaitMs ?? DEFAULT_RETRY_MAX_WAIT_MS;
    const sleep = this.config.sleep ?? abortableSleep;
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      const res = await send();
      if (res.status !== 503 || !retryable || attempt >= 4) return parseResponse<T>(res);
      const waitMs = parseRetryAfterMs(res.headers.get("retry-after"));
      if (waitMs === null || waited + waitMs > maxWait) return parseResponse<T>(res);
      await res.body?.cancel();
      // Abort-aware: an aborted request stops waiting and rejects at once.
      await sleep(waitMs, signal);
      waited += waitMs;
    }
  }

  /**
   * Compute the outgoing URL + headers WITHOUT sending. Exposed so tests (and the
   * §4.5 verification round-trip) can assert the exact `X-OFSCP-*` headers and so
   * advanced callers can inspect/replay a request. Signs iff the client can sign
   * and the request is not forced anonymous / Bearer.
   */
  buildRequest(
    method: string,
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): { url: URL; headers: Record<string, string>; canonicalString?: string } {
    const url = new URL(path, this.config.baseUrl);
    const { text, contentType } = serializeBody(body);

    const headers: Record<string, string> = { ...opts.headers };
    if (contentType && text !== "") headers["content-type"] ??= contentType;

    // Bearer-authorized (bootstrap) requests are not signed.
    if (opts.bearer) {
      headers.authorization = `Bearer ${opts.bearer}`;
      return { url, headers };
    }

    const signable = !opts.anonymous && this.canSign();
    if (!signable) return { url, headers };

    // Sign over the EXACT path + raw query of the URL and the EXACT body bytes.
    // `url.search` includes the leading `?`; the shared canonicalizer strips it.
    const { headers: signed, canonicalString } = sign({
      actor: this.config.actor as string,
      keyId: this.config.keyId as string,
      privateKey: this.config.privateKey as string,
      authority: this.config.authority ?? authorityOf(url),
      method: method.toUpperCase(),
      path: url.pathname,
      query: url.search,
      body: text,
    });
    return { url, headers: { ...headers, ...signed }, canonicalString };
  }

  // -- Auth bootstrap flow primitives (§4.1–§4.3) --------------------------
  // The auth UI card wires the screens; these provide the plumbing.

  /** POST /api/auth/register → bootstrap token (§4.1.1). Unauthenticated. */
  async register(input: {
    handle: string;
    password: string;
    recoveryEmail?: string;
    /** Account invite for an invite-only provider (§4.1.1). */
    inviteToken?: string;
  }): Promise<AuthBootstrapResponse> {
    const res = await this.post<AuthBootstrapResponse>("/api/auth/register", input, {
      anonymous: true,
    });
    return res.data;
  }

  /** POST /api/auth/login → bootstrap token (§4.1.2). Unauthenticated. */
  async login(input: { handle: string; password: string }): Promise<AuthBootstrapResponse> {
    const res = await this.post<AuthBootstrapResponse>("/api/auth/login", input, {
      anonymous: true,
    });
    return res.data;
  }

  /**
   * POST /api/auth/device-keys with the bootstrap token as Bearer (§4.3).
   * Registers `publicKey` and returns the server-assigned `key_id`. The caller
   * keeps the matching private seed (in the key-store) — it never leaves here.
   */
  async registerDeviceKey(
    bootstrapToken: string,
    input: { publicKey: string; deviceName: string; algorithm?: "Ed25519" },
  ): Promise<DeviceKeyResponse> {
    const res = await this.post<DeviceKeyResponse>(
      "/api/auth/device-keys",
      {
        public_key: input.publicKey,
        algorithm: input.algorithm ?? "Ed25519",
        device_name: input.deviceName,
      },
      { bearer: bootstrapToken },
    );
    return res.data;
  }
}

/** Parse a response body (JSON when present), throwing on a non-2xx status. */
async function parseResponse<T>(res: Response): Promise<OfscpResponse<T>> {
  let data: unknown;
  const ct = res.headers.get("content-type") ?? "";
  if (res.status !== 204 && ct.includes("json")) {
    data = await res.json().catch(() => undefined);
  } else if (res.status !== 204) {
    const text = await res.text().catch(() => "");
    data = text === "" ? undefined : text;
  }
  if (!res.ok) throw new OfscpHttpError(res.status, data, res);
  return { status: res.status, ok: res.ok, headers: res.headers, data: data as T, raw: res };
}

/** Convenience: a fresh per-request nonce + timestamp (re-exported for callers). */
export const ofscpRequestMeta = { generateNonce, rfc3339Timestamp, contentDigest };
