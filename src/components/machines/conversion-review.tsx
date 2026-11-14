import { Fact, FactList } from "@/components/ui/facts";
import { errorMessage } from "@/lib/errors";
import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";

/** The shape public.asset_conversion_preview answers (20261114090300). */
export type ConversionPreview = {
  from?: string;
  to?: string;
  fits_now?: boolean;
  conversion_blocked?: string | null;
  blocked?: string | null;
  needs?: { full_spaces?: number; equipment_spaces?: number };
  full?: { active?: number; after?: number; purchased?: number | null; free_now?: number | null; next_renewal?: number | null };
  equipment?: { active?: number; after?: number; included?: number; extra_paid?: number; extra_next_renewal?: number };
  charge_now?: { status?: string; cents?: number | null };
  /** Present only for the payer. */
  renewal?: { before_cents?: number | null; after_cents?: number | null };
  plans?: { plan: string; renewal_cents: number | null; current: boolean }[];
};

/**
 * What converting this asset changes, before anything is accepted: spaces after, any space
 * that must be bought first, and (for the payer) the next renewal before and after and every
 * plan's renewal for the new mix. Today's charge for a space bought mid-period is priced by
 * the billing change (task A2); until then the dialog says a space is needed and stops.
 */
export function ConversionReview({ preview, locale }: { preview: ConversionPreview; locale: Lang }) {
  const blocker = preview.conversion_blocked ?? preview.blocked ?? null;
  const needFull = preview.needs?.full_spaces ?? 0;
  const needEq = preview.needs?.equipment_spaces ?? 0;
  const toEquipment = preview.to === "equipment";
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-sand-700">{t(toEquipment ? "assets.convertToEquipmentLead" : "assets.convertToFullLead", locale)}</p>
      {blocker ? (
        <p className="rounded-lg bg-callout-danger-bg p-3 text-sand-900">{errorMessage(blocker, locale)}</p>
      ) : null}
      <FactList>
        <Fact
          label={t("assets.factFullAfter", locale)}
          value={t("assets.factInUseOf", locale)
            .replace("{n}", String(preview.full?.after ?? 0))
            .replace("{of}", preview.full?.purchased != null ? String(preview.full.purchased) : "-")}
        />
        <Fact
          label={t("assets.factEquipmentAfter", locale)}
          value={t("assets.factEquipmentOf", locale)
            .replace("{n}", String(preview.equipment?.after ?? 0))
            .replace("{included}", String(preview.equipment?.included ?? 0))
            .replace("{extra}", String(preview.equipment?.extra_paid ?? 0))}
        />
        {preview.renewal ? (
          <Fact
            label={t("assets.factRenewal", locale)}
            value={t("assets.factBeforeAfter", locale)
              .replace("{before}", preview.renewal.before_cents != null ? rands(preview.renewal.before_cents) : "-")
              .replace("{after}", preview.renewal.after_cents != null ? rands(preview.renewal.after_cents) : "-")}
          />
        ) : null}
      </FactList>
      {needFull > 0 || needEq > 0 ? (
        <p className="rounded-lg bg-callout-warning-bg p-3 text-sand-900">
          {t("assets.convertNeedsSpace", locale)
            .replace("{full}", String(needFull))
            .replace("{equipment}", String(needEq))}
        </p>
      ) : null}
      {toEquipment && !blocker ? <p className="text-sand-600">{t("assets.convertKeepsHistory", locale)}</p> : null}
      {preview.plans && preview.plans.length > 0 ? (
        <div>
          <p className="mb-1 font-semibold text-sand-900">{t("assets.plansForMix", locale)}</p>
          <ul className="flex flex-col gap-0.5 text-sand-700">
            {preview.plans.map((p) => (
              <li key={p.plan} className="flex justify-between gap-3">
                <span>
                  {t(`plan.${p.plan}`, locale)}
                  {p.current ? ` (${t("assets.planCurrent", locale)})` : ""}
                </span>
                <span className="tabular-nums">{p.renewal_cents != null ? rands(p.renewal_cents) : "-"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-sand-500">{t("assets.plansNeverSwitched", locale)}</p>
        </div>
      ) : null}
    </div>
  );
}
