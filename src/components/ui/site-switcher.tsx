"use client";

import { usePathname } from "next/navigation";
import { setCurrentFarm } from "@/app/(app)/actions";
import type { FarmOption } from "@/lib/auth";

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
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="focus-ring w-full truncate rounded-lg border border-sand-200 bg-sand-50 px-2.5 py-1.5 text-sm font-medium text-sand-800 hover:bg-sand-100"
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
