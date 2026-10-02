"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "./cn";
import { Overlay } from "./dialog";
import { Icon, SearchIcon, MachinesIcon, type IconName } from "./icons";
import type { NavGroup } from "./nav";
import { INSTALL_HREF, useStandalone } from "./use-standalone";

/**
 * Ctrl/⌘+K, one place to type where you want to go.
 *
 * The nav is twenty-one rows for an owner and twenty-four for a books-tier
 * partner, grouped but long, and finding "VAT" means reading past fifteen other
 * money words. A palette is the convention people already know from every
 * editor and most SaaS, so it needs no teaching.
 *
 * It is handed the SAME `groups` the sidebar renders, computed on the server
 * behind the role and entitlement checks. That matters: the palette introduces
 * no second idea of what a person may reach, so it cannot drift out of step
 * with the sidebar or expose a destination the role does not have.
 *
 * MACHINES are searched live against `/api/machines/search`, which reads through
 * the request-scoped client so RLS is the access control there too. Typing a
 * nickname or a registration and landing on the machine is the thing somebody in
 * a workshop actually wants; walking the nav to /machines and filtering is not.
 *
 * Hand-rolled rather than a combobox dependency, per Scope §7, the bundle is
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
  /** Section headings. */
  pages: string;
  machines: string;
  /** Shown while the machine lookup is in flight. */
  searching: string;
  /** Heading for what this person opened from here lately. */
  recent?: string;
  /** Heading for the quick actions ("Do something"). */
  actions?: string;
};

/** A verb the palette offers, linking to the screen that holds it. */
export type CommandAction = { href: string; label: string; icon: IconName };

/** Asks the one mounted palette to open, from any trigger anywhere in the shell. */
const OPEN_EVENT = "fleetwise:open-search";

type Row = {
  kind: "page" | "machine" | "recent" | "action";
  key: string;
  href: string;
  label: string;
  icon: IconName;
  /** Right-hand context: the nav group, or a machine's make and registration. */
  meta: string;
};

type MachineHit = {
  id: string;
  name: string;
  make: string | null;
  model: string | null;
  reg_no: string | null;
  status: string | null;
};

/**
 * Fold case and strip diacritics so an Afrikaans label matches what a person
 * types on an English keyboard, "bestellings" should find "Bestellings" and
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
function rank(label: string, meta: string, q: string): number {
  const l = fold(label);
  const m = fold(meta);
  if (!q) return 0;
  if (l === q) return 100;
  if (l.startsWith(q)) return 80;
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(l)) return 60;
  if (l.includes(q)) return 40;
  if (m.startsWith(q) || m.includes(q)) return 20;
  return -1;
}

/**
 * Recently opened, per PERSON (keyed by profile id, so a shared workshop tablet does not
 * show the mechanic's machines to the next driver) and per device. localStorage because
 * it is a convenience that must cost no write and no migration; every access is wrapped
 * because storage throws outright in a private window with site data blocked.
 */
const RECENT_MAX = 5;
type StoredRecent = { href: string; label: string; icon: IconName; meta: string; from: "page" | "machine" };

function readRecents(key: string | null): StoredRecent[] {
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((r): r is StoredRecent => !!r && typeof r.href === "string" && typeof r.label === "string")
      : [];
  } catch {
    return [];
  }
}

function writeRecent(key: string | null, row: StoredRecent) {
  if (!key) return;
  try {
    const next = [row, ...readRecents(key).filter((r) => r.href !== row.href)].slice(0, RECENT_MAX);
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* storage blocked or full: recents are a convenience, never a requirement */
  }
}

