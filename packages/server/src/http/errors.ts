/**
 * RFC 7807 `application/problem+json` error handling.
 *
 * Provides {@link AppError} (a thrown error carrying status/type/title/detail),
 * a {@link problemResponse} helper, and Hono {@link onError} / {@link notFound}
 * handlers that render every failure as a `ProblemDetails` body. The
 * `ProblemDetails` shape is the shared OFSCP one (`@forumall/shared`).
 *
 * The §7.3 error-code registry is centralized in {@link ERROR_CODE_STATUS} (code →
 * fixed HTTP status) and {@link PROBLEM_STATUS} (the slugs `AppError` is built
 * from). Every problem carries an `errorCode` (§2.6) — the interoperable key —
 * and a `type` of `https://{authority}/problems/{errorCode}`, where `{authority}`
 * is THIS provider's canonical authority (§2.2): each provider mints its own
 * type URIs (OFSCP §2.6, lost-conn/ofscp#17). The authority is therefore an
 * argument to {@link problemType} / {@link AppError.toProblem}, and the Hono
 * handlers come from {@link createProblemHandlers}, bound to `config.domain` at
 * app construction. `GET /problems/{errorCode}` serves the human-readable
 * description (`http/problems.ts`).
 */
import { type ProblemDetails, ProblemDetailsSchema } from "@forumall/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodType } from "zod";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/**
 * The OFSCP §7.3 **error code registry** (Normative): each registry `errorCode`
 * has a fixed HTTP status. The same codes (and statuses) are used for the `code`
 * of WebSocket `error` events. An extension code is allowed only paired with
 * the status of its nearest registry code — Forumall currently uses none.
 * `meaning` is the short description served at `GET /problems/{errorCode}`.
 */
export const ERROR_CODE_REGISTRY = {
  bad_request: {
    status: 400,
    meaning: "Invalid payload, parameters, or schema mismatch.",
  },
  unauthorized: {
    status: 401,
    meaning: "Missing or invalid signature or credentials (OFSCP §4.5).",
  },
  forbidden: {
    status: 403,
    meaning: "Authenticated, but not permitted (including federation policy, OFSCP §8).",
  },
  registration_closed: {
    status: 403,
    meaning: "This provider does not accept self-registration (OFSCP §4.1.1).",
  },
  invite_required: {
    status: 403,
    meaning:
      "Registration needs a valid account invite, and none was supplied or the one supplied is not usable (OFSCP §4.1.1).",
  },
  not_found: { status: 404, meaning: "No such resource, or not visible to the caller." },
  conflict: { status: 409, meaning: "The request conflicts with current state." },
  subscription_limit: {
    status: 409,
    meaning:
      "Too many live subscriptions on one WebSocket connection (OFSCP §7.1); unsubscribe from something first.",
  },
  payload_too_large: {
    status: 413,
    meaning: "The request or upload exceeds this provider's size limit.",
  },
  too_many_requests: {
    status: 429,
    meaning: "Rate limited; honour Retry-After when present.",
  },
  internal_error: { status: 500, meaning: "Unexpected provider error." },
  service_unavailable: {
    status: 503,
    meaning:
      "Temporarily unavailable, including a full replay store or the replay-store warm-up after a restart (OFSCP §4.5); honour Retry-After, and re-sign the request with a fresh timestamp and nonce before retrying.",
  },
} as const satisfies Record<string, { status: ContentfulStatusCode; meaning: string }>;

/** A registry `errorCode` (OFSCP §7.3). */
export type RegistryErrorCode = keyof typeof ERROR_CODE_REGISTRY;

/** True iff `code` is a registry `errorCode`. */
export function isRegistryErrorCode(code: string): code is RegistryErrorCode {
  return Object.hasOwn(ERROR_CODE_REGISTRY, code);
}

/** The fixed HTTP status of a registry `errorCode` (OFSCP §7.3). */
export function errorCodeStatus(code: RegistryErrorCode): ContentfulStatusCode {
  return ERROR_CODE_REGISTRY[code].status;
}

