"use client";

/**
 * Accessible tabs: roving focus, arrow keys, Home/End. Client component.
 *
 *   <Tabs tabs={[{ key: "overview", label, content }, ...]} />                 // uncontrolled
 *   <Tabs param="tab" defaultTab={readTab(sp.tab, keys)} tabs={...} />       // URL-synced
 *
 * Props: `tabs: { key, label, content }[]`, `defaultTab?` (initially selected key,
 * defaults to the first), `param?` (URL sync, see below), `printAll?` (see below),
 * `className?`.
 *
 * == On paper (`printAll`) =====================================================
 * Only the selected panel's content is mounted, so a printed page showed one tab.
 * With `printAll` every panel stays mounted (hidden on screen exactly as before), and
 * in print the strip is dropped and every panel shows, each under its tab's name.
 * Opt-in: it renders the inactive panels' DOM, which a long report pays for.
 *
 * == URL sync (`param`) =======================================================
 * With `param="tab"` the selected tab is written to `?tab=<key>` with
 * `history.replaceState`, which Next 15 folds into its router state without a server
 * round trip or a scroll. A server action that ends in
 * `redirect(withTab("/machines/42?saved=1", "papers"))` therefore lands back on the tab
 * the person was using instead of on Overview. The page reads the param and passes it as
 * `defaultTab` (use `readTab` from `./tabs-url`, which rejects unknown keys), and when
 * that prop changes on a soft navigation the strip follows it. Without `param` nothing
 * touches the URL: the old uncontrolled behaviour, unchanged.
 *
 * `withTab` and `readTab` live in `./tabs-url`, NOT here: a plain function exported
 * from a "use client" module is a client reference, and a server action calling it
 * throws at runtime while tsc and next build both pass.
 *
 * == Off-screen tabs on a phone ================================================
 * Five tabs at their natural width come to 415px on /machines/[id], so the strip
 * scrolls sideways. The selected tab is scrolled into view on arrival and on every
 * change (a page opened on ?tab=papers used to start with its own tab hidden), and the
 * edge that has more tabs beyond it fades out, so a phone user can see there is more.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "./cn";

export type TabItem = {
  key: string;
  label: ReactNode;
  content: ReactNode;
};

export type TabsProps = {
  tabs: TabItem[];
  /** Key of the initially-selected tab. Defaults to the first. */
  defaultTab?: string;
  /**
   * URL search param that mirrors the selected tab (e.g. "tab" for `?tab=papers`).
   * Absent: the tabs never touch the URL.
   */
  param?: string;
  /** Keep every panel mounted and print all of them, each under its label. */
  printAll?: boolean;
  className?: string;
};

/** Width of the edge fade, and the margin kept when scrolling a tab into view. */
const FADE_PX = 28;

