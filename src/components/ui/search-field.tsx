"use client";

/**
 * Search as you type, written to the URL.
 *
 *   <SearchField
 *     label={t("machines.search", locale)}          // aria-label, and the placeholder
 *     clearLabel={t("common.clearSearch", locale)}  // the clear (x) button's name
 *     defaultValue={sp.q}
 *     keep={{ status: sp.status, type: sp.type }}   // carried by the no-JS submit
 *   />
 *
 * Props: `label`, `clearLabel`, `name?` ("q"), `defaultValue?`, `placeholder?`,
 * `action?` (GET target, default the current page), `keep?` (other params, as hidden
 * inputs for the no-JS form), `resetParams?` (dropped when the query changes, default
 * ["page"]), `debounceMs?` (300), `className?`.
 *
 * == Why ======================================================================
 * Every list that searched hand-rolled a `<form>` with an input, a row of hidden
 * inputs to carry the other filters, and a separate Search button. At 360px the button
 * left the input about 120px wide ("Search na…"), every query cost an extra tap and a
 * full navigation, and clearing meant deleting the text and pressing Search again.
 *
 * Now: typing waits 300ms and then `router.replace`s `?q=` (no history entry per
 * keystroke, no scroll jump), keeping every other param of the current URL. Enter
 * searches at once. The x clears, so does Escape. While the new list renders the
 * magnifier becomes a spinner.
 *
 * == Without JavaScript =======================================================
 * It is still a real `<form method="get">` with a visually hidden submit, so before
 * hydration (a long window on a mid-range Android) or with scripts off, Enter submits
 * the query plus the `keep` params exactly as the old forms did.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { cn } from "./cn";
import { controlBase } from "./input";
import { CloseIcon, SearchIcon, Spinner } from "./icons";

export type SearchFieldProps = {
  /** Accessible name of the input; also the placeholder unless `placeholder` is set. */
  label: string;
  /** Accessible name of the clear (x) button. */
  clearLabel: string;
  /** URL param the query is written to. Default "q". */
  name?: string;
  defaultValue?: string;
  placeholder?: string;
  /** GET target for the no-JS form, and the path searched. Default: the current page. */
  action?: string;
  /** Other params the no-JS submit must carry. With JS the live URL is kept instead. */
  keep?: Record<string, string | null | undefined>;
  /** Params dropped whenever the query changes (a stale page number). Default ["page"]. */
  resetParams?: string[];
  debounceMs?: number;
  className?: string;
};

export function SearchField({
  label,
  clearLabel,
  name = "q",
  defaultValue,
  placeholder,
  action,
  keep,
  resetParams = ["page"],
  debounceMs = 300,
  className,
}: SearchFieldProps) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue ?? "");
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The query last written to the URL, so a server re-render echoing it back does
  // not overwrite what the person has typed since.
  const sent = useRef((defaultValue ?? "").trim());

  // Follow the URL when something else changed it (a "Clear filters" link, the back
  // button), but never while the person is typing in the box.
  useEffect(() => {
    const v = (defaultValue ?? "").trim();
    if (v === sent.current) return;
    if (typeof document !== "undefined" && document.activeElement === inputRef.current) return;
    sent.current = v;
    setValue(defaultValue ?? "");
  }, [defaultValue]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const go = useCallback(
    (next: string) => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const q = next.trim();
      if (q === sent.current) return;
      sent.current = q;

      const here = new URL(window.location.href);
      const target = action ? new URL(action, here) : here;
      // Same page: keep everything already in the URL. Another page: start from `keep`.
      const params =
        target.pathname === here.pathname
          ? new URLSearchParams(here.search)
          : new URLSearchParams(
              Object.entries(keep ?? {}).filter((e): e is [string, string] => !!e[1]),
            );
      if (q) params.set(name, q);
      else params.delete(name);
      for (const p of resetParams) params.delete(p);
      const qs = params.toString();
      const href = qs ? `${target.pathname}?${qs}` : target.pathname;
      startTransition(() => router.replace(href, { scroll: false }));
    },
    [action, keep, name, resetParams, router],
  );

  const onChange = (next: string) => {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => go(next), debounceMs);
  };

  const clear = () => {
    setValue("");
    go("");
    inputRef.current?.focus();
  };

  return (
    <form
      role="search"
      method="get"
      action={action}
      onSubmit={(e) => {
        e.preventDefault();
        go(value);
      }}
      className={cn("relative min-w-0", className)}
    >
      {Object.entries(keep ?? {}).map(([k, v]) =>
        v && k !== name ? <input key={k} type="hidden" name={k} value={v} /> : null,
      )}
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-lg text-sand-400">
        {pending ? <Spinner className="animate-spin" /> : <SearchIcon />}
      </span>
      <input
        ref={inputRef}
        type="search"
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            // Only swallow Escape when it did something, so it still closes a dialog.
            e.preventDefault();
            e.stopPropagation();
            clear();
          }
        }}
        aria-label={label}
        placeholder={placeholder ?? label}
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        className={cn(
          controlBase,
          "pl-10 [&::-webkit-search-cancel-button]:hidden",
          value ? "pr-12" : "pr-3",
        )}
      />
      {value ? (
        <button
          type="button"
          onClick={clear}
          aria-label={clearLabel}
          className="focus-ring absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-lg text-lg text-sand-500 hover:text-sand-800"
        >
          <CloseIcon />
        </button>
      ) : null}
      {/* Enter already submits; this keeps the no-JS form valid everywhere. */}
      <button type="submit" tabIndex={-1} className="sr-only">
        {label}
      </button>
    </form>
  );
}
