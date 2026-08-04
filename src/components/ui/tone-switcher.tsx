"use client";

import { usePathname } from "next/navigation";
import { setTone } from "@/app/(app)/actions";
import type { Tone } from "@/lib/i18n";
import { cn } from "./cn";

/**
 * Friendly / professional wording switch.
 *
 * The product was written in one register — plain, warm farm English ("Nothing needs
 * you today", "I put in diesel"). That is right for a driver with dusty hands and wrong
 * for an operation whose office expects "No outstanding items". Neither audience should
 * have to put up with the other's voice, so the register is a setting.
 *
 * Independent of language: either tone reads in either language.
 */
export function ToneSwitcher({
  current,
  label,
  friendlyLabel,
  professionalLabel,
}: {
  current: Tone;
  label: string;
  friendlyLabel: string;
  professionalLabel: string;
}) {
  const next = usePathname();
  const options: { value: Tone; label: string }[] = [
    { value: "friendly", label: friendlyLabel },
    { value: "professional", label: professionalLabel },
  ];

  return (
    <form action={setTone} aria-label={label} className="inline-flex flex-wrap items-center gap-1">
      <input type="hidden" name="next" value={next} />
      {options.map((o) => (
        <button
          key={o.value}
          type="submit"
          name="tone"
          value={o.value}
          aria-pressed={current === o.value}
          className={cn(
            "focus-ring inline-flex min-h-[48px] items-center rounded-lg border px-3.5 text-sm font-semibold transition-colors sm:min-h-[40px]",
            current === o.value
              ? "border-brand-600 bg-brand-600 text-white shadow-xs"
              : "border-sand-300 bg-white text-sand-700 hover:bg-sand-50",
          )}
        >
          {o.label}
        </button>
      ))}
    </form>
  );
}
