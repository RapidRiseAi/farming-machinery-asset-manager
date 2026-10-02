"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * Tick up to `max` screens for the phone's bottom bar. Once `max` are ticked the rest
 * are disabled, so the limit is felt while choosing rather than discovered after Save
 * (the server keeps the first `max` either way). Posts the picks as `tabs` in the order
 * they were ticked, which is the order they sit in the bar.
 */
export function ShortcutPicker({
  options,
  initial,
  max,
}: {
  options: { href: string; label: string }[];
  initial: string[];
  max: number;
}) {
  const [picked, setPicked] = useState<string[]>(initial.slice(0, max));
  const full = picked.length >= max;
  return (
    <div className="grid gap-x-4 sm:grid-cols-2">
      {picked.map((href) => (
        <input key={href} type="hidden" name="tabs" value={href} />
      ))}
      {options.map((o) => {
        const on = picked.includes(o.href);
        return (
          <Checkbox
            key={o.href}
            checked={on}
            disabled={!on && full}
            onChange={(e) =>
              setPicked((cur) =>
                e.target.checked ? [...cur.filter((h) => h !== o.href), o.href] : cur.filter((h) => h !== o.href),
              )
            }
            label={o.label}
          />
        );
      })}
    </div>
  );
}
