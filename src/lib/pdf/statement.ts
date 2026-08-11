import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Pdf } from "@/lib/pdf/doc";
import { rands } from "@/lib/money";
import { brandingFrom, type Branding } from "@/lib/branding";
import { brandingLogoBytes } from "@/lib/partner-media";
import {
  withRunningBalance, statementTotals, statementLabel, AGEING_BUCKETS, EMPTY_AGEING,
  type StatementRow, type Ageing,
} from "@/lib/statement";
import type { Lang } from "@/lib/i18n";

/**
 * A statement of account as a PDF, on the partner's letterhead.
 *
 * Pulled out of the download route so the EMAILED statement and the downloaded one are
 * the same bytes — the same reason `buildDocumentPdf` exists. A customer who queries a
 * figure will be holding the emailed copy, and the partner will be looking at the
 * downloaded one; those disagreeing is the kind of thing nobody reports and everybody
 * stops trusting.
 */

const AGE_LABEL: Record<string, string> = {
  current: "Not yet due",
  d30: "1–30 days",
  d60: "31–60 days",
  d90: "60+ days",
};

export type StatementParty = {
  name: string;
  address: string | null;
  vat_number: string | null;
  email: string | null;
};

export type StatementData = {
  rows: StatementRow[];
  ageing: Ageing;
  party: StatementParty;
  brand: Branding;
  from: string;
  to: string;
  /** Whose language the row labels are written in. The headings are still English. */
  lang?: Lang;
};

/**
 * Everything the statement needs, fetched once through whichever client the caller
 * passes. Both `app.partner_statement` and `app.partner_ageing` are SECURITY INVOKER, so
 * an RLS-bound client is scoped by RLS and a service client is not — which is what lets
 * the nightly send run without a session.
 */
export async function loadStatement(
  supabase: SupabaseClient,
  args: {
    workshop: unknown; workshopId: string; farmId: string | null; clientId: string | null;
    from: string; to: string; lang?: Lang;
  },
): Promise<StatementData> {
  const [{ data: stmt }, { data: aged }, { data: who }] = await Promise.all([
    supabase.rpc("partner_statement", {
      p_workshop: args.workshopId, p_farm: args.farmId, p_client: args.clientId,
      p_from: args.from, p_to: args.to,
    }),
    supabase.rpc("partner_ageing", {
      p_workshop: args.workshopId, p_farm: args.farmId, p_client: args.clientId,
    }),
    args.farmId
      ? supabase.from("farms")
          .select("name, trading_name, billing_address, vat_number, billing_email")
          .eq("id", args.farmId).maybeSingle()
      : supabase.from("partner_clients")
          .select("name, trading_name, address, vat_number, email")
          .eq("id", args.clientId!).maybeSingle(),
  ]);

  const p = (who ?? {}) as Record<string, string | null>;
  return {
    rows: (stmt ?? []) as StatementRow[],
    ageing: ((aged ?? []) as Ageing[])[0] ?? EMPTY_AGEING,
    party: {
      name: p.trading_name || p.name || "",
      address: p.billing_address ?? p.address ?? null,
      vat_number: p.vat_number ?? null,
      email: p.billing_email ?? p.email ?? null,
    },
    brand: brandingFrom(args.workshop as never),
    from: args.from,
    to: args.to,
    lang: args.lang,
  };
}

export async function buildStatementPdf(data: StatementData): Promise<Uint8Array> {
  const { rows, ageing, party, brand, from, to } = data;
  const lang: Lang = data.lang ?? "en";
  const logo = await brandingLogoBytes(brand.logo_path ?? null);

  const pdf = await Pdf.create(`Statement — ${party.name}`, {
    name: brand.name,
    primary: brand.brand_primary,
    logo,
    footer: brand.footer,
    poweredBy: brand.show_powered_by !== false,
  });

  pdf.header(`${from} to ${to}`);

  pdf.heading("From");
  pdf.kv("Business", brand.name);
  if (brand.vat_number) pdf.kv("VAT number", brand.vat_number);
  if (brand.phone) pdf.kv("Phone", brand.phone);
  if (brand.email) pdf.kv("Email", brand.email);

  pdf.heading("Statement for");
  pdf.kv("Customer", party.name);
  if (party.address) pdf.kv("Address", party.address);
  if (party.vat_number) pdf.kv("VAT number", party.vat_number);
  pdf.kv("Period", `${from} to ${to}`);

  const lines = withRunningBalance(rows);
  if (lines.length > 0) {
    pdf.heading("Account activity");
    pdf.table(
      ["Date", "Detail", "Charged", "Paid off", "Balance"],
      lines.map((l) => [
        l.entry_date,
        [statementLabel(l, lang), l.reference].filter(Boolean).join(" · "),
        l.debit_cents ? rands(l.debit_cents) : "",
        l.credit_cents ? rands(l.credit_cents) : "",
        rands(l.balance_cents),
      ]),
      [70, 200, 75, 75, 80],
      [false, false, true, true, true],
    );
  } else {
    pdf.text("Nothing happened on this account in this period.");
  }

  const totals = statementTotals(rows);
  pdf.heading("Summary");
  pdf.kv("Balance brought forward", rands(totals.openingCents));
  pdf.kv("Invoiced", rands(totals.invoicedCents));
  if (totals.creditedCents > 0) pdf.kv("Credited", `-${rands(totals.creditedCents)}`);
  pdf.kv("Received", `-${rands(totals.paidCents)}`);
  if (totals.writtenOffCents > 0) pdf.kv("Written off", `-${rands(totals.writtenOffCents)}`);
  pdf.kv("Balance due", rands(totals.closingCents));

  pdf.heading("How old the balance is");
  for (const b of AGEING_BUCKETS) pdf.kv(AGE_LABEL[b.key], rands(ageing[b.field]));
  pdf.kv("Total outstanding", rands(ageing.total_cents));

  if (brand.bank_name) {
    pdf.heading("How to pay");
    pdf.kv("Account name", brand.bank_account_name ?? brand.name);
    pdf.kv("Bank", brand.bank_name);
    if (brand.bank_account_number) pdf.kv("Account number", brand.bank_account_number);
    if (brand.bank_branch_code) pdf.kv("Branch code", brand.bank_branch_code);
  }

  return pdf.save();
}

export function statementFilename(party: StatementParty, to: string): string {
  return `statement-${(party.name || "customer").replace(/\W+/g, "-").toLowerCase()}-${to}.pdf`;
}
