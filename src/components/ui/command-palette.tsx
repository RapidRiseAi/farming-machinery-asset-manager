"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "./cn";
import { Overlay } from "./dialog";
import { Icon, SearchIcon, type IconName } from "./icons";
import type { NavGroup } from "./nav";

/**
 * Ctrl/⌘+K — one place to type where you want to go.
 *
 * The nav is twenty-four rows for an owner and twenty-four for a books-tier
 * partner, grouped but long, and finding "VAT" means reading past fifteen other
 * money words. A palette is the convention people already know from every
 * editor and most SaaS, so it needs no teaching.
 *
 * It is handed the SAME `groups` the sidebar renders, computed on the server
 * behind the role and entitlement checks. That matters: the palette introduces
 * no second idea of what a person may reach, so it cannot drift out of step
 * with the sidebar or expose a destination the role does not have.
 *
 * Hand-rolled rather than a combobox dependency, per Scope §7 — the bundle is
 * 103 kB and the interaction is a list and two arrow keys.
 */

export type CommandLabels = {
  /** Placeholder in the input. */
  placeholder: string;
  /** Accessible name for the dialog. */
  title: string;
  /** Shown when nothing matches. */
  empty: string;
  /** Visible trigger text, e.g. "Search". */
  trigger: string;
  /** "to select" / "to close" hints. */
  hintSelect: string;
  hintClose: string;
  /** Screen-reader result count, `{n}` replaced. */
  results: string;
};

type Entry = { href: string; label: string; icon: IconName; group: string };

/**
 * Fold case and strip diacritics so an Afrikaans label matches what a person
 * types on an English keyboard — "bestellings" should find "Bestellings" and
 * "instelling" should find "Instellings" without the reader knowing about
 * combining marks.
 */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/**
 * Substring match, ranked. Deliberately NOT fuzzy: a fuzzy matcher puts
 * "Corrections" above "Cash flow" for the query "c f" and the person cannot
 * tell why. Word-start beats mid-word, label beats group name.
 */
function rank(entry: Entry, q: string): number {
  const label = fold(entry.label);
  const group = fold(entry.group);
  if (!q) return 0;
  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(label)) return 60;
  if (label.includes(q)) return 40;
  if (group.startsWith(q) || group.includes(q)) return 20;
  return -1;
}

export function CommandPalette({
  groups,
  labels,
}: {
  groups: NavGroup[];
  labels: CommandLabels;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const entries = useMemo<Entry[]>(
    () =>
      groups.flatMap((g) =>
        g.items.map((i) => ({ href: i.href, label: i.label, icon: i.icon, group: g.label })),
      ),
    [groups],
  );

  const results = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return entries;
    return entries
      .map((e) => ({ e, r: rank(e, q) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => b.r - a.r)
      .map((x) => x.e);
  }, [entries, query]);

  // ⌘K on a Mac, Ctrl+K everywhere else. Read once so the hint and the handler
  // cannot disagree.
  const isMac = useMemo(
    () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || ""),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hit = e.key.toLowerCase() === "k" && (isMac ? e.metaKey : e.ctrlKey);
      if (!hit) return;
      // Only swallow the browser default once we are certain it is our shortcut.
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMac]);

  // Reset each time it opens: a palette that remembers the last query makes the
  // second use feel broken.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, results.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[active];
      if (hit) go(hit.href);
    }
  };

  const shortcut = isMac ? "⌘K" : "Ctrl K";

  return (
    <>
      {/* A shortcut nobody is told about does not exist, so the trigger is
          visible and carries its own key hint. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring hidden min-h-[40px] items-center gap-2 rounded-lg border border-edge-soft bg-surface-sunken px-3 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink lg:inline-flex"
      >
        <SearchIcon className="text-base" />
        <span>{labels.trigger}</span>
        <kbd className="ml-2 rounded border border-edge-soft bg-surface px-1.5 py-0.5 font-sans text-2xs font-semibold text-ink-subtle">
          {shortcut}
        </kbd>
      </button>

      <Overlay
        open={open}
        onClose={() => setOpen(false)}
        align="center"
        labelledBy="command-palette-title"
        panelClassName="max-w-xl"
      >
        <h2 id="command-palette-title" className="sr-only">
          {labels.title}
        </h2>

        <div className="flex items-center gap-2.5 border-b border-edge-soft px-4">
          <SearchIcon className="shrink-0 text-lg text-ink-subtle" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls="command-palette-list"
            aria-activedescendant={results[active] ? `command-option-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={labels.placeholder}
            // 16px minimum: anything smaller makes iOS zoom the whole page on focus.
            className="min-h-[52px] w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-subtle"
          />
        </div>

        <ul
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          aria-label={labels.title}
          className="max-h-[min(60vh,26rem)] overflow-y-auto py-1.5"
        >
          {results.map((r, i) => (
            <li key={r.href} role="none">
              <button
                type="button"
                id={`command-option-${i}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(r.href)}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors",
                  i === active ? "bg-accent-tint text-ink" : "text-ink hover:bg-surface-hover",
                )}
              >
                <Icon
                  name={r.icon}
                  className={cn("shrink-0 text-lg", i === active ? "text-accent-ink" : "text-ink-muted")}
                />
                <span className="flex-1 truncate font-medium">{r.label}</span>
                {/* The group disambiguates the money words: "Reports" under
                    Overview is not "Statements" under Contractor. */}
                <span className="shrink-0 text-xs text-ink-subtle">{r.group}</span>
              </button>
            </li>
          ))}
          {results.length === 0 ? (
            <li role="none" className="px-4 py-8 text-center text-sm text-ink-muted">
              {labels.empty}
            </li>
          ) : null}
        </ul>

        <div className="flex items-center justify-between gap-3 border-t border-edge-soft px-4 py-2.5 text-xs text-ink-subtle">
          <span className="flex items-center gap-3">
            <span>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </span>
            <span>
              {/* The word, not the ↵ glyph: it renders as an empty box in the
                  system font stack, and this product's rule is icon AND word. */}
              <Kbd>Enter</Kbd> {labels.hintSelect}
            </span>
            <span>
              <Kbd>esc</Kbd> {labels.hintClose}
            </span>
          </span>
        </div>

        {/* Announce the count rather than leaving a screen-reader user to arrow
            into silence. */}
        <p aria-live="polite" className="sr-only">
          {labels.results.replace("{n}", String(results.length))}
        </p>
      </Overlay>
    </>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mr-1 inline-flex min-w-[1.35rem] justify-center rounded border border-edge-soft bg-surface-sunken px-1 py-0.5 font-sans text-2xs font-semibold text-ink-muted">
      {children}
    </kbd>
  );
}
