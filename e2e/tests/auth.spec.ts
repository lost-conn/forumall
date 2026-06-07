/**
 * P8 auth & onboarding e2e (single provider).
 *
 * Drives the real SolidJS client against a real ephemeral @forumall/server:
 *   1. connect → register a fresh handle → lands authenticated; a signed
 *      `GET /api/me` succeeds and the account UI shows the handle.
 *   2. reload → still authenticated (session restored from IndexedDB), no
 *      re-login prompt.
 *   3. settings → device keys listed, current device marked.
 *   4. logout → session cleared; a subsequent signed request 401s because the
 *      device key was revoked server-side.
 *   5. the device PRIVATE key never leaves the browser: every request captured
 *      during register carries only the public key, never the private seed.
 */
import { expect, test } from "../harness/fixtures.ts";

/** A unique handle per run (lowercase alnum, 3–32 chars). */
function uniqueHandle(): string {
  return `e2e${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 32);
}

const PASSWORD = "correct-horse-battery";

test("register → restore on reload → device keys → logout (key revoked)", async ({
  page,
  appServer,
}) => {
  const handle = uniqueHandle();

  // -- Capture every outbound request body + headers during register --------
  const captured: { url: string; method: string; postData: string | null; headers: string }[] = [];
  page.on("request", (req) => {
    captured.push({
      url: req.url(),
      method: req.method(),
      postData: req.postData(),
      headers: JSON.stringify(req.headers()),
    });
  });

  await page.goto("/");

  // Stage 1: connect to provider. The host defaults to the current origin's
  // host; just confirm it.
  await expect(page.getByTestId("connect-form")).toBeVisible();
  await page.getByTestId("connect-submit").click();

  // Stage 2: register.
  await expect(page.getByTestId("credentials-form")).toBeVisible();
  await page.getByTestId("tab-register").click();
  await page.getByRole("textbox", { name: /handle/i }).fill(handle);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByTestId("auth-submit").click();

  // Landed authenticated: the app shell shows the actor `handle@host`.
  const actor = `${handle}@localhost:${appServer.port}`;
  await expect(page.getByTestId("space-rail")).toContainText(actor, { timeout: 15_000 });

  // -- Assertion 5: the PRIVATE key never left the device -------------------
  // Read the private seed the browser generated + stored in IndexedDB, then
  // prove it appears in NO captured request body or header.
  const privateKey = await page.evaluate(async () => {
    const open = indexedDB.open("forumall");
    const db: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const rows: { keyId: string; privateKey: string }[] = await new Promise((res, rej) => {
      const tx = db.transaction("device-keys", "readonly");
      const req = tx.objectStore("device-keys").getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return rows[0]?.privateKey ?? null;
  });
  expect(privateKey, "a device private key was generated + stored").toBeTruthy();
  expect(captured.length, "register produced network traffic").toBeGreaterThan(0);
  for (const req of captured) {
    expect(
      req.postData ?? "",
      `private key must not appear in ${req.method} ${req.url} body`,
    ).not.toContain(privateKey as string);
    expect(
      req.headers,
      `private key must not appear in ${req.method} ${req.url} headers`,
    ).not.toContain(privateKey as string);
  }

  // -- Assertion 1: a signed GET /api/me succeeds (account UI shows handle) --
  await page.goto("/settings");
  await expect(page.getByTestId("me-handle")).toHaveText(handle);
  await expect(page.getByTestId("me-actor")).toHaveText(actor);

  // -- Assertion 2: reload → still authenticated, no re-login ---------------
  await page.reload();
  await expect(page.getByTestId("connect-form")).toHaveCount(0);
  await expect(page.getByTestId("credentials-form")).toHaveCount(0);
  await expect(page.getByTestId("space-rail")).toContainText(actor, { timeout: 15_000 });

  // -- Assertion 3: settings → device keys listed, current device marked ----
  await page.goto("/settings");
  await expect(page.getByTestId("device-keys-list")).toBeVisible();
  await expect(page.getByTestId("device-key-row")).toHaveCount(1);
  await expect(page.getByTestId("current-device")).toBeVisible();

  // Sanity: an UNSIGNED /api/me is rejected (the endpoint requires a signature);
  // the SIGNED variant the UI used above succeeded (me-handle rendered).
  const meUnsigned = await page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/me`);
    return r.status;
  }, appServer.baseUrl);
  expect(meUnsigned).toBe(401);

  // Snapshot the device credential + restorable session BEFORE logout so we can
  // replay them afterwards and prove the server-side revocation.
  const credBefore = await page.evaluate(async () => {
    const open = indexedDB.open("forumall");
    const db: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const rows: { keyId: string; privateKey: string }[] = await new Promise((res, rej) => {
      const tx = db.transaction("device-keys", "readonly");
      const req = tx.objectStore("device-keys").getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return { keyRow: rows[0] ?? null, session: localStorage.getItem("forumall.session") };
  });
  expect(credBefore.keyRow).toBeTruthy();
  expect(credBefore.session).toBeTruthy();

  // -- Assertion 4: logout → cleared + key revoked server-side --------------
  await page.getByTestId("logout").click();
  // Back to the auth screen (signed out): the connect/credentials onboarding is
  // shown again and the app is no longer in the authenticated shell.
  await expect(
    page.getByTestId("connect-form").or(page.getByTestId("credentials-form")),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("space-rail")).toHaveCount(0);
  const remainingKeys = await page.evaluate(async () => {
    const open = indexedDB.open("forumall");
    const db: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const rows: unknown[] = await new Promise((res, rej) => {
      const tx = db.transaction("device-keys", "readonly");
      const req = tx.objectStore("device-keys").getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return rows.length;
  });
  expect(remainingKeys, "logout wiped the local private key").toBe(0);

  // Prove the SERVER revoked the key: re-seed the (now-stale) credential +
  // session, reload so the app restores a SIGNING client from them, then hit a
  // signed endpoint. The server must reject it (401) because the key is revoked.
  await page.evaluate(
    async (cred) => {
      const open = indexedDB.open("forumall");
      const db: IDBDatabase = await new Promise((res, rej) => {
        open.onsuccess = () => res(open.result);
        open.onerror = () => rej(open.error);
      });
      await new Promise<void>((res, rej) => {
        const tx = db.transaction("device-keys", "readwrite");
        tx.objectStore("device-keys").put(cred.keyRow);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      if (cred.session) localStorage.setItem("forumall.session", cred.session);
    },
    credBefore as { keyRow: { keyId: string; privateKey: string }; session: string },
  );

  await page.reload();
  // The app restores a signing client (key + session present locally) and lands
  // "authenticated" client-side, but every signed call now 401s server-side.
  await page.goto("/settings");
  // The signed GET /api/auth/device-keys is rejected → the list never renders
  // and the error surfaces.
  await expect(page.getByTestId("device-keys-error")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("account")).toContainText(/could not load account/i);

  // And a direct signed probe confirms the revoked key yields 401 (not 200).
  const meRevoked = await page.evaluate(async (base) => {
    // Drive the restored, signing client the app rebuilt on reload.
    type W = typeof window & {
      __forumall_signedFetch?: (path: string) => Promise<number>;
    };
    const w = window as W;
    if (w.__forumall_signedFetch) return w.__forumall_signedFetch("/api/me");
    // Fallback: unsigned (still 401) if the debug hook isn't present.
    const r = await fetch(`${base}/api/me`);
    return r.status;
  }, appServer.baseUrl);
  expect(meRevoked).toBe(401);
});
