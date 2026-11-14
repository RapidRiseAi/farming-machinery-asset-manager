import Link from "next/link";

import { cn } from "@/components/ui/cn";
import { t, type Lang } from "@/lib/i18n";

/** Which list the assets page shows: full-priced fleet assets, or support equipment. */
export type AssetView = "fleet" | "equipment";

export function readAssetView(value: string | undefined | null): AssetView {
  return value === "equipment" ? "equipment" : "fleet";
}

/**
 * Fleet assets and Support equipment: two views of the same register (one identity and
 * history per asset, 20261114090100), as a pair of links so it works without JavaScript and
 * a view can be shared. The selected one is marked with aria-current and its fill, never
 * colour alone (the label says which). Mobile first: both fit side by side at 360px.
 */
export function AssetViews({
  current,
  fleetCount,
  equipmentCount,
  hrefFor,
  locale,
}: {
  current: AssetView;
  fleetCount: number;
  equipmentCount: number;
  hrefFor: (view: AssetView) => string;
  locale: Lang;
}) {
  const views: { key: AssetView; label: string; count: number }[] = [
    { key: "fleet", label: t("assets.viewFleet", locale), count: fleetCount },
    { key: "equipment", label: t("assets.viewEquipment", locale), count: equipmentCount },
  ];
  return (
    <nav aria-label={t("assets.viewsLabel", locale)} className="flex flex-wrap gap-2">
      {views.map((v) => {
        const on = v.key === current;
        return (
          <Link
            key={v.key}
            href={hrefFor(v.key)}
            aria-current={on ? "page" : undefined}
            className={cn(
              "focus-ring inline-flex min-h-[48px] items-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-sm font-medium transition-colors sm:min-h-[40px]",
              on
                ? "border-brand-600 bg-brand-600 text-white shadow-xs"
                : "border-sand-200 bg-surface text-sand-700 hover:border-sand-300 hover:bg-sand-50",
            )}
          >
            {v.label}
            <span className={cn("tabular-nums", on ? "text-white/75" : "text-sand-400")}>{v.count}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** The shape public.asset_capacity_summary answers (20261114090300). */
export type CapacitySummary = {
  ceiling?: boolean;
  subscription_id?: string | null;
  equipment_terms?: boolean;
  full?: { active?: number; purchased?: number | null; free_now?: number | null; next_renewal?: number | null };
  equipment?: { active?: number; included?: number; extra_paid?: number; free_now?: number | null; extra_next_renewal?: number };
};

/**
 * Capacity in three numbers kept apart: in use, paid or included and free now, and what
 * the next renewal bills. Spaces only, never money (a manager may read this).
 */
export function CapacityFacts({ summary, locale }: { summary: CapacitySummary | null; locale: Lang }) {
  if (!summary || !summary.subscription_id) return null;
  const full = summary.full ?? {};
  const eq = summary.equipment ?? {};
  const fullLine = summary.ceiling
    ? t("assets.capacityFull", locale)
        .replace("{active}", String(full.active ?? 0))
        .replace("{purchased}", String(full.purchased ?? 0))
        .replace("{free}", String(full.free_now ?? 0))
        .replace("{next}", String(full.next_renewal ?? 0))
    : t("assets.capacityFullMetered", locale).replace("{active}", String(full.active ?? 0));
  const eqLine = !summary.equipment_terms
    ? t("assets.capacityEquipmentNoTerms", locale)
    : summary.ceiling
      ? t("assets.capacityEquipment", locale)
          .replace("{active}", String(eq.active ?? 0))
          .replace("{included}", String(eq.included ?? 0))
          .replace("{extra}", String(eq.extra_paid ?? 0))
          .replace("{free}", String(eq.free_now ?? 0))
          .replace("{next}", String(eq.extra_next_renewal ?? 0))
      : t("assets.capacityEquipmentMetered", locale)
          .replace("{active}", String(eq.active ?? 0))
          .replace("{included}", String(eq.included ?? 0));
  return (
    <ul className="flex flex-col gap-1 text-sm text-sand-700" aria-label={t("assets.capacityLabel", locale)}>
      <li>{fullLine}</li>
      <li>{eqLine}</li>
    </ul>
  );
}

/**
 * On a support equipment asset's page, in place of a tool it does not have: what it keeps,
 * what a full fleet space adds, and how to get it (convert, from the asset's menu).
 */
export function EquipmentProfileNote({ locale }: { locale: Lang }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-surface-sunken p-3 text-sm text-sand-700">
      <p className="font-semibold text-sand-900">{t("assets.equipmentNoteTitle", locale)}</p>
      <p>{t("assets.equipmentNoteKeeps", locale)}</p>
      <p>{t("assets.equipmentNoteConvert", locale)}</p>
    </div>
  );
}