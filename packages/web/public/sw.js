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

// --- Web Push --------------------------------------------------------------
// A push arrives as an encrypted JSON payload (RFC 8291); show it as an OS/
// browser notification. The payload shape is `{title, body, tag, data:{targetUrl}}`.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || "Forumall";
  const options = {
    body: payload.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.tag || undefined,
    data: payload.data || {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking a notification focuses an open Forumall tab (routing it to the
// target) or opens a new window at the target URL.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.targetUrl || "/";
  const absolute = new URL(targetUrl, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        // Reuse an existing same-origin tab: navigate it and focus.
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          if ("navigate" in client) client.navigate(absolute).catch(() => undefined);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(absolute);
      return undefined;
    }),
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
