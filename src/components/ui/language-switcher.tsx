"use client";

import { usePathname } from "next/navigation";
import { setLanguage } from "@/app/(app)/actions";
import type { Locale } from "@/lib/i18n";
import { cn } from "./cn";

/**
 * Per-user language switch (FR-18.1): a two-state EN / AF segmented control. Each
 * button submits the `setLanguage` server action (which updates the signed-in user's
 * `users.language` and revalidates the layout), so the whole app re-renders in the
 * chosen language. Shown in the app shell on every page.
 */
export function LanguageSwitcher({ current, label }: { current: Locale; label: string }) {
  const pathname = usePathname();
  const options: Locale[] = ["en", "af"];
  return (
    <form
      action={setLanguage}
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-lg border border-sand-200 bg-sand-50 p-0.5"
    >
      <input type="hidden" name="next" value={pathname} />
      {options.map((lng) => (
        <button
          key={lng}
          type="submit"
          name="lang"
          value={lng}
          aria-pressed={current === lng}
          className={cn(
            "focus-ring rounded-md px-2.5 py-1 text-xs font-semibold uppercase transition-colors",
            current === lng
              ? "bg-white text-sand-900 shadow-xs"
              : "text-sand-500 hover:text-sand-800",
          )}
        >
          {lng}
        </button>
      ))}
    </form>
  );
}
