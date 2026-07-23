import Link from "next/link";
import { t } from "@/lib/i18n";
import type { Plan } from "@/lib/entitlements";
import { planNameKey } from "@/lib/entitlements";
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
  requiredPlan: Plan;
  currentPlan: Plan | null;
  locale: "en" | "af";
  /** Inline (within an allowed page) vs full-page treatment. */
  compact?: boolean;
}) {
  const featureName = t(`upgrade.feature.${feature}`, locale);
  const planName = t(planNameKey(requiredPlan), locale);
  const title = t("upgrade.title", locale).replace("{feature}", featureName);
  const hint = t("upgrade.body", locale)
    .replace("{feature}", featureName)
    .replace("{plan}", planName)
    .replace("{current}", currentPlan ? t(planNameKey(currentPlan), locale) : "—");

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
        <Link href="/machines" className={buttonVariants({ variant: "primary", size: "sm" })}>
          {t("upgrade.cta", locale)}
        </Link>
      }
    />
  );
}
