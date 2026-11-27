/**
 * Checked array indexing for tests. Under `noUncheckedIndexedAccess`, `xs[i]`
 * is `T | undefined`; `at(xs, i)` fails the test loudly instead of letting an
 * `undefined` flow into an assertion (or hiding it behind a cast).
 */
export function at<T>(xs: readonly T[], i: number): T {
  if (!Number.isInteger(i) || i < 0 || i >= xs.length) {
    throw new Error(`index ${i} out of range (length ${xs.length})`);
  }
  return xs[i] as T;
}
