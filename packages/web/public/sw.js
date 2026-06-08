/**
 * Forumall service worker — minimal, update-safe, just enough to make the client
 * an installable PWA with an offline app shell.
 *
 * Strategy:
 *  - Navigations (the SPA shell) are **network-first** so a fresh deploy always
 *    loads when online, falling back to the cached shell when offline.
 *  - Hashed build assets (`/assets/*`, content-hashed by Vite → immutable) are
 *    **cache-first**.
 *  - The signed OFSCP API (`/api/*`, `/.well-known/*`) and all cross-origin
 *    requests (federation peers, fonts, media CDNs, WebSocket) are NEVER touched
 *    — they must hit the network so signatures and real-time work.
 */
const CACHE = "forumall-v1";
const SHELL = "/index.html";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", SHELL]).catch(() => undefined)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // federation / fonts / media / WS
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.well-known/")) return;

  // App navigations: network-first, fall back to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(SHELL, copy));
          return res;
        })
        .catch(() => caches.match(SHELL).then((r) => r ?? caches.match("/"))),
    );
    return;
  }

  // Immutable, content-hashed build assets: cache-first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
  }
});
