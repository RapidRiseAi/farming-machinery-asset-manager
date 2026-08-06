"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./cn";

/**
 * A scrollable panel that says so.
 *
 * The sidebar used to hide its long tail behind an "Everything else" disclosure —
 * parts, partners, checklists, fines, settings, admin, install, all one click further
 * away than the rest and invisible until you found the summary. A person who never
 * opened it simply did not know those screens existed.
 *
 * Now everything is listed and the panel scrolls. But a scroll container with nothing
 * below the fold visible is its own kind of hidden, so this adds the two affordances
 * that make scrolling discoverable: a fade at whichever edge has more content, and a
 * visible thin scrollbar (rather than the overlay scrollbar that stays invisible until
 * you are already scrolling).
 *
 * The fades are measured, not assumed — they appear only when there is genuinely more
 * to see, and the bottom one goes away when you reach the end. On a short list, or a
 * tall screen, you see no chrome at all.
 */
export function ScrollArea({
  children,
  className,
  fadeClassName = "from-white",
  label,
}: {
  children: ReactNode;
  className?: string;
  /** Tailwind `from-…` colour, so the fade matches whatever it sits on. */
  fadeClassName?: string;
  /** Accessible name — a scrollable region needs one to be reachable by keyboard. */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(false);
  const [bottom, setBottom] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const overflowing = el.scrollHeight - el.clientHeight > 4;
      setTop(overflowing && el.scrollTop > 4);
      setBottom(overflowing && el.scrollTop < el.scrollHeight - el.clientHeight - 4);
    };

    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // The list changes with the role, the site switcher and the unread badge, and the
    // window changes with the browser chrome — so watch both rather than measuring once.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    window.addEventListener("resize", measure);

    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        // tabIndex 0: a scrollable region must be reachable and operable by keyboard.
        tabIndex={0}
        role="region"
        aria-label={label}
        className={cn(
          "h-full overflow-y-auto overscroll-contain",
          // A visible track beats an overlay scrollbar that only appears once you have
          // already guessed you can scroll.
          "[scrollbar-color:theme(colors.sand.300)_transparent] [scrollbar-width:thin]",
          "[&::-webkit-scrollbar]:w-1.5",
          "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-sand-300",
          "[&::-webkit-scrollbar-track]:bg-transparent",
          className,
        )}
      >
        {children}
      </div>

      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b to-transparent transition-opacity duration-150",
          fadeClassName,
          top ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t to-transparent transition-opacity duration-150",
          fadeClassName,
          bottom ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}