/** True when focus is somewhere typing a "/" means a slash, not "open search". */
function typingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function CommandPalette({
  groups,
  labels,
  actions = [],
  userId,
}: {
  groups: NavGroup[];
  labels: CommandLabels;
  /** Quick verbs for this role (report a fault, log diesel, add a machine). */
  actions?: CommandAction[];
  /** Keys the recent list per person. Omit to remember nothing. */
  userId?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [machines, setMachines] = useState<MachineHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [recents, setRecents] = useState<StoredRecent[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const standalone = useStandalone();
  const recentKey = userId ? `fw:palette-recent:${userId}` : null;

  const pages = useMemo<Row[]>(
    () =>
      groups.flatMap((g) =>
        g.items
          .filter((i) => !(standalone && i.href === INSTALL_HREF))
          .map((i) => ({
            kind: "page" as const,
            key: "page:" + i.href,
            href: i.href,
            label: i.label,
            icon: i.icon,
            meta: g.label,
          })),
      ),
    [groups, standalone],
  );

  const actionRows = useMemo<Row[]>(
    () =>
      actions.map((a) => ({
        kind: "action" as const,
        key: "action:" + a.href,
        href: a.href,
        label: a.label,
        icon: a.icon,
        meta: "",
      })),
    [actions],
  );

  // Recent pages are re-labelled from today's catalogue, so a language switch or a
  // role change can neither show a stale label nor offer a page this role lost.
  const recentRows = useMemo<Row[]>(() => {
    const byHref = new Map(pages.map((p) => [p.href, p]));
    return recents.flatMap((r): Row[] => {
      if (r.from === "page") {
        const p = byHref.get(r.href);
        return p ? [{ ...p, kind: "recent", key: "recent:" + r.href }] : [];
      }
      return [{ kind: "recent", key: "recent:" + r.href, href: r.href, label: r.label, icon: "machines", meta: r.meta }];
    });
  }, [recents, pages]);

  const pageRows = useMemo(() => {
    const q = fold(query.trim());
    // Nothing typed: what you opened lately, then the verbs, then every page.
    if (!q) return [...recentRows, ...actionRows, ...pages];
    // Ranked per kind and kept together, so each heading shows once.
    const ranked = (list: Row[]) =>
      list
        .map((r) => ({ r, s: rank(r.label, r.meta, q) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.r);
    return [...ranked(actionRows), ...ranked(pages)];
  }, [pages, actionRows, recentRows, query]);

  const machineRows = useMemo<Row[]>(
    () =>
      machines.map((m) => ({
        kind: "machine" as const,
        key: "machine:" + m.id,
        href: `/machines/${m.id}`,
        label: m.name,
        icon: "machines" as IconName,
        meta: [m.make, m.model, m.reg_no].filter(Boolean).join(" · "),
      })),
    [machines],
  );

  // One flat list so the arrow keys cross the section boundary without the
  // person having to know there is one.
  const rows = useMemo(() => [...pageRows, ...machineRows], [pageRows, machineRows]);

  // ⌘K on a Mac, Ctrl+K everywhere else. Read once so the hint and the handler
  // cannot disagree.
  const isMac = useMemo(
    () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || ""),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // "/" opens search, the convention of most sites with one, but never while the
      // person is typing in a field, where a slash is just a slash.
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typingInField(e.target)) {
        e.preventDefault();
        setOpen(true);
        return;
      }
      const hit = e.key.toLowerCase() === "k" && (isMac ? e.metaKey : e.ctrlKey);
      if (!hit) return;
      // Only swallow the browser default once we are certain it is our shortcut.
      e.preventDefault();
      setOpen((v) => !v);
    };
    // Other triggers (the phone header's search button) ask this one instance to open,
    // so there is never a second palette with a second Ctrl+K listener.
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, [isMac]);

  // Reset each time it opens: a palette that remembers the last query makes the
  // second use feel broken.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setMachines([]);
    setRecents(readRecents(recentKey));
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, recentKey]);

  useEffect(() => setActive(0), [query]);

  /**
   * Machine lookup, debounced and abortable.
   *
   * The abort matters for correctness, not just politeness: typing "joh" fires
   * three requests and without cancelling them the answer for "jo" can land
   * after the answer for "joh" and overwrite it. Every in-flight request is
   * dropped the moment the query moves on.
   */
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) {
      setMachines([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      fetch(`/api/machines/search?q=${encodeURIComponent(q)}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      })
        .then((r) => (r.ok ? r.json() : { machines: [] }))
        .then((d: { machines?: MachineHit[] }) => setMachines(d.machines ?? []))
        .catch(() => {
          /* aborted, or offline, the pages above still work */
        })
        .finally(() => setSearching(false));
    }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, open]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, rows.length]);

  const go = useCallback(
    (row: Row) => {
      setOpen(false);
      // Pages and machines are remembered; a verb is a shortcut, not a place you went.
      if (row.kind !== "action") {
        const from = row.kind === "machine" || row.href.startsWith("/machines/") ? "machine" : "page";
        writeRecent(recentKey, { href: row.href, label: row.label, icon: row.icon, meta: row.meta, from });
      }
      router.push(row.href);
    },
    [router, recentKey],
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (rows.length ? (i + 1) % rows.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, rows.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = rows[active];
      if (hit) go(hit);
    }
  };

  const shortcut = isMac ? "⌘K" : "Ctrl K";

  return (
    <>
      {/* A shortcut nobody is told about does not exist, so the trigger is
          visible and carries its own key hint. It reads as a search field (and says
          what it finds) because a small "Search" chip in an empty bar undersold it. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="focus-ring hidden min-h-[40px] w-full max-w-md items-center gap-2 rounded-lg border border-edge-soft bg-surface-sunken px-3 text-left text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink lg:inline-flex"
      >
        <SearchIcon className="shrink-0 text-base" />
        <span className="min-w-0 flex-1 truncate">{labels.placeholder}</span>
        <kbd className="ml-2 shrink-0 rounded border border-edge-soft bg-surface px-1.5 py-0.5 font-sans text-2xs font-semibold text-ink-subtle">
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
            aria-activedescendant={rows[active] ? `command-option-${active}` : undefined}
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
          {rows.map((r, i) => {
            // A heading before the first row of each kind, so the two sources
            // are distinguishable without breaking the single arrow-key list.
            const heading =
              i === 0 || rows[i - 1].kind !== r.kind
                ? r.kind === "page"
                  ? labels.pages
                  : r.kind === "recent"
                    ? (labels.recent ?? labels.pages)
                    : r.kind === "action"
                      ? (labels.actions ?? labels.pages)
                      : labels.machines
                : null;
            return (
              <li key={r.key} role="none">
                {heading ? (
                  <p
                    role="presentation"
                    className="px-4 pb-1 pt-2.5 text-2xs font-semibold uppercase tracking-wider text-ink-subtle"
                  >
                    {heading}
                  </p>
                ) : null}
                <button
                  type="button"
                  id={`command-option-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(r)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors",
                    i === active ? "bg-accent-tint text-ink" : "text-ink hover:bg-surface-hover",
                  )}
                >
                  {r.kind === "machine" ? (
                    <MachinesIcon
                      className={cn("shrink-0 text-lg", i === active ? "text-accent-ink" : "text-ink-muted")}
                    />
                  ) : (
                    <Icon
                      name={r.icon}
                      className={cn("shrink-0 text-lg", i === active ? "text-accent-ink" : "text-ink-muted")}
                    />
                  )}
                  <span className="flex-1 truncate font-medium">{r.label}</span>
                  {/* The group disambiguates the money words: "Reports" under
                      Overview is not "Statements" under Contractor. For a
                      machine it is the make and the registration, which is how
                      somebody tells two John Deeres apart. */}
                  <span className="shrink-0 truncate pl-3 text-xs text-ink-subtle">{r.meta}</span>
                </button>
              </li>
            );
          })}

          {searching && machineRows.length === 0 ? (
            <li role="none" className="px-4 py-3 text-sm text-ink-subtle">
              {labels.searching}
            </li>
          ) : null}

          {rows.length === 0 && !searching ? (
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
          {labels.results.replace("{n}", String(rows.length))}
        </p>
      </Overlay>
    </>
  );
}

/**
 * A second way into the ONE mounted palette: the phone header's search button. Icon-only
 * (48px, with its name for screen readers) because the phone header must fit 360px in
 * Afrikaans; it dispatches an event rather than mounting another palette, which would
 * register a second Ctrl/⌘+K listener and open two dialogs.
 */
export function SearchButton({ label, className }: { label: string; className?: string }) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
      className={cn(
        "focus-ring inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-xl text-sand-600 hover:bg-sand-100",
        className,
      )}
    >
      <SearchIcon aria-hidden />
      <span className="sr-only">{label}</span>
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mr-1 inline-flex min-w-[1.35rem] justify-center rounded border border-edge-soft bg-surface-sunken px-1 py-0.5 font-sans text-2xs font-semibold text-ink-muted">
      {children}
    </kbd>
  );
}