/**
 * The `AppError` slugs → canonical title + registry `errorCode` (whose status
 * {@link ERROR_CODE_REGISTRY} fixes; a test pins the two tables together).
 */
export const PROBLEM_STATUS = {
  badRequest: { status: 400, title: "Bad Request", errorCode: "bad_request" },
  unauthorized: { status: 401, title: "Unauthorized", errorCode: "unauthorized" },
  forbidden: { status: 403, title: "Forbidden", errorCode: "forbidden" },
  notFound: { status: 404, title: "Not Found", errorCode: "not_found" },
  conflict: { status: 409, title: "Conflict", errorCode: "conflict" },
  subscriptionLimit: {
    status: 409,
    title: "Subscription Limit",
    errorCode: "subscription_limit",
  },
  payloadTooLarge: {
    status: 413,
    title: "Payload Too Large",
    errorCode: "payload_too_large",
  },
  tooManyRequests: {
    status: 429,
    title: "Too Many Requests",
    errorCode: "too_many_requests",
  },
  internal: {
    status: 500,
    title: "Internal Server Error",
    errorCode: "internal_error",
  },
  serviceUnavailable: {
    status: 503,
    title: "Service Unavailable",
    errorCode: "service_unavailable",
  },
} as const satisfies Record<
  string,
  { status: ContentfulStatusCode; title: string; errorCode: RegistryErrorCode }
>;

export type ProblemSlug = keyof typeof PROBLEM_STATUS;

/** The {@link AppError} slug whose registry `errorCode` is `code`. */
export function slugForErrorCode(code: RegistryErrorCode): ProblemSlug {
  const slug = (Object.keys(PROBLEM_STATUS) as ProblemSlug[]).find(
    (k) => PROBLEM_STATUS[k].errorCode === code,
  );
  // Unreachable: every registry code has a slug (pinned by problem-registry.test.ts).
  if (slug === undefined) throw new TypeError(`no AppError slug for errorCode ${code}`);
  return slug;
}

/**
 * Mint a problem `type` URI (OFSCP §2.6): `https://{authority}/problems/{errorCode}`,
 * where `authority` is this provider's canonical authority (§2.2,
 * `canonicalAuthority(config.domain)` — may carry a `:port`). Used for registry
 * and extension codes alike.
 */
export function problemType(authority: string, errorCode: string): string {
  return `https://${authority}/problems/${errorCode}`;
}

export interface AppErrorOptions {
  /** Optional human-readable detail, safe to expose to the caller. */
  detail?: string;
  /** Optional URI reference identifying the specific occurrence. */
  instance?: string;
  /**
   * Override the machine `errorCode` (defaults to the slug's code). §7.3: a
   * registry code must keep its fixed status, and an extension code must be
   * paired with the status of its nearest registry code — i.e. choose the slug
   * accordingly. A registry code on the wrong slug throws at construction.
   */
  errorCode?: string;
  /** Extra members merged into the problem document. */
  extensions?: Record<string, unknown>;
  /** Underlying cause (logged, never serialized). */
  cause?: unknown;
  /**
   * Extra HTTP response headers (e.g. `Retry-After` on a 429, §7.3/§4.1.5).
   * Never serialized into the problem document itself.
   */
  headers?: Record<string, string>;
}

/**
 * An application error that maps to a problem+json response. Throw it from any
 * handler/middleware; {@link onError} turns it into the wire response.
 */
export class AppError extends Error {
  readonly slug: ProblemSlug;
  readonly status: ContentfulStatusCode;
  readonly title: string;
  readonly errorCode: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly extensions?: Record<string, unknown>;
  readonly headers?: Record<string, string>;

