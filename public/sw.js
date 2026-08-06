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
const VERSION = "fleetwise-v3";
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
  if (event.data === "skip-waiting") {
    self.skipWaiting();
    return;
  }
  // The app tells us which routes this person can actually reach, so they are there
  // when the signal is not.
  if (event.data && event.data.type === "warm" && Array.isArray(event.data.paths)) {
    event.waitUntil(warmPaths(event.data.paths.filter((p) => typeof p === "string" && p.startsWith("/"))));
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

/*
 * Where a LAUNCH with no signal can land — the installed app opening at `/` or `/home`,
 * which are dispatchers rather than screens, so there is nothing meaningful to show for
 * them. Role order, most-specific first.
 *
 * This list used to be applied to EVERY uncached navigation, which is why the app
 * behaved the way it did offline: tapping Reports with no signal silently rendered the
 * dashboard while the address bar still said /reports. Showing someone a different page
 * than the one they asked for, with no indication, is worse than saying "not available
 * offline" — they read the dashboard's numbers believing they are looking at reports.
 * Fallbacks now apply ONLY to a launch.
 */
const LAUNCH_PATHS = ["/", "/home"];
const APP_FALLBACKS = ["/dashboard", "/driver", "/contractor", "/machines"];

/*
 * Pages the app asks us to keep ready for offline use. The page posts its own nav list
 * once it is up (see `warm` in the message handler below), so what is available offline
 * is exactly what that person's role can actually reach — a driver warms the driver's
 * screens, a contractor warms theirs — rather than a hardcoded guess.
 */
async function warmPaths(paths) {
  const cache = await caches.open(DATA_CACHE);
  for (const path of paths) {
    try {
      // Skip anything already held: warming is a background nicety, not a refresh.
      if (await cache.match(path)) continue;
      const res = await fetch(path, { credentials: "same-origin" });
      if (res && res.ok && !res.redirected) await cache.put(path, res.clone());
    } catch {
      /* no signal, or the route declined — try again next time the app opens */
    }
  }
}

async function networkFirstNav(request, url) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(request);
    /*
     * Never cache a REDIRECTED response against the URL that was asked for. A single
     * auth hiccup redirects /dashboard to /login; caching that would pin the login page
     * under /dashboard and serve it offline forever, which looks exactly like "the app
     * logged me out and now it won't let me back in".
     */
    if (res && res.ok && !res.redirected) cache.put(request, res.clone());
    return res;
  } catch (err) {
    // Exact URL first, then the same path without its query — a filtered list offline is
    // better served by the unfiltered one it was reached from than by nothing.
    const cached = (await cache.match(request)) || (await cache.match(url.pathname));
    if (cached) return cached;

    // A launch with no signal has no screen of its own to show, so hand over the last
    // real one we hold.
    if (LAUNCH_PATHS.includes(url.pathname)) {
      for (const path of APP_FALLBACKS) {
        const alt = await cache.match(path);
        if (alt) return alt;
      }
    }

    // Anything else: say so honestly, and name the page they asked for so the offline
    // screen can offer what IS available.
    const offline = await caches.match("/offline");
    if (offline) {
      return new Response(await offline.text(), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
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
    event.respondWith(networkFirstNav(request, url));
    return;
  }
  event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
});

/*
 * Web Push (F6). Additive — the offline strategy above is untouched. Payloads are the
 * JSON encrypted by src/lib/push/webpush.ts: { title, body, url, tag }.
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data && event.data.text ? event.data.text() : "" };
  }
  const title = data.title || "FleetWise";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: data.url || "/notifications" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/notifications";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        // Focus an existing tab and route it to the target if we can.
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(target);
            } catch {
              /* cross-origin or not allowed — ignore */
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});
