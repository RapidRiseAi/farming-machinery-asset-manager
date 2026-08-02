"use client";

import { usePathname } from "next/navigation";
import { setDeviceLanguage } from "@/app/locale-actions";
import type { Locale } from "@/lib/i18n";
import { cn } from "./cn";

const LABELS: Record<Locale, string> = { en: "English", af: "Afrikaans" };

/**
 * EN / AF switch for the screens that run before sign-in — the login page and the
 * public QR pages (audit bug 2). Writes the device-language cookie and returns to the
 * same URL. The signed-in switcher (`LanguageSwitcher`) still writes `users.language`.
 *
 * 48px targets: this is the first thing an Afrikaans user needs, often outdoors.
 */
export function DeviceLanguageSwitcher({
  current,
  label,
  className,
}: {
  current: Locale;
  label: string;
  className?: string;
}) {
  // Deliberately drops the query string: a stale `?error=` or `?sent=` should not
  // survive a language change, and it keeps this out of a Suspense boundary.
  const next = usePathname();
  const options: Locale[] = ["en", "af"];

  return (
    <form
      action={setDeviceLanguage}
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-xl border border-sand-200 bg-white p-1",
        className,
      )}
    >
      <input type="hidden" name="next" value={next} />
      {options.map((lng) => (
        <button
          key={lng}
          type="submit"
          name="lang"
          value={lng}
          aria-pressed={current === lng}
          aria-label={LABELS[lng]}
          className={cn(
            "focus-ring min-h-[44px] rounded-lg px-4 text-sm font-semibold uppercase transition-colors",
            current === lng
              ? "bg-brand-600 text-white shadow-xs"
              : "text-sand-600 hover:bg-sand-100 hover:text-sand-900",
          )}
        >
          {lng}
        </button>
      ))}
    </form>
  );
}
