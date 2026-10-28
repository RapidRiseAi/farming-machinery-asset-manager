import Link from "next/link";
import { redirect } from "next/navigation";

import { checkEntitlement, currentFarmId, homePathFor, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/supabase/must";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate, todayLocal } from "@/lib/format";
import { longMonthYear } from "@/lib/month-names";
import { downloadLabels } from "@/lib/interaction-labels";
import {
  CASHFLOW_MONTHS,
  FINANCE_EXPORT_FEATURE,
  UPCOMING_WINDOW_DAYS,
  addDays,
  addMonths,
  commitmentGross,
  financeSavedKey,
  monthlyCashflow,
} from "@/lib/asset-finance";
import { canViewFarmFinance, readCommitments, readFinanceBook } from "@/lib/asset-finance-read";

import { Card, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Flash } from "@/components/ui/flash";
import { Badge } from "@/components/ui/badge";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { GetStarted } from "@/components/ui/empty-state";
import { DialogActions, DialogForm } from "@/components/ui/dialog-form";
import { SubmitButton } from "@/components/ui/submit-button";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { DownloadLink } from "@/components/ui/download-link";
import { buttonVariants } from "@/components/ui/button";
import { PlusIcon } from "@/components/ui/icons";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { AgreementCard, ContractCard } from "@/components/asset-finance/finance-cards";
import { AgreementFields, ContractFields, type MachineOption } from "@/components/asset-finance/finance-fields";
import { commitmentKindLabel } from "@/components/asset-finance/labels";

import { createContract, createFinanceAgreement } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Finance and contracts: what the farm owes, what it has committed to, and when.
 *
 * == Who sees it ==============================================================
 * Owners and managers (founder default; `app.can_view_farm_finance`, 20261028110100).
 * Anyone else is sent home before a query runs, and RLS would hand them nothing anyway.
 * On every plan: only the cash-flow export sits behind `FINANCE_EXPORT_FEATURE`.
 *
 * == Cash and cost are different questions ====================================
 * The cash flow here counts every rand that leaves the bank, capital included, because
 * that is what the bank balance feels. The machine's TCO and the journal count only what
 * the credit COSTS (interest and fees) plus lease payments, because the machine's price is
 * already its purchase cost. The page says so once, under the cash flow.
 */
export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const L = (key: string) => t(`assetFinance.${key}`, locale);
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const sp = await searchParams;

  const farmId = await currentFarmId(profile);
  const supabase = await createClient();
  if (!farmId || !(await canViewFarmFinance(supabase, farmId))) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }

  const today = todayLocal();
  const horizon = addDays(addMonths(today, CASHFLOW_MONTHS), -1);
  const [book, commitments, machineData, exportGate] = await Promise.all([
    readFinanceBook(supabase, farmId, today),
    readCommitments(supabase, farmId, today, horizon),
    supabase.from("machines").select("id, name").eq("farm_id", farmId).is("deleted_at", null).order("name"),
    checkEntitlement(FINANCE_EXPORT_FEATURE, profile),
  ]);
  const machines = (must(machineData, "finance:machines") as MachineOption[] | null) ?? [];
  const machineName = new Map(machines.map((m) => [m.id, m.name]));
  const docsFor = (id: string) => book.docs.filter((d) => d.parent_id === id);

  // == The figures at the top ================================================
  const summaries = [...book.summaries.values()];
  const owed = summaries.reduce((sum, s) => sum + s.balance_cents, 0);
  const overdueCount = summaries.reduce((sum, s) => sum + s.overdue_count, 0);
  const overdueCents = summaries.reduce((sum, s) => sum + s.overdue_cents, 0);
  const in30 = addDays(today, 30);
  const due30 = commitments
    .filter((c) => c.amount_cents != null && c.on_date <= in30)
    .reduce((sum, c) => sum + commitmentGross(c), 0);
  const upcomingEnd = addDays(today, UPCOMING_WINDOW_DAYS);
  const contractDates = commitments.filter(
    (c) => (c.kind === "contract_end" || c.kind === "contract_notice") && c.on_date <= upcomingEnd,
  ).length;

  const upcoming = commitments.filter((c) => c.on_date <= upcomingEnd).slice(0, 40);
  const months = monthlyCashflow(commitments, today.slice(0, 7), CASHFLOW_MONTHS);
  const yearTotal = months.reduce((sum, m) => sum + m.totalCents, 0);

  const saved = financeSavedKey(sp.saved);
  const empty = book.agreements.length === 0 && book.contracts.length === 0;

  const addAgreement = (
    <DialogForm
      trigger={L("addAgreement")}
      triggerIcon={<PlusIcon />}
      title={L("addAgreementTitle")}
      description={L("addAgreementBody")}
      closeLabel={closeLabel}
      size="lg"
    >
      <form action={createFinanceAgreement}>
        <RequestIdInput action="finance:create-agreement" />
        <input type="hidden" name="back" value="/finance" />
        <AgreementFields locale={locale} idPrefix="na-farm" machines={machines} today={today} />
        <DialogActions cancelLabel={cancelLabel} note={L("exVatNote")}>
          <SubmitButton variant="primary">{L("addAgreement")}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );
  const addContract = (
    <DialogForm
      trigger={L("addContract")}
      triggerIcon={<PlusIcon />}
      triggerVariant="secondary"
      title={L("addContractTitle")}
      description={L("addContractBody")}
      closeLabel={closeLabel}
      size="lg"
    >
      <form action={createContract}>
        <RequestIdInput action="finance:create-contract" />
        <input type="hidden" name="back" value="/finance" />
        <input type="hidden" name="farm_id" value={farmId} />
        <ContractFields locale={locale} idPrefix="nc-farm" machines={machines} today={today} />
        <DialogActions cancelLabel={cancelLabel} note={L("exVatNote")}>
          <SubmitButton variant="primary">{L("addContract")}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  return (
    <PageContainer>
      <PageHeader
        title={L("title")}
        lead={L("lead")}
        actions={
          empty ? undefined : (
            <div className="flex flex-wrap gap-2">
              {addAgreement}
              {addContract}
            </div>
          )
        }
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={saved ? t(saved, locale) : undefined} />

      {empty ? (
        <GetStarted
          title={L("emptyTitle")}
          hint={L("emptyBody")}
          action={addAgreement}
          secondaryAction={addContract}
        />
      ) : (
        <>
          {/* One tile a row on a phone: an amount is one unbreakable token (CLAUDE.md). */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat size="md" label={L("statOwed")} value={rands(owed)} valueClassName="text-xl" />
            <Stat size="md" label={L("statDue30")} value={rands(due30)} valueClassName="text-xl" />
            <Stat
              size="md"
              label={L("statOverdue")}
              value={overdueCount > 0 ? rands(overdueCents) : rands(0)}
              tone={overdueCount > 0 ? "overdue" : "default"}
              valueClassName="text-xl"
            />
            <Stat size="md" label={L("statContractDates")} value={String(contractDates)} valueClassName="text-xl" />
          </div>

          <Card>
            <CardTitle>{L("upcomingTitle")}</CardTitle>
            <p className="mt-1 text-xs text-sand-500">{L("upcomingHint")}</p>
            {upcoming.length === 0 ? (
              <p className="mt-3 text-sm text-sand-500">{L("upcomingEmpty")}</p>
            ) : (
              <ul className="mt-3 flex flex-col divide-y divide-sand-100">
                {upcoming.map((c) => (
                  <li key={`${c.kind}-${c.item_id ?? c.source_id}-${c.on_date}`} className="flex items-start justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">
                        {shortDate(c.on_date, locale)}
                        {" · "}
                        {c.party ?? ""}
                      </p>
                      <p className="text-xs text-sand-600">
                        {commitmentKindLabel(c.kind, locale)}
                        {c.machine_name ? ` · ${c.machine_name}` : ""}
                        {c.reference ? ` · ${c.reference}` : ""}
                      </p>
                    </div>
                    {c.amount_cents != null ? (
                      <span className="shrink-0 text-sm font-medium tabular-nums text-ink">{rands(commitmentGross(c))}</span>
                    ) : (
                      <Badge tone="warning">{L("dateOnly")}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card id="cashflow">
            <CardTitle>{L("cashflowTitle")}</CardTitle>
            <p className="mt-1 text-xs text-sand-500">{L("cashflowHint")}</p>
            <ul className="mt-3 flex flex-col divide-y divide-sand-100 text-sm">
              {months.map((m) => (
                <li key={m.month} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2">
                  <span className="font-medium text-ink">{longMonthYear(`${m.month}-01`, locale)}</span>
                  <span className="text-xs text-sand-500">
                    {L("cashflowSplit").replace("{finance}", rands(m.financeCents)).replace("{contracts}", rands(m.contractCents))}
                  </span>
                  <span className="w-full text-right font-semibold tabular-nums text-ink sm:w-auto">{rands(m.totalCents)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 flex justify-between border-t border-sand-100 pt-3 text-sm font-semibold text-ink">
              <span>{L("cashflowTotal")}</span>
              <span className="tabular-nums">{rands(yearTotal)}</span>
            </p>
            <p className="mt-3 text-xs text-sand-500">{L("cashVsCost")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {exportGate.allowed ? (
                <>
                  <DownloadLink
                    href="/api/finance/cashflow.csv"
                    labels={downloadLabels(locale)}
                    className={buttonVariants({ variant: "secondary", size: "sm" })}
                  >
                    {L("exportCsv")}
                  </DownloadLink>
                  <DownloadLink
                    href="/api/finance/cashflow.xlsx"
                    labels={downloadLabels(locale)}
                    className={buttonVariants({ variant: "secondary", size: "sm" })}
                  >
                    {L("exportWorkbook")}
                  </DownloadLink>
                </>
              ) : (
                <UpgradeNotice
                  feature={FINANCE_EXPORT_FEATURE}
                  requiredPlan={exportGate.requiredPlan}
                  currentPlan={exportGate.plan}
                  locale={locale}
                  compact
                  canUpgrade={profile.role === "owner"}
                />
              )}
            </div>
          </Card>

          <Card flush>
            <div className="p-4 pb-0 sm:p-5 sm:pb-0">
              <CardTitle>{L("agreementsTitle")}</CardTitle>
              <p className="mt-1 text-xs text-sand-500">{L("agreementsHint")}</p>
            </div>
            {book.agreements.length === 0 ? (
              <p className="p-4 text-sm text-sand-500 sm:p-5">{L("agreementsEmpty")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-sand-200">
                {book.agreements.map((a) => (
                  <AgreementCard
                    key={a.id}
                    agreement={a}
                    instalments={book.instalments.filter((i) => i.agreement_id === a.id)}
                    summary={book.summaries.get(a.id)}
                    locale={locale}
                    back="/finance"
                    today={today}
                    docs={docsFor(a.id)}
                    machineId={a.machine_id}
                    machineName={machineName.get(a.machine_id) ?? null}
                  />
                ))}
              </ul>
            )}
          </Card>

          <Card flush>
            <div className="p-4 pb-0 sm:p-5 sm:pb-0">
              <CardTitle>{L("contractsTitle")}</CardTitle>
              <p className="mt-1 text-xs text-sand-500">{L("contractsHint")}</p>
            </div>
            {book.contracts.length === 0 ? (
              <p className="p-4 text-sm text-sand-500 sm:p-5">{L("contractsEmpty")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-sand-200">
                {book.contracts.map((c) => (
                  <ContractCard
                    key={c.id}
                    contract={c}
                    machines={machines}
                    locale={locale}
                    back="/finance"
                    today={today}
                    docs={docsFor(c.id)}
                    machineId={c.machine_id}
                    machineName={c.machine_id ? machineName.get(c.machine_id) ?? null : null}
                  />
                ))}
              </ul>
            )}
          </Card>

          <p className="text-xs text-sand-500">
            <Link href="/calendar" className="font-medium text-brand-ink underline">
              {L("calendarLink")}
            </Link>
          </p>
        </>
      )}
    </PageContainer>
  );
}
