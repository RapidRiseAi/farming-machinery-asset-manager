import { currentFarmId, getFarmPlan, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { planNameKey } from "@/lib/entitlements";
import { loadSitesOverview, siteTotals, type SiteRow } from "@/lib/sites-overview";
import { setCurrentFarm } from "@/app/(app)/actions";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { Card, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button";
import { DownloadLink } from "@/components/ui/download-link";
import { SubmitButton } from "@/components/ui/submit-button";
import { downloadLabels } from "@/lib/interaction-labels";

/**
 * Your farms, side by side (Complete, `multi_site`). See src/lib/sites-overview.ts for
 * what is included and why: a farm counts only when the person belongs to it AND its own
 * plan includes the combined view, and every figure is read under their own access there.
 * Each row opens that farm; the export is the same table with the farm named on every row.
 */
export default async function SitesPage() {
  const profile = await requireProfile();
  const locale = profile.lang;
  const supabase = await createClient();
  const rows = await loadSitesOverview(supabase, profile);
  const included = rows.filter((r) => r.figures !== null);
  const totals = siteTotals(rows);

  const header = (
    <PageHeader
      title={t("sites.title", locale)}
      lead={t("sites.lead", locale)}
      locale={locale}
    />
  );

  if (rows.length < 2) {
    return (
      <PageContainer>
        {header}
        <Card>
          <p className="text-sm text-sand-700">{t("sites.oneFarm", locale)}</p>
        </Card>
      </PageContainer>
    );
  }

  if (included.length === 0) {
    const farmId = await currentFarmId(profile);
    return (
      <PageContainer>
        {header}
        <UpgradeNotice
          feature="multi_site"
          requiredPlan="complete"
          currentPlan={farmId ? await getFarmPlan(farmId) : null}
          locale={locale}
          canUpgrade={rows.some((r) => r.role === "owner")}
        />
      </PageContainer>
    );
  }

  const money = totals.runningCostCents !== null;
  const open = (r: SiteRow) => (
    <form action={setCurrentFarm}>
      <input type="hidden" name="farm_id" value={r.id} />
      <input type="hidden" name="next" value="/machines" />
      <SubmitButton variant="secondary" size="sm">
        {t("sites.open", locale)}
      </SubmitButton>
    </form>
  );

  return (
    <PageContainer>
      {header}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t("sites.machines", locale)} value={String(totals.machines)} />
        <Stat label={t("sites.openFaults", locale)} value={String(totals.openFaults)} />
        <Stat label={t("sites.overdue", locale)} value={String(totals.overdueServices)} />
        <Stat
          label={t("sites.runningCost", locale)}
          value={money ? rands(totals.runningCostCents ?? 0) : "-"}
        />
      </div>
      {money && totals.costFarms < included.length ? (
        <p className="mt-2 text-xs text-sand-600">
          {t("sites.costsPartial", locale)
            .replace("{n}", String(totals.costFarms))
            .replace("{total}", String(included.length))}
        </p>
      ) : null}

      <div className="mt-6 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-sand-900">{t("sites.byFarm", locale)}</h2>
        <DownloadLink
          href="/sites/export.csv"
          labels={downloadLabels(locale)}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          {t("sites.export", locale)}
        </DownloadLink>
      </div>
      {/* One card per farm: a seven-column table scrolled inside its card on a phone. */}
      <ul className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {rows.map((r) => (
          <li key={r.id}>
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle as="h3" className="truncate">{r.name}</CardTitle>
                  <p className="mt-0.5 text-xs text-sand-500">
                    {r.role ? t(`role.${r.role}`, locale) : ""}
                    {r.figures ? "" : ` · ${t(planNameKey(r.plan), locale)}`}
                  </p>
                </div>
                {open(r)}
              </div>
              {r.figures ? (
                <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
                  {([
                    ["sites.machines", String(r.figures.machines)],
                    ["sites.outOfService", String(r.figures.outOfService)],
                    ["sites.openFaults", String(r.figures.openFaults)],
                    ["sites.overdue", String(r.figures.overdueServices)],
                    ["sites.openJobs", String(r.figures.openJobs)],
                    ...(money
                      ? [["sites.runningCost", r.figures.runningCostCents !== null ? rands(r.figures.runningCostCents) : "-"]]
                      : []),
                  ] as [string, string][]).map(([key, value]) => (
                    <div key={key} className="min-w-0">
                      <dt className="text-xs text-sand-500">{t(key, locale)}</dt>
                      <dd className="font-semibold tabular-nums text-sand-900">{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="mt-3 text-sm text-sand-600">{t("sites.notIncluded", locale)}</p>
              )}
            </Card>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-sand-600">{t("sites.note", locale)}</p>
    </PageContainer>
  );
}
