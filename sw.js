// Bump this on every deploy (or automate it — see notes below).
const CACHE_NAME = "tukka-classifier-cache-v3";
const CORE_ASSETS = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apps/english.html",
  "./apps/maths.html",
  "./apps/gk.html",
  "./apps/reasoning.html",
  "./apps/speed-booster.html"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  // Don't auto-skipWaiting here — we let the page decide when to activate
  // the new SW (see the SKIP_WAITING message handler below), so an update
  // never yanks the rug out from under a user mid-session.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Let the page tell a waiting SW to take over immediately.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Network-first for the app shell / any HTML document — this covers the
  // top-level hub (index.html) AND every category app loaded inside its
  // iframe (apps/english.html, apps/maths.html, apps/gk.html, apps/reasoning.html, apps/speed-booster.html),
  // so a new deploy is picked up on next load instead of being served stale.
  // Falls back to cache only when offline.
  const isHTMLRequest =
    req.mode === "navigate" ||
    (req.method === "GET" && url.origin === self.location.origin && url.pathname.endsWith(".html"));

  if (isHTMLRequest) {
    // Strip cache-busting query strings (e.g. "?ts=169...") down to the clean
    // path before falling back to cache, so an offline exam-category switch
    // still resolves to the right cached app page instead of the hub shell.
    const cleanUrl = url.origin + url.pathname;

    event.respondWith(
      fetch(req)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(cleanUrl, clone));
          return response;
        })
        .catch(() =>
          caches.match(cleanUrl).then((cached) => cached || caches.match("./index.html"))
        )
    );
    return;
  }

  if (url.origin === self.location.origin) {
    // Cache-first for other same-origin static assets (icons, manifest).
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
            return response;
          })
          .catch(() => cached);
      })
    );
  } else {
    // CDN requests (Tailwind, Chart.js, fonts): network first, cache fallback.
    event.respondWith(
      fetch(req)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return response;
        })
        .catch(() => caches.match(req))
    );
  }
});