  constructor(slug: ProblemSlug, opts: AppErrorOptions = {}) {
    const entry = PROBLEM_STATUS[slug];
    super(opts.detail ?? entry.title, { cause: opts.cause });
    this.name = "AppError";
    this.slug = slug;
    this.status = entry.status;
    this.title = entry.title;
    const errorCode = opts.errorCode ?? entry.errorCode;
    if (isRegistryErrorCode(errorCode) && ERROR_CODE_REGISTRY[errorCode].status !== entry.status) {
      // Programmer error: §7.3 fixes each registry code's status.
      throw new TypeError(
        `errorCode ${errorCode} must be sent with status ${ERROR_CODE_REGISTRY[errorCode].status}, not ${entry.status} (OFSCP §7.3)`,
      );
    }
    this.errorCode = errorCode;
    this.detail = opts.detail;
    this.instance = opts.instance;
    this.extensions = opts.extensions;
    this.headers = opts.headers;
  }

  /**
   * Render this error as a validated {@link ProblemDetails} document, with the
   * `type` minted under `authority` — this provider's canonical authority.
   */
  toProblem(authority: string): ProblemDetails {
    return ProblemDetailsSchema.parse({
      type: problemType(authority, this.errorCode),
      title: this.title,
      status: this.status,
      errorCode: this.errorCode,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      ...(this.instance !== undefined ? { instance: this.instance } : {}),
      ...this.extensions,
    });
  }

  // ---- ergonomic constructors for the common §7.3 statuses ----------------
  static badRequest = (o?: AppErrorOptions) => new AppError("badRequest", o);
  static unauthorized = (o?: AppErrorOptions) => new AppError("unauthorized", o);
  static forbidden = (o?: AppErrorOptions) => new AppError("forbidden", o);
  static notFound = (o?: AppErrorOptions) => new AppError("notFound", o);
  static conflict = (o?: AppErrorOptions) => new AppError("conflict", o);
  static payloadTooLarge = (o?: AppErrorOptions) => new AppError("payloadTooLarge", o);
  static tooManyRequests = (o?: AppErrorOptions) => new AppError("tooManyRequests", o);
  static serviceUnavailable = (o?: AppErrorOptions) => new AppError("serviceUnavailable", o);
}

/** Build a Hono `Response` carrying a problem+json body, with optional extra headers. */
export function problemResponse(
  c: Context,
  problem: ProblemDetails,
  headers?: Record<string, string>,
): Response {
  return c.json(problem, problem.status as ContentfulStatusCode, {
    "content-type": PROBLEM_CONTENT_TYPE,
    ...headers,
  });
}

/**
 * Validate a REQUEST body against `schema`, throwing a `400` on failure. Use
 * this (not `schema.parse`) wherever the input came from the client: a bare
 * `.parse` throws a `ZodError`, which — correctly, since most `.parse` calls
 * check the server's OWN output — renders as a logged `500`.
 */
export function parseRequestBody<T>(schema: ZodType<T>, raw: unknown, what = "request body"): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw AppError.badRequest({ detail: `invalid ${what}` });
  return parsed.data;
}

/** The Hono error/404 handlers, bound to one provider authority. */
export interface ProblemHandlers {
  readonly onError: (err: Error, c: Context) => Response;
  readonly notFound: (c: Context) => Response;
}

/**
 * Build the Hono `onError` / `notFound` handlers for a provider whose canonical
 * authority (§2.2) is `authority`, so every problem `type` it emits — including
 * the generic 500 and the 404 fallback — is `https://{authority}/problems/…`.
 *
 * `onError` renders {@link AppError} faithfully; any other thrown value becomes
 * a generic 500 with no internal detail leaked to the client (the real error is
 * logged server-side).
 */
export function createProblemHandlers(authority: string): ProblemHandlers {
  const onError = (err: Error, c: Context): Response => {
    if (err instanceof AppError) {
      if (err.status >= 500) console.error("[server] AppError:", err);
      return problemResponse(c, err.toProblem(authority), err.headers);
    }

    // Unknown/unexpected error: log everything, expose nothing.
    console.error("[server] Unhandled error:", err);
    return problemResponse(c, new AppError("internal").toProblem(authority));
  };

  const notFound = (c: Context): Response =>
    problemResponse(c, new AppError("notFound").toProblem(authority));

  return { onError, notFound };
}
