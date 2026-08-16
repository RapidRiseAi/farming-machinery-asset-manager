import Link from "next/link";
import { t, type Lang } from "@/lib/i18n";
import type { Plan } from "@/lib/entitlements";
import { planNameKey } from "@/lib/entitlements";
import { type WorkshopPlan, isWorkshopPlan, workshopPlanNameKey } from "@/lib/contractor-plan";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { InfoIcon } from "@/components/ui/icons";

/**
 * Server-rendered upgrade prompt shown IN PLACE of a gated surface. The gated content is
 * never rendered when the plan is insufficient — this is a server-side denial, not a
 * CSS hide. Fully translated (EN/AF).
 */
export function UpgradeNotice({
  feature,
  requiredPlan,
  currentPlan,
  locale,
  compact = false,
}: {
  /** i18n key stem under `upgrade.feature.*` describing the locked capability. */
  feature: string;
  /** A farm plan or a partner product — the two label sets never overlap. */
  requiredPlan: Plan | WorkshopPlan;
  currentPlan: Plan | WorkshopPlan | null;
  locale: Lang;
  /** Inline (within an allowed page) vs full-page treatment. */
  compact?: boolean;
}) {
  const featureName = t(`upgrade.feature.${feature}`, locale);
  // Farm plans and partner products name themselves under different i18n stems, and the
  // two sets of values are disjoint — so which stem applies is decided by the value
  // itself rather than by an extra prop every call site would have to remember.
  const nameOf = (plan: Plan | WorkshopPlan) =>
    t(isWorkshopPlan(plan) ? workshopPlanNameKey(plan) : planNameKey(plan as Plan), locale);
  const partnerSide = isWorkshopPlan(requiredPlan);
  const planName = nameOf(requiredPlan);
  const title = t("upgrade.title", locale).replace("{feature}", featureName);
  const hint = t("upgrade.body", locale)
    .replace("{feature}", featureName)
    .replace("{plan}", planName)
    .replace("{current}", currentPlan ? nameOf(currentPlan) : "—");

  if (compact) {
    return (
      <div className="rounded-xl border border-dashed border-sand-300 bg-sand-50/60 p-4 text-sm">
        <p className="font-semibold text-sand-900">{title}</p>
        <p className="mt-1 text-sand-500">{hint}</p>
      </div>
    );
  }

  return (
    <EmptyState
      icon={<InfoIcon />}
      title={title}
      hint={hint}
      action={
        // Send people back to their OWN home. A partner denied the books has no business
        // being pointed at a farm's vehicle list, which is what the single hardcoded
        // href did the moment this notice started serving both sides.
        <Link
          href={partnerSide ? "/contractor" : "/machines"}
          className={buttonVariants({ variant: "primary", size: "sm" })}
        >
          {t("upgrade.cta", locale)}
        </Link>
      }
    />
  );
}
