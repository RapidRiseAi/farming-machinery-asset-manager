"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "./cn";
import { CheckIcon, WarningIcon, InfoIcon, CloseIcon } from "./icons";
import type { FlashTone } from "./flash";

const TONES: Record<FlashTone, { wrap: string; icon: ReactNode }> = {
  success: { wrap: "border-green-200 bg-green-50 text-green-800", icon: <CheckIcon /> },
  error: { wrap: "border-red-200 bg-red-50 text-red-700", icon: <WarningIcon /> },
  warning: { wrap: "border-amber-200 bg-amber-50 text-amber-800", icon: <WarningIcon /> },
  info: { wrap: "border-blue-200 bg-blue-50 text-blue-700", icon: <InfoIcon /> },
};

export type ToastProps = {
  message: ReactNode;
  tone?: FlashTone;
  /** Auto-dismiss after N ms (0 = never). Default 4000. */
  duration?: number;
  /** Accessible label for the dismiss button (translated). */
  closeLabel?: string;
  onDismissed?: () => void;
  className?: string;
};

/**
 * Dismissible, auto-hiding transient alert. Client component. Mount it when you
 * want a self-clearing confirmation; for a persistent server-rendered banner use
 * `Flash`.
 */
export function Toast({
  message,
  tone = "success",
  duration = 4000,
  closeLabel = "Dismiss",
  onDismissed,
  className,
}: ToastProps) {
  const [open, setOpen] = useState(true);
  const s = TONES[tone];

  useEffect(() => {
    if (!open) {
      onDismissed?.();
      return;
    }
    if (duration <= 0) return;
    const id = window.setTimeout(() => setOpen(false), duration);
    return () => window.clearTimeout(id);
  }, [open, duration, onDismissed]);

  if (!open) return null;

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm font-medium shadow-soft animate-fade-in",
        s.wrap,
        className,
      )}
    >
      <span className="mt-0.5 shrink-0 text-[1.15rem]" aria-hidden>
        {s.icon}
      </span>
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label={closeLabel}
        className="focus-ring -my-1 -mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[1.1rem] opacity-70 hover:opacity-100"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
