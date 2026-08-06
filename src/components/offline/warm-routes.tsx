"use client";

import { useEffect } from "react";

/**
 * Ask the service worker to keep this person's own screens ready for offline use.
 *
 * The offline story used to be "whatever you happened to visit while you had signal is
 * what you get" — so a farmer who had only ever opened the dashboard found that
 * everything else, tapped in a shed with no bars, showed them the dashboard again. (The
 * worker's fallback list applied to every uncached page, not just a cold launch; that is
 * fixed in sw.js.)
 *
 * The fix has two halves. The worker no longer substitutes a different page for the one
 * asked for. And this component hands it the list of routes the shell has decided this
 * ROLE can reach, so a driver warms the driver's screens, a contractor theirs, and an
 * owner theirs — no hardcoded guess about who is using the app.
 *
 * It also guards the other edge of caching a signed-in page: Cache Storage is
 * origin-wide and keyed by URL alone, so on a shared browser the previous person's
 * cached screens are still sitting there. `contextKey` identifies who is signed in and
 * which farm they have open; when it changes, the worker is told to drop everything it
 * holds before warming again.
 *
 * Deliberately quiet: it runs once, after load, only when a worker is already
 * controlling the page. Nothing here blocks rendering, and on a metered connection it
 * costs one small request per screen, once.
 */
const CONTEXT_KEY = "farmgear:cache-context";

export function WarmRoutes({ paths, contextKey }: { paths: string[]; contextKey: string }) {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (paths.length === 0) return;

    let cancelled = false;
    const send = () => {
      if (cancelled) return;
      /*
       * Cache Storage is ORIGIN-wide and keyed only by URL — there is nothing in a cache
       * key about who was signed in or which farm they had open. On a shared farm-office
       * browser that means a page cached for one person could be served, offline, to the
       * next. So before warming anything, check whether the context changed since last
       * time; if it did, tell the worker to drop everything it holds first.
       */
      let previous: string | null = null;
      try {
        previous = window.localStorage.getItem(CONTEXT_KEY);
        window.localStorage.setItem(CONTEXT_KEY, contextKey);
      } catch {
        /* private mode or storage disabled — fall through and clear, which is the safe
           direction: we would rather re-fetch than serve the wrong person's page. */
      }
      const changed = previous !== contextKey;
      navigator.serviceWorker.controller?.postMessage(
        changed ? { type: "clear-data", paths } : { type: "warm", paths },
      );
    };

    // Wait for a genuine idle moment: warming must never compete with the page the
    // person is actually looking at. requestIdleCallback is not in Safari, so fall back
    // to a plain delay there.
    const canIdle = "requestIdleCallback" in window;
    const idle = canIdle ? window.requestIdleCallback(send, { timeout: 8000 }) : window.setTimeout(send, 4000);

    return () => {
      cancelled = true;
      if (canIdle) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
    // `paths` is derived from the role and is stable for a session; join it so a new
    // array identity on re-render does not re-fire the warm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.join(","), contextKey]);

  return null;
}
