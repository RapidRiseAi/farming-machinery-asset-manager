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
 * never rendered when the plan is insufficient, this is a server-side denial, not a
 * CSS hide. Fully translated (EN/AF).
 */
export function UpgradeNotice({
  feature,
  requiredPlan,
  currentPlan,
  locale,
  compact = false,
  canUpgrade = false,
}: {
  /** i18n key stem under `upgrade.feature.*` describing the locked capability. */
  feature: string;
  /** A farm plan or a partner product, the two label sets never overlap. */
  requiredPlan: Plan | WorkshopPlan;
  currentPlan: Plan | WorkshopPlan | null;
  locale: Lang;
  /** Inline (within an allowed page) vs full-page treatment. */
  compact?: boolean;
  /**
   * The viewer can change the farm's plan themselves: the farm OWNER, the only role
   * /billing serves. The notice then points at the plans instead of telling them to
   * "ask your farm owner", who is themselves. Callers pass `canUpgrade={role === "owner"}`.
   * Ignored on the partner side, whose upgrade is arranged with FleetWise.
   */
  canUpgrade?: boolean;
}) {
  const featureName = t(`upgrade.feature.${feature}`, locale);
  // Farm plans and partner products name themselves under different i18n stems, and the
  // two sets of values are disjoint, so which stem applies is decided by the value
  // itself rather than by an extra prop every call site would have to remember.
  const nameOf = (plan: Plan | WorkshopPlan) =>
    t(isWorkshopPlan(plan) ? workshopPlanNameKey(plan) : planNameKey(plan as Plan), locale);
  const partnerSide = isWorkshopPlan(requiredPlan);
  const owner = canUpgrade && !partnerSide;
  const planName = nameOf(requiredPlan);
  const title = t("upgrade.title", locale).replace("{feature}", featureName);
  // Three readers, three sentences: the farm owner (who upgrades from Billing), a partner
  // (no farm owner to ask, FleetWise arranges it), and anyone else on a farm (who asks
  // the owner).
  const bodyKey = owner ? "upgrade.bodyOwner" : partnerSide ? "upgrade.bodyPartner" : "upgrade.body";
  const hint = t(bodyKey, locale)
    .replace("{feature}", featureName)
    .replace("{plan}", planName)
    .replace("{current}", currentPlan ? nameOf(currentPlan) : "-");

  if (compact) {
    return (
      <div className="rounded-xl border border-dashed border-sand-300 bg-sand-50/60 p-4 text-sm">
        <p className="font-semibold text-sand-900">{title}</p>
        <p className="mt-1 text-sand-500">{hint}</p>
        {owner ? (
          <Link
            href="/billing"
            className="mt-2 inline-flex min-h-[48px] items-center font-semibold text-brand-ink underline-offset-2 hover:underline sm:min-h-0"
          >
            {t("upgrade.seePlans", locale)}
          </Link>
        ) : null}
      </div>
    );
  }

  // Send people back to their OWN home. A partner denied the books has no business being
  // pointed at a farm's vehicle list, which is what the single hardcoded href did the
  // moment this notice started serving both sides. Home is never the filled button: it
  // is not what the notice is about, and for an owner the plans are.
  const home = (
    <Link
      href={partnerSide ? "/contractor" : "/machines"}
      className={buttonVariants({ variant: "secondary", size: "sm" })}
    >
      {t(partnerSide ? "upgrade.ctaPartner" : "upgrade.cta", locale)}
    </Link>
  );

  return (
    <EmptyState
      icon={<InfoIcon />}
      title={title}
      hint={hint}
      action={
        owner ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link href="/billing" className={buttonVariants({ variant: "primary", size: "sm" })}>
              {t("upgrade.seePlans", locale)}
            </Link>
            {home}
          </div>
        ) : (
          home
        )
      }
    />
  );
}