export function Tabs({ tabs, defaultTab, param, printAll = false, className }: TabsProps) {
  const baseId = useId();
  const isKey = useCallback((k: string | null | undefined) => !!k && tabs.some((t) => t.key === k), [tabs]);
  const [active, setActive] = useState(isKey(defaultTab) ? defaultTab! : tabs[0]?.key);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  const firstScroll = useRef(true);
  const [edges, setEdges] = useState({ left: false, right: false });

  // A soft navigation (a server action redirecting to ?tab=papers) re-renders this
  // component with a new `defaultTab` but keeps its state, so follow the prop when it
  // actually changes. Only in URL mode: an uncontrolled strip keeps what was clicked.
  const lastDefault = useRef(defaultTab);
  useEffect(() => {
    if (!param || defaultTab === lastDefault.current) return;
    lastDefault.current = defaultTab;
    if (isKey(defaultTab)) setActive(defaultTab!);
  }, [param, defaultTab, isKey]);

  // The page may not have passed the param through as `defaultTab`; honour the URL
  // anyway once hydrated.
  useEffect(() => {
    if (!param) return;
    const fromUrl = new URLSearchParams(window.location.search).get(param);
    if (isKey(fromUrl)) setActive(fromUrl!);
    // Mount only: afterwards the state is the source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (key: string) => {
    setActive(key);
    if (!param) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get(param) === key) return;
    url.searchParams.set(param, key);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };

  // Which edges have tabs hidden beyond them.
  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const left = list.scrollLeft > 1;
    const right = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(list);
    return () => {
      list.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [measure]);

  // Keep the selected tab visible. Scrolls the STRIP only: `scrollIntoView` would also
  // scroll the page, which on arrival yanks a strip below the fold into view.
  useEffect(() => {
    const list = listRef.current;
    const btn = active ? refs.current[active] : null;
    if (!list || !btn) return;
    const left = btn.offsetLeft;
    const right = left + btn.offsetWidth;
    let target: number | null = null;
    if (left - FADE_PX < list.scrollLeft) target = Math.max(0, left - FADE_PX);
    else if (right + FADE_PX > list.scrollLeft + list.clientWidth) target = right + FADE_PX - list.clientWidth;
    if (target != null) {
      list.scrollTo({ left: target, behavior: firstScroll.current ? "auto" : "smooth" });
    }
    firstScroll.current = false;
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.key === active);
    if (i < 0) return;
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    const key = tabs[next].key;
    select(key);
    refs.current[key]?.focus();
  };

  const mask =
    edges.left || edges.right
      ? `linear-gradient(to right, ${edges.left ? "transparent" : "black"}, black ${FADE_PX}px, black calc(100% - ${FADE_PX}px), ${edges.right ? "transparent" : "black"})`
      : undefined;

  return (
    <div className={className}>
      <div
        ref={listRef}
        role="tablist"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        /*
          Scrolls sideways rather than forcing the PAGE wider. Five tabs at their
          natural width come to 415px, and when content cannot fit Chrome does not
          add a scrollbar, it widens the layout viewport and renders the whole page
          zoomed out. Measured on /machines/[id] at 360px: innerWidth 415, no
          scrollbar, nothing to notice, just smaller text everywhere.

          `shrink-0` on the buttons is the other half: without it flex would squeeze
          the labels instead of scrolling, and "Papers & licence" would wrap to two
          lines inside a 48px-tall tab.

          The scrollbar stays hidden (a horizontal scrollbar under a tab strip reads as
          broken chrome); the faded edge is the affordance instead. `relative` makes the
          strip the tabs' offsetParent, which the scroll-into-view maths relies on.
        */
        className={cn(
          "relative flex gap-1 overflow-x-auto border-b border-sand-200",
          printAll && "print:hidden",
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {tabs.map((t) => {
          const selected = t.key === active;
          return (
            <button
              key={t.key}
              ref={(el) => {
                refs.current[t.key] = el;
              }}
              role="tab"
              type="button"
              id={`${baseId}-tab-${t.key}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${t.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(t.key)}
              className={cn(
                "focus-ring -mb-px min-h-[48px] shrink-0 whitespace-nowrap sm:min-h-[44px] border-b-2 px-3.5 text-sm font-medium transition-colors",
                selected
                  ? "border-brand-600 text-brand-ink"
                  : "border-transparent text-sand-500 hover:text-sand-800",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div
          key={t.key}
          role="tabpanel"
          id={`${baseId}-panel-${t.key}`}
          aria-labelledby={`${baseId}-tab-${t.key}`}
          // With `printAll` an inactive panel is hidden by class rather than by the
          // `hidden` attribute, so `print:block` can show it on paper.
          hidden={printAll ? undefined : t.key !== active}
          tabIndex={0}
          className={cn("focus-ring pt-4", printAll && t.key !== active && "hidden print:block")}
        >
          {printAll ? (
            <>
              <p className="mb-2 hidden text-lg font-semibold text-sand-900 print:block">{t.label}</p>
              {t.content}
            </>
          ) : t.key === active ? (
            t.content
          ) : null}
        </div>
      ))}
    </div>
  );
}
