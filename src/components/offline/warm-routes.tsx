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
 * Deliberately quiet: it runs once, after load, only when a worker is already
 * controlling the page, and the worker skips anything it already holds. Nothing here
 * blocks rendering, and on a metered connection it costs one small request per screen,
 * once.
 */
export function WarmRoutes({ paths }: { paths: string[] }) {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (paths.length === 0) return;

    let cancelled = false;
    const send = () => {
      if (cancelled) return;
      navigator.serviceWorker.controller?.postMessage({ type: "warm", paths });
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
  }, [paths.join(",")]);

  return null;
}
