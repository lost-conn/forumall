/**
 * Proves a production default transport is the egress guard, not a bare
 * `fetch`: while `run` executes, the global `fetch` is replaced by a recorder
 * that answers every request with `respond()` (a success), so an unguarded
 * transport reaches it and the caller sees a delivery, while the guard refuses
 * its target (`http`, a non-public literal) before calling the global `fetch`
 * at all. Restored afterwards whatever `run` does.
 */
export async function withRecordingGlobalFetch<T>(
  respond: () => Response,
  run: () => Promise<T>,
): Promise<{ result: T; urls: string[] }> {
  const urls: string[] = [];
  const original = globalThis.fetch;
  const recorder = async (input: string | URL | Request): Promise<Response> => {
    urls.push(input instanceof Request ? input.url : String(input));
    return respond();
  };
  globalThis.fetch = Object.assign(recorder, { preconnect: original.preconnect });
  try {
    return { result: await run(), urls };
  } finally {
    globalThis.fetch = original;
  }
}
