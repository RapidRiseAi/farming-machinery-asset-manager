"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { setCurrentFarm } from "@/app/(app)/actions";
import type { FarmOption } from "@/lib/auth";
import { Sheet } from "./dialog";
import { CheckIcon, ChevronDownIcon } from "./icons";
import { cn } from "./cn";

/**
 * Multi-site "current farm" switcher (F7). Shown only when the account can reach more than
 * one farm. Auto-submits the server action on change; the action validates the choice and
 * stores it in a cookie, then revalidates the layout so every per-site surface re-scopes.
 */
export function SiteSwitcher({
  farms,
  current,
  label,
}: {
  farms: FarmOption[];
  current: string;
  label: string;
}) {
  const pathname = usePathname();
  return (
    <form action={setCurrentFarm} className="w-full">
      <input type="hidden" name="next" value={pathname} />
      <label htmlFor="fw-site-switcher" className="sr-only">
        {label}
      </label>
      <select
        id="fw-site-switcher"
        name="farm_id"
        aria-label={label}
        defaultValue={current}
        // Switching IS the onChange, so it waits for the page to work (boot-guard.ts):
        // picked earlier, the select would show the new farm over the old farm's data.
        data-needs-js=""
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="focus-ring min-h-[48px] w-full truncate rounded-lg border border-sand-200 bg-sand-50 px-2.5 text-sm font-medium text-sand-800 hover:bg-sand-100 sm:min-h-[40px]"
      >
        {farms.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </form>
  );
}

/**
 * The phone version: a compact chip in the header naming the current farm, which opens a
 * sheet with the farms as a one-tap list.
 *
 * It replaces a second sticky row under the header that held a full-width native select.
 * That row cost about 65px of every phone screen, sat at a hard-coded `top-[57px]` that
 * had drifted from the header's real height (so it tucked under it on scroll), and the
 * page below usually repeated the farm name anyway.
 *
 * The chip truncates (`min-w-0`), because the header must fit 360px in every language.
 * Each row is a submit button carrying `farm_id`, so the same `setCurrentFarm` action runs
 * with the same fields as the select above.
 */
export function SiteSwitcherChip({
  farms,
  current,
  label,
  closeLabel,
  className,
}: {
  farms: FarmOption[];
  current: string;
  /** "Switch farm": the sheet title and the chip's accessible name prefix. */
  label: string;
  closeLabel: string;
  className?: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const currentName = farms.find((f) => f.id === current)?.name ?? label;

  // A switch revalidates the layout and keeps this component mounted, so close the sheet
  // once the path or the farm has changed.
  useEffect(() => {
    setOpen(false);
  }, [pathname, current]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${currentName}`}
        className={cn(
          "focus-ring inline-flex min-h-[48px] min-w-0 items-center gap-1 overflow-hidden rounded-lg px-2 text-sm font-semibold text-sand-900 hover:bg-sand-100",
          className,
        )}
      >
        <span className="min-w-0 truncate">{currentName}</span>
        <ChevronDownIcon className="shrink-0 text-base text-sand-500" aria-hidden />
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title={label} closeLabel={closeLabel}>
        <form action={setCurrentFarm} className="flex flex-col gap-1.5 pb-2">
          <input type="hidden" name="next" value={pathname} />
          {farms.map((f) => {
            const selected = f.id === current;
            return (
              <button
                key={f.id}
                type="submit"
                name="farm_id"
                value={f.id}
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "focus-ring flex min-h-[52px] w-full items-center gap-3 rounded-lg px-3 text-left text-base font-medium",
                  selected
                    ? "bg-accent-tint font-semibold text-ink ring-1 ring-accent-rim"
                    : "text-ink hover:bg-surface-sunken",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                {selected ? <CheckIcon className="shrink-0 text-xl text-accent-ink" aria-hidden /> : null}
              </button>
            );
          })}
        </form>
      </Sheet>
    </>
  );
}
