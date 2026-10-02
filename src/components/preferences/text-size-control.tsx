"use client";

import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import { TEXT_SIZE_KEY, TEXT_SIZES, type TextSize } from "./text-size";

/**
 * Standard, Large or Largest text on THIS device.
 *
 * For reading a phone in the sun or without reading glasses. It sets `data-text` on
 * <html>, which globals.css maps to a larger root font size, so every rem-based size
 * in the type scale grows together. Pinch zoom still works on top of it. The 48px touch
 * floors are px, so they stay floors rather than growing.
 *
 * Stored in localStorage like the theme, and applied before paint by the root layout's
 * head script, so there is no flash of small text on a cold load.
 */
export function TextSizeControl({
  label,
  labels,
  className,
}: {
  label: string;
  labels: Record<TextSize, string>;
  className?: string;
}) {
  const [size, setSize] = useState<TextSize>("normal");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(TEXT_SIZE_KEY);
    } catch {
      // Storage blocked: the standard size, which is what the page already shows.
    }
    if (stored === "large" || stored === "larger") setSize(stored);
    setReady(true);
  }, []);

  function apply(next: TextSize) {
    setSize(next);
    const root = document.documentElement;
    if (next === "normal") root.removeAttribute("data-text");
    else root.setAttribute("data-text", next);
    try {
      if (next === "normal") localStorage.removeItem(TEXT_SIZE_KEY);
      else localStorage.setItem(TEXT_SIZE_KEY, next);
    } catch {
      // Applies for this visit even if it cannot be remembered.
    }
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-edge bg-surface-sunken p-1", className)}
    >
      {TEXT_SIZES.map((s, i) => {
        const pressed = ready && s === size;
        return (
          <button
            key={s}
            type="button"
            aria-pressed={pressed}
            onClick={() => apply(s)}
            className={cn(
              "focus-ring inline-flex min-h-[48px] items-center gap-2 rounded-md px-3 font-medium transition-colors sm:min-h-[40px]",
              pressed ? "bg-surface text-ink shadow-xs" : "text-ink-muted hover:text-ink",
            )}
          >
            {/* A sample "A" at each step, so the choice shows its own size. */}
            <span aria-hidden className={cn("font-semibold", i === 0 ? "text-sm" : i === 1 ? "text-base" : "text-lg")}>
              A
            </span>
            <span className="text-sm">{labels[s]}</span>
          </button>
        );
      })}
    </div>
  );
}
