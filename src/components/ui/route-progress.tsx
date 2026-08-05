"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * A thin progress bar across the top of the app while a navigation is in flight.
 *
 * Every page here is dynamic — it authenticates, resolves the farm, and queries under
 * RLS before it can render a byte. On a farm's connection that is a real wait, and
 * until now nothing on screen acknowledged the tap: the old page just sat there looking
 * ignored, so people pressed again.
 *
 * Deliberately driven by anchor clicks rather than `useLinkStatus`, because that hook
 * only reports for the one `<Link>` it lives inside — this has to cover every link on
 * every screen, plus the ones rendered by server components.
 *
 * The bar creeps towards 90% and never reaches it on its own: it is an honest "still
 * working", not a fake ETA. It completes only when the route actually changes.
 */
export function RouteProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [active, setActive] = useState(false);
  const [width, setWidth] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Finish whenever the rendered route changes — that is the only trustworthy signal
  // that the new page has actually arrived.
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
  }, [pathname, search]);

  useEffect(() => {
    function start() {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setActive(true);
      setWidth(8);
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(() => {
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
