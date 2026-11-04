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
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
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

      <Card flush className="mt-4">
        <div className="flex items-center justify-between gap-3 px-4 pt-4">
          <CardTitle>{t("sites.byFarm", locale)}</CardTitle>
          <DownloadLink
            href="/sites/export.csv"
            labels={downloadLabels(locale)}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            {t("sites.export", locale)}
          </DownloadLink>
        </div>
        <Table>
          <Thead>
            <Tr>
              <Th>{t("sites.farm", locale)}</Th>
              <Th className="text-right">{t("sites.machines", locale)}</Th>
              <Th className="text-right">{t("sites.outOfService", locale)}</Th>
              <Th className="text-right">{t("sites.openFaults", locale)}</Th>
              <Th className="text-right">{t("sites.overdue", locale)}</Th>
              <Th className="text-right">{t("sites.openJobs", locale)}</Th>
              {money ? <Th className="text-right">{t("sites.runningCost", locale)}</Th> : null}
              <Th><span className="sr-only">{t("sites.open", locale)}</span></Th>
            </Tr>
          </Thead>
          <Tbody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td className="font-medium text-sand-900">
                  {r.name}
                  <span className="block text-xs font-normal text-sand-500">
                    {r.role ? t(`role.${r.role}`, locale) : ""}
                    {r.figures ? "" : ` · ${t(planNameKey(r.plan), locale)}`}
                  </span>
                </Td>
                {r.figures ? (
                  <>
                    <Td className="text-right tabular-nums">{r.figures.machines}</Td>
                    <Td className="text-right tabular-nums">{r.figures.outOfService}</Td>
                    <Td className="text-right tabular-nums">{r.figures.openFaults}</Td>
                    <Td className="text-right tabular-nums">{r.figures.overdueServices}</Td>
                    <Td className="text-right tabular-nums">{r.figures.openJobs}</Td>
                    {money ? (
                      <Td className="text-right tabular-nums">
                        {r.figures.runningCostCents !== null ? rands(r.figures.runningCostCents) : "-"}
                      </Td>
                    ) : null}
                  </>
                ) : (
                  <Td colSpan={money ? 6 : 5} className="text-sm text-sand-600">
                    {t("sites.notIncluded", locale)}
                  </Td>
                )}
                <Td className="text-right">{open(r)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Card>
      <p className="mt-3 text-xs text-sand-600">{t("sites.note", locale)}</p>
    </PageContainer>
  );
}
