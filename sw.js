// Bump this on every deploy (or automate it — see notes below).
const CACHE_NAME = "tukka-classifier-cache-v4";
const CORE_ASSETS = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./share-target.html",
  "./apps/english.html",
  "./apps/maths.html",
  "./apps/gk.html",
  "./apps/reasoning.html",
  "./apps/speed-booster.html"
];

// ---- Share Target support -------------------------------------------------
// Android's Share sheet (e.g. sharing a screenshot straight from Gallery) POSTs
// the file(s) to this URL because manifest.json declares it as a share_target.
// A static site has no server to receive that POST, so the trick is: the
// service worker intercepts the POST itself, stashes the shared file(s) in
// IndexedDB, then hands back a redirect so the browser lands on a normal GET
// navigation of share-target.html — which then reads the stash back out.
const SHARE_DB_NAME = "tukka-share-db";
const SHARE_STORE = "shares";

function openShareDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SHARE_STORE)) {
        req.result.createObjectStore(SHARE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSharedFiles(files) {
  const db = await openShareDB();
  const payload = files.map((f) => ({ blob: f, name: f.name || "shared-image", type: f.type || "image/jpeg" }));
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SHARE_STORE, "readwrite");
    tx.objectStore(SHARE_STORE).put(payload, "pending");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function handleShareTargetPost(request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll("images").filter((f) => f && typeof f === "object" && f.size > 0);
    if (files.length) await saveSharedFiles(files);
  } catch (e) {
    // Fall through — share-target.html will just show "nothing shared" if this failed.
  }
  return Response.redirect("./share-target.html?shared=1", 303);
}

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

  // Intercept the Share Target POST before anything else — it's the only
  // POST this app ever receives, and there's no server to send it to.
  if (req.method === "POST" && url.origin === self.location.origin && url.pathname.endsWith("/share-target.html")) {
    event.respondWith(handleShareTargetPost(req));
    return;
  }

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
