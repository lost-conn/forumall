/**
 * `Retry-After` parsing shared by the provider's outbound federation retry and
 * the web client (OFSCP §4.5 "Restarts": a provider in its replay-store warm-up
 * answers signed requests with `503` + `Retry-After`).
 *
 * Strict on purpose, so a broken or hostile peer/proxy cannot provoke a burst
 * of back-to-back retries:
 *  - Only the two RFC 9110 §10.2.3 forms are accepted: **delta-seconds** (a
 *    non-negative integer, digits only) or an **IMF-fixdate**
 *    (`Sun, 06 Nov 1994 08:49:37 GMT`). Anything else (`-5`, `1.5`, `soon`,
 *    obsolete date formats) is unusable.
 *  - A value that asks for no wait at all — `0`, or a date that is now or in the
 *    past — is also unusable: callers treat "no usable Retry-After" as **do not
 *    retry** (the 503 is returned/surfaced as is).
 *  - A usable wait is never shorter than {@link MIN_RETRY_AFTER_MS} (a future
 *    date less than a second away is rounded up to it).
 */

/** Floor on any honoured wait, ms. */
export const MIN_RETRY_AFTER_MS = 1_000;

/** OFSCP §4.5 timestamp skew window (seconds). */
export const OFSCP_TIMESTAMP_SKEW_SECONDS = 300;

const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header value into a wait in ms from `now`, or `null`
 * when there is no usable value (absent, malformed, zero, or not in the future).
 * A non-null result is always ≥ {@link MIN_RETRY_AFTER_MS}.
 */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) {
    const seconds = Number(v);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
    return seconds * 1000;
  }
  if (!IMF_FIXDATE.test(v)) return null;
  const at = Date.parse(v);
  if (Number.isNaN(at) || at <= now) return null;
  return Math.max(MIN_RETRY_AFTER_MS, at - now);
}
