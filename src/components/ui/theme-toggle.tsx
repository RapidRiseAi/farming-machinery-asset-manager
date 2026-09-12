"use client";

import { useEffect, useState } from "react";
import { cn } from "./cn";
import { SunIcon, MoonIcon, DeviceIcon } from "./icons";

export type ThemeChoice = "system" | "light" | "dark";
const ORDER: ThemeChoice[] = ["system", "light", "dark"];
const STORAGE_KEY = "fleetwise:theme";

/**
 * Light / dark / follow-the-device.
 *
 * The palette's FleetWise Black is a sanctioned brand ground ("dark backgrounds,
 * premium sections"), so the dark theme is an on-brand treatment rather than an
 * inversion — and it matters for this product specifically, whose users are in a
 * workshop at night and a cab at noon.
 *
 * Three states, not two. "System" is the default and the one most people should
 * stay on; an explicit choice is stamped as `data-theme` on <html>, which the
 * token blocks in globals.css are written to honour in BOTH directions (an
 * explicit light choice beats a dark OS, and vice versa).
 *
 * The label is always visible — this project forbids icon-only controls, and
 * a lone sun glyph is exactly the kind of thing that reads as decoration.
 */
export function ThemeToggle({
  label,
  labels,
  className,
}: {
  /** Accessible name for the control as a whole, e.g. "Appearance". */
  label: string;
  /** Visible word for each state, already translated. */
  labels: Record<ThemeChoice, string>;
  className?: string;
}) {
  // Start on "system" and correct after mount: the server cannot know what is in
  // this browser's localStorage, and rendering a guess would mismatch on hydration.
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage blocked (private window, locked-down machine). Follow the OS.
    }
    if (stored === "light" || stored === "dark") setChoice(stored);
    setReady(true);
  }, []);

  function apply(next: ThemeChoice) {
    setChoice(next);
    const root = document.documentElement;
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A choice that cannot be remembered still applies for this session.
    }
  }

  const Icon = choice === "dark" ? MoonIcon : choice === "light" ? SunIcon : DeviceIcon;

  return (
    <button
      type="button"
      onClick={() => apply(ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length])}
      aria-label={`${label}: ${labels[choice]}`}
      // Until the stored choice is read, the button's word could be wrong — say
      // nothing to a screen reader rather than something false.
      aria-live="polite"
      className={cn(
        "focus-ring inline-flex min-h-[48px] items-center gap-2 rounded-lg border border-edge",
        "bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-surface-sunken",
        "sm:min-h-[40px]",
        className,
      )}
    >
      <Icon className="text-base text-ink-muted" aria-hidden />
      <span>{ready ? labels[choice] : labels.system}</span>
    </button>
  );
}
