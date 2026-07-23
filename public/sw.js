/*
 * FleetWise service worker — hand-rolled, no dependencies.
 *
 * Strategy:
 *   - Immutable build assets (/_next/static, /icon.svg): cache-first.
 *   - Navigations (HTML): network-first, falling back to the last cached view of that
 *     URL, then to the /offline page. This lets the app open and render the last-viewed
 *     data with the network disabled.
 *   - Other same-origin GETs (JSON/images): stale-while-revalidate.
 *   - Never touches POST or /api/* — mutations flow through the IndexedDB sync queue.
 */
const VERSION = "fleetwise-v1";
const SHELL_CACHE = VERSION + "-shell";
const DATA_CACHE = VERSION + "-data";
const SHELL_ASSETS = ["/offline", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Tolerate individual precache misses (e.g. a 404 in an odd build) — never fail install.
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => undefined),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirstNav(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const offline = await caches.match("/offline");
    if (offline) return offline;
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  return cached || (await network) || new Response("", { status: 504, statusText: "offline" });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // mutations never go through the cache
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // same-origin only
  if (url.pathname.startsWith("/api/")) return; // dynamic; network only
  if (url.pathname.startsWith("/auth/")) return; // auth flows; network only

  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/icon.svg") {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNav(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
});
