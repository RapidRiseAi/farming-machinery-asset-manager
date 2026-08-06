"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * A thin progress bar across the top of the app while a navigation is in flight.
 *
 * Every page here is dynamic — it authenticates, resolves the farm, and queries under
 * RLS before it can render a byte. On a farm's connection that is a real wait, and
 * nothing on screen acknowledged the tap: the old page just sat there looking ignored,
 * so people pressed again.
 *
 * Deliberately driven by anchor clicks rather than `useLinkStatus`, because that hook
 * only reports for the one `<Link>` it lives inside — this has to cover every link on
 * every screen, plus the ones rendered by server components.
 *
 * The bar creeps towards 90% and never reaches it on its own: it is an honest "still
 * working", not a fake ETA. It completes only when the route actually changes.
 *
 * ── Why this does NOT call useSearchParams ──────────────────────────────────
 *
 * It used to, to notice a query-only navigation (a filter chip writing `?type=tractor`
 * on the same path). That single hook froze the product.
 *
 * This component is mounted in the ROOT layout, so subscribing it to the search-params
 * context put every page under that subscription. After a server action called
 * `redirect()` — which almost always lands on the same path with a new query: `?saved=1`,
 * `?added=1`, `?error=…` — the router fetched the new RSC payload, the payload arrived
 * complete and on time (verified: 200, ~52 KB, under a second), and then the transition
 * never committed. The screen sat on its loading skeleton indefinitely — still stuck at
 * 40 seconds.
 *
 * Measured at 9 stuck out of 10 attempts, and on the pre-existing work-request page just
 * as much as on new ones — so EVERY server action in the product could leave someone
 * staring at a frozen screen.
 *
 * The usual remedy for `useSearchParams` is a `<Suspense>` boundary, and the root layout
 * ALREADY had one around this component. It froze anyway; re-measured with the boundary
 * in place, it was still 1 stuck in 4. Only dropping the subscription fixed it: 0 in 12,
 * across the new documents pages and the pre-existing work-request page alike. The
 * boundary has since been removed from the layout, because with no hook left to suspend
 * on it guarded nothing and implied a protection it was not providing.
 *
 * (It is also the most likely explanation for the earlier, never-established report of a
 * same-route `router.push` that appeared not to navigate. Same shape, same cause.)
 *
 * Completion now comes from `usePathname()` — which cannot suspend — plus a hard stop
 * after eight seconds so an abandoned navigation cannot leave the bar creeping forever.
 * A progress bar that never finishes is worse than none.
 *
 * A query-only navigation (a filter chip) therefore rides the hard stop rather than
 * finishing exactly on arrival. That is deliberate. The obvious improvement — sampling
 * `window.location.href` from the tick and finishing the moment it changes — was built
 * and measured, and it brought the freeze straight back (4 stuck out of 4): setting
 * state in a root-layout component while the router transition is still committing is
 * the same class of mistake as subscribing to the params context. Nothing in this
 * component may touch state during a pending navigation. A bar that lingers a few
 * seconds on a filter change is a very small price for a product that never freezes.
 */
const MAX_VISIBLE_MS = 8_000;

export function RouteProgress() {
  const pathname = usePathname();
  const [active, setActive] = useState(false);
  const [width, setWidth] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAt = useRef(0);

  // Finish whenever the rendered path changes — the clearest signal the page arrived.
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setWidth(100);
    hideTimer.current = setTimeout(() => {
      setActive(false);
      setWidth(0);
    }, 220);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [pathname]);

  useEffect(() => {
    function finish() {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      setWidth(100);
      hideTimer.current = setTimeout(() => {
        setActive(false);
        setWidth(0);
      }, 220);
    }

    function start() {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      startedAt.current = Date.now();
      setActive(true);
      setWidth(8);
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(() => {
        // Abandoned, or slower than anyone will wait for. Stop pretending.
        if (Date.now() - startedAt.current > MAX_VISIBLE_MS) {
          finish();
          return;
        }
        // Ease off as it climbs, so a slow page still looks like it is moving.
        setWidth((w) => (w >= 90 ? w : w + Math.max(0.6, (90 - w) / 14)));
      }, 120);
    }

    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const el = (e.target as HTMLElement | null)?.closest?.("a");
      if (!(el instanceof HTMLAnchorElement)) return;
      if (el.target && el.target !== "_self") return;
      if (el.hasAttribute("download")) return;
      const href = el.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("http")) return;
      // Same page (a jump link or a no-op) — nothing is loading.
      const url = new URL(el.href, window.location.href);
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      start();
    }

    // A server-action form post is the other thing that leaves the screen still.
    function onSubmit(e: SubmitEvent) {
      if (e.defaultPrevented) return;
      start();
    }

    document.addEventListener("click", onClick, { capture: true });
    document.addEventListener("submit", onSubmit, { capture: true });
    return () => {
      document.removeEventListener("click", onClick, { capture: true } as EventListenerOptions);
      document.removeEventListener("submit", onSubmit, { capture: true } as EventListenerOptions);
      if (timer.current) clearInterval(timer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  if (!active) return null;

  return (
    <div
      // Decorative: the page's own loading skeleton is what a screen reader should
      // announce, and two "loading" announcements per navigation is one too many.
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5"
    >
      <div
        className="h-full bg-brand-500 shadow-[0_0_8px_rgba(22,101,52,0.5)] transition-[width] duration-200 ease-out"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
