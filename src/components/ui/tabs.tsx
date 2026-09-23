"use client";

import { useId, useRef, useState, type ReactNode } from "react";
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
  className?: string;
};

/**
 * Accessible tabs (roving focus, arrow-key nav). Client component, uncontrolled.
 */
export function Tabs({ tabs, defaultTab, className }: TabsProps) {
  const baseId = useId();
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.key);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

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
    setActive(key);
    refs.current[key]?.focus();
  };

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        /*
          Scrolls sideways rather than forcing the PAGE wider. Five tabs at their
          natural width come to 415px, and when content cannot fit Chrome does not
          add a scrollbar, it widens the layout viewport and renders the whole page
          zoomed out. Measured on /machines/[id] at 360px: innerWidth 415, no
          scrollbar, nothing to notice, just smaller text everywhere.

          `shrink-0` on the buttons is the other half: without it flex would squeeze
          the labels instead of scrolling, and "Papers & licence" would wrap to two
          lines inside a 48px-tall tab.

          The scrollbar is hidden because the cut-off tab at the edge IS the
          affordance here, and a horizontal scrollbar under a tab strip reads as
          broken chrome. This is the one place that argument beats ScrollArea's.
        */
        className={cn(
          "flex gap-1 overflow-x-auto border-b border-sand-200",
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
              onClick={() => setActive(t.key)}
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
          hidden={t.key !== active}
          tabIndex={0}
          className="focus-ring pt-4"
        >
          {t.key === active ? t.content : null}
        </div>
      ))}
    </div>
  );
}
