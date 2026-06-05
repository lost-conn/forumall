/**
 * RFC 7807 `application/problem+json` error handling.
 *
 * Provides {@link AppError} (a thrown error carrying status/type/title/detail),
 * a {@link problemResponse} helper, and Hono {@link onError} / {@link notFound}
 * handlers that render every failure as a `ProblemDetails` body. The
 * `ProblemDetails` shape is the shared OFSCP one (`@forumall/shared`).
 *
 * The §7.3 status table is centralized in {@link PROBLEM_STATUS}; `type` URIs
 * are minted under a stable `https://` base so they satisfy the shared
 * `ProblemDetails` schema (which requires an absolute https URI for `type`) and
 * are dereferenceable-by-convention.
 */
import { type ProblemDetails, ProblemDetailsSchema } from "@forumall/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** Stable base for problem `type` URIs (must be https per the shared schema). */
export const PROBLEM_TYPE_BASE = "https://ofscp.org/problems";

/**
 * OFSCP §7.3 status table → canonical title + machine `errorCode`. Keyed by the
 * stable slug used in the problem `type` URI.
 */
export const PROBLEM_STATUS = {
  badRequest: { status: 400, title: "Bad Request", errorCode: "bad_request" },
  unauthorized: { status: 401, title: "Unauthorized", errorCode: "unauthorized" },
  forbidden: { status: 403, title: "Forbidden", errorCode: "forbidden" },
  notFound: { status: 404, title: "Not Found", errorCode: "not_found" },
  conflict: { status: 409, title: "Conflict", errorCode: "conflict" },
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
  { status: ContentfulStatusCode; title: string; errorCode: string }
>;

export type ProblemSlug = keyof typeof PROBLEM_STATUS;

/** Mint the conventional `type` URI for a problem slug. */
export function problemType(slug: ProblemSlug): string {
  return `${PROBLEM_TYPE_BASE}/${PROBLEM_STATUS[slug].errorCode}`;
}

export interface AppErrorOptions {
  /** Optional human-readable detail, safe to expose to the caller. */
  detail?: string;
  /** Optional URI reference identifying the specific occurrence. */
  instance?: string;
  /** Override the machine `errorCode` (defaults to the slug's code). */
  errorCode?: string;
  /** Extra members merged into the problem document. */
  extensions?: Record<string, unknown>;
  /** Underlying cause (logged, never serialized). */
  cause?: unknown;
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

  constructor(slug: ProblemSlug, opts: AppErrorOptions = {}) {
    const entry = PROBLEM_STATUS[slug];
    super(opts.detail ?? entry.title, { cause: opts.cause });
    this.name = "AppError";
    this.slug = slug;
    this.status = entry.status;
    this.title = entry.title;
    this.errorCode = opts.errorCode ?? entry.errorCode;
    this.detail = opts.detail;
    this.instance = opts.instance;
    this.extensions = opts.extensions;
  }

  /** Render this error as a validated {@link ProblemDetails} document. */
  toProblem(): ProblemDetails {
    return ProblemDetailsSchema.parse({
      type: problemType(this.slug),
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

/** Build a Hono `Response` carrying a problem+json body. */
export function problemResponse(c: Context, problem: ProblemDetails): Response {
  return c.json(problem, problem.status as ContentfulStatusCode, {
    "content-type": PROBLEM_CONTENT_TYPE,
  });
}

/**
 * Hono `onError` handler. Renders {@link AppError} faithfully; any other thrown
 * value becomes a generic 500 with no internal detail leaked to the client
 * (the real error is logged server-side).
 */
export function onError(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    if (err.status >= 500) console.error("[server] AppError:", err);
    return problemResponse(c, err.toProblem());
  }

  // Unknown/unexpected error: log everything, expose nothing.
  console.error("[server] Unhandled error:", err);
  const problem = ProblemDetailsSchema.parse({
    type: problemType("internal"),
    title: PROBLEM_STATUS.internal.title,
    status: PROBLEM_STATUS.internal.status,
    errorCode: PROBLEM_STATUS.internal.errorCode,
  });
  return problemResponse(c, problem);
}

/** Hono `notFound` handler. Renders a 404 problem+json document. */
export function notFound(c: Context): Response {
  return problemResponse(c, new AppError("notFound").toProblem());
}
