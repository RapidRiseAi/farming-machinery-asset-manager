import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import {
  withRunningBalance, statementTotals, defaultStatementPeriod,
  AGEING_BUCKETS, EMPTY_AGEING, type StatementRow, type Ageing,
} from "@/lib/statement";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { AllClear, GetStarted } from "@/components/ui/empty-state";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { DownloadIcon } from "@/components/ui/icons";
import { StatementPicker } from "./picker";

export const dynamic = "force-dynamic";

type Party = { key: string; label: string; farm_id: string | null; client_id: string | null };

/**
 * A statement of account: what this customer owes, and how it got there.
 *
 * The arithmetic is entirely in SQL (`app.partner_statement`, `app.partner_ageing`), so
 * this page, the PDF and the CSV cannot disagree — and neither can drift from what the
 * database would say. AutoVault assembles the same document in a 544-line API route and
 * gets six things wrong, every one of them a consequence of reconstructing a ledger from
 * whatever rows happen to be there rather than reading it.
 *
 * The one that matters most is the opening balance. AutoVault filters by date and starts
 * the running balance at zero, so a March statement shows nothing owed from February and
 * the closing figure is not what the customer owes — it is what they were billed in
 * March. The first row here is `Balance brought forward` for exactly that reason.
 */
export default async function StatementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect("/documents");
  const locale = profile.lang;
  const sp = await searchParams;

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const supabase = await createClient();
  const period = defaultStatementPeriod();
  const from = sp.from || period.from;
  const to = sp.to || period.to;

  // Everyone this partner has ever billed — farms they are linked to and clients in their
  // own book. Both, in one list, because a partner does not think of them as two kinds.
  const [{ data: linkData }, { data: clientData }] = await Promise.all([
    supabase
      .from("workshop_links")
      .select("farm_id, farms(id, name)")
      .eq("workshop_id", workshop.id)
      .eq("status", "active")
      .is("deleted_at", null),
    supabase
      .from("partner_clients")
      .select("id, name")
      .eq("workshop_id", workshop.id)
      .is("deleted_at", null)
      .order("name"),
  ]);

  const farmParties: Party[] = [];
  for (const l of (linkData ?? []) as {
    farm_id: string;
    farms: { id: string; name: string } | { id: string; name: string }[] | null;
  }[]) {
    // PostgREST types an embedded relation as an array; it is one row here.
    const f = Array.isArray(l.farms) ? l.farms[0] : l.farms;
    if (f) farmParties.push({ key: `farm:${f.id}`, label: f.name, farm_id: f.id, client_id: null });
  }
  const clientParties: Party[] = ((clientData ?? []) as { id: string; name: string }[]).map((c) => ({
    key: `client:${c.id}`,
    label: c.name,
    farm_id: null,
    client_id: c.id,
  }));
  const parties: Party[] = [...farmParties, ...clientParties].sort((a, b) => a.label.localeCompare(b.label));

  const selected = parties.find((p) => p.key === sp.party) ?? parties[0] ?? null;

  let rows: StatementRow[] = [];
  let ageing: Ageing = EMPTY_AGEING;
  if (selected) {
    const [{ data: stmt }, { data: aged }] = await Promise.all([
      supabase.rpc("partner_statement", {
        p_workshop: workshop.id,
        p_farm: selected.farm_id,
        p_client: selected.client_id,
        p_from: from,
        p_to: to,
      }),
      supabase.rpc("partner_ageing", {
        p_workshop: workshop.id,
        p_farm: selected.farm_id,
        p_client: selected.client_id,
      }),
    ]);
    rows = (stmt ?? []) as StatementRow[];
    const agedRows = (aged ?? []) as Ageing[];
    ageing = agedRows[0] ?? EMPTY_AGEING;
  }

  const lines = withRunningBalance(rows);
  const totals = statementTotals(rows);
  const csvHref = selected
    ? `/api/statements/csv?party=${encodeURIComponent(selected.key)}&from=${from}&to=${to}`
    : "#";
  const pdfHref = selected
    ? `/api/statements/pdf?party=${encodeURIComponent(selected.key)}&from=${from}&to=${to}`
    : "#";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("statement.title", locale)}</h1>
            <PageInfoButton infoKey="statements" locale={locale} />
          </div>
          <p className="mt-0.5 text-sm text-sand-500">{t("statement.tagline", locale)}</p>
        </div>
        {selected ? (
          <div className="flex flex-wrap gap-2">
            <a href={pdfHref} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              <DownloadIcon className="text-[1.1rem]" /> {t("statement.pdf", locale)}
            </a>
            <a href={csvHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              {t("statement.csv", locale)}
            </a>
          </div>
        ) : null}
      </div>

      {parties.length === 0 ? (
        <GetStarted
          title={t("statement.noneTitle", locale)}
          hint={t("statement.noneBody", locale)}
          action={
            <Link href="/contractor/clients" className={buttonVariants({ variant: "primary" })}>
              {t("statement.addClient", locale)}
            </Link>
          }
        />
      ) : (
        <>
          <StatementPicker parties={parties} selected={selected?.key ?? ""} from={from} to={to} locale={locale} />

          {/* Ageing first: "how much is late" is the question, and the ledger is the answer. */}
          <Card>
            <CardHeader>
              <CardTitle>{t("statement.owedNow", locale)}</CardTitle>
            </CardHeader>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat
                label={t("statement.totalOwed", locale)}
                value={rands(ageing.total_cents)}
                tone={ageing.total_cents > 0 ? "brand" : "default"}
              />
              {AGEING_BUCKETS.map((b) => {
                const cents = ageing[b.field];
                return (
                  <Stat
                    key={b.key}
                    label={t(`statement.age.${b.key}`, locale)}
                    value={rands(cents)}
                    tone={cents > 0 && b.key !== "current" ? "due" : "default"}
                  />
                );
              })}
            </div>
            <p className="mt-2 text-sm text-sand-500">{t("statement.ageingHint", locale)}</p>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                {selected?.label}
                <Badge tone="neutral" className="ml-2 align-middle">
                  {shortDate(from, locale)} – {shortDate(to, locale)}
                </Badge>
              </CardTitle>
            </CardHeader>

            {lines.length === 0 ? (
              <AllClear title={t("statement.emptyTitle", locale)} hint={t("statement.emptyBody", locale)} />
            ) : (
              <>
                <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                  <table className="w-full min-w-[36rem] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-sand-200 text-left text-sand-500">
                        <th className="py-2 pr-3 font-medium">{t("statement.date", locale)}</th>
                        <th className="py-2 pr-3 font-medium">{t("statement.what", locale)}</th>
                        <th className="py-2 pr-3 text-right font-medium">{t("statement.charged", locale)}</th>
                        <th className="py-2 pr-3 text-right font-medium">{t("statement.paidOff", locale)}</th>
                        <th className="py-2 text-right font-medium">{t("statement.balance", locale)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l, i) => (
                        <tr key={`${l.kind}-${l.document_id ?? i}`} className="border-b border-sand-100 last:border-0">
                          <td className="py-2.5 pr-3 whitespace-nowrap text-sand-600">{shortDate(l.entry_date, locale)}</td>
                          <td className="py-2.5 pr-3">
                            <span className="text-sand-900">{l.description}</span>
                            {l.reference ? (
                              l.document_id ? (
                                <Link
                                  href={`/documents/${l.document_id}`}
                                  className="focus-ring ml-2 rounded text-brand-700 underline-offset-2 hover:underline"
                                >
                                  {l.reference}
                                </Link>
                              ) : (
                                <span className="ml-2 text-sand-500">{l.reference}</span>
                              )
                            ) : null}
                          </td>
                          <td className="py-2.5 pr-3 text-right tabular-nums text-sand-900">
                            {l.debit_cents ? rands(l.debit_cents) : ""}
                          </td>
                          <td className="py-2.5 pr-3 text-right tabular-nums text-sand-900">
                            {l.credit_cents ? rands(l.credit_cents) : ""}
                          </td>
                          <td className="py-2.5 text-right font-medium tabular-nums text-sand-900">
                            {rands(l.balance_cents)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 border-t border-sand-200 pt-3 text-sm sm:max-w-sm">
                  <dt className="text-sand-600">{t("statement.opening", locale)}</dt>
                  <dd className="text-right tabular-nums text-sand-900">{rands(totals.openingCents)}</dd>
                  <dt className="text-sand-600">{t("statement.invoiced", locale)}</dt>
                  <dd className="text-right tabular-nums text-sand-900">{rands(totals.invoicedCents)}</dd>
                  {totals.creditedCents > 0 ? (
                    <>
                      <dt className="text-sand-600">{t("statement.credited", locale)}</dt>
                      <dd className="text-right tabular-nums text-sand-900">−{rands(totals.creditedCents)}</dd>
                    </>
                  ) : null}
                  <dt className="text-sand-600">{t("statement.received", locale)}</dt>
                  <dd className="text-right tabular-nums text-sand-900">−{rands(totals.paidCents)}</dd>
                  <dt className="pt-1 font-semibold text-sand-900">{t("statement.closing", locale)}</dt>
                  <dd className="pt-1 text-right font-semibold tabular-nums text-sand-900">
                    {rands(totals.closingCents)}
                  </dd>
                </dl>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
