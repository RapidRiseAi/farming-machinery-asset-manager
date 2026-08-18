import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Pdf } from "@/lib/pdf/doc";
import { rands } from "@/lib/money";
import { brandingFrom, type Branding } from "@/lib/branding";
import { brandingLogoBytes } from "@/lib/partner-media";
import {
  withSupplierRunningBalance, supplierStatementTotals, supplierStatementLabel,
  remittanceTotals, SUPPLIER_AGEING_BUCKETS, EMPTY_SUPPLIER_AGEING,
  type SupplierStatementRow, type SupplierAgeing, type RemittanceRow,
} from "@/lib/supplier-statement";
import type { Lang } from "@/lib/i18n";

/**
 * A supplier statement and a remittance advice as PDFs, on the partner's own letterhead
 * (G25, migration 0502).
 *
 * The rendering is pulled out of the download routes for the reason `lib/pdf/statement.ts`
 * gives: whatever is emailed later and whatever is downloaded today must be the same bytes.
 * A remittance in particular is a document somebody else acts on — the supplier allocates
 * a payment from it — so a partner's copy and the supplier's copy differing is not a
 * cosmetic problem.
 *
 * ── Whose document is this, and whose letterhead ─────────────────────────────
 *
 * Both go OUT from the partner. The statement is the partner reconciling their side of a
 * supplier's account — "this is what I think I owe you" — and the remittance tells the
 * supplier what an EFT covered. So both carry the partner's letterhead (brand, logo,
 * footer) and address the SUPPLIER, which is the reverse of `lib/pdf/statement.ts` where
 * the partner bills a customer.
 *
 * Headings stay English, exactly as the rest of this PDF engine does; the ROW labels come
 * from `supplierStatementLabel` in the reader's language, because those are the lines that
 * describe money and 0502 deliberately keeps no wording in SQL.
 */

const AGE_LABEL: Record<string, string> = {
  current: "Not yet 30 days old",
  d30: "31–60 days",
  d60: "61–90 days",
  d90: "Over 90 days",
};

export type SupplierParty = {
  id: string;
  name: string;
  address: string | null;
  vat_number: string | null;
  /** OUR account number with THEM — what they need to allocate a payment. */
  account_number: string | null;
  email: string | null;
  payment_terms_days: number | null;
};

const PARTY_COLUMNS = "id, name, address, vat_number, account_number, email, payment_terms_days";

export type SupplierStatementData = {
  rows: SupplierStatementRow[];
  ageing: SupplierAgeing;
  party: SupplierParty;
  brand: Branding;
  from: string;
  to: string;
  /** Whose language the row labels are written in. The headings are still English. */
  lang?: Lang;
};

export type SupplierRemittanceData = {
  rows: RemittanceRow[];
  party: SupplierParty;
  brand: Branding;
  paidOn: string;
  lang?: Lang;
};

/**
 * Everything the statement needs, through whichever client the caller passes. The three
 * 0502 functions are SECURITY INVOKER, so an RLS-bound client is scoped by RLS — which is
 * also the access check: a supplier id belonging to another workshop reads back no party
 * row at all, and this returns null so the route can answer 404 rather than an empty
 * document with somebody else's letterhead on it.
 */
export async function loadSupplierStatement(
  supabase: SupabaseClient,
  args: {
    workshop: unknown; workshopId: string; supplierId: string;
    from: string; to: string; lang?: Lang;
  },
): Promise<SupplierStatementData | null> {
  const [{ data: stmt }, { data: aged }, { data: who }] = await Promise.all([
    supabase.rpc("supplier_statement", {
      p_workshop: args.workshopId, p_supplier: args.supplierId,
      p_from: args.from, p_to: args.to,
    }),
    supabase.rpc("supplier_ageing", {
      p_workshop: args.workshopId, p_supplier: args.supplierId,
    }),
    supabase.from("suppliers").select(PARTY_COLUMNS)
      .eq("id", args.supplierId).is("deleted_at", null).maybeSingle(),
  ]);

  if (!who) return null;

  return {
    rows: (stmt ?? []) as SupplierStatementRow[],
    ageing: ((aged ?? []) as SupplierAgeing[])[0] ?? EMPTY_SUPPLIER_AGEING,
    party: who as SupplierParty,
    brand: brandingFrom(args.workshop as never),
    from: args.from,
    to: args.to,
    lang: args.lang,
  };
}

/** The bills one payment covered. Null when the supplier is not this caller's to read. */
export async function loadSupplierRemittance(
  supabase: SupabaseClient,
  args: { workshop: unknown; workshopId: string; supplierId: string; paidOn: string; lang?: Lang },
): Promise<SupplierRemittanceData | null> {
  const [{ data: rows }, { data: who }] = await Promise.all([
    supabase.rpc("supplier_remittance", {
      p_workshop: args.workshopId, p_supplier: args.supplierId, p_paid_on: args.paidOn,
    }),
    supabase.from("suppliers").select(PARTY_COLUMNS)
      .eq("id", args.supplierId).is("deleted_at", null).maybeSingle(),
  ]);

  if (!who) return null;

  return {
    rows: (rows ?? []) as RemittanceRow[],
    party: who as SupplierParty,
    brand: brandingFrom(args.workshop as never),
    paidOn: args.paidOn,
    lang: args.lang,
  };
}

/** The partner's own block, identical on both documents so they read as one set. */
function issuerBlock(pdf: Pdf, brand: Branding) {
  pdf.heading("From");
  pdf.kv("Business", brand.name);
  if (brand.vat_number) pdf.kv("VAT number", brand.vat_number);
  if (brand.phone) pdf.kv("Phone", brand.phone);
  if (brand.email) pdf.kv("Email", brand.email);
}

function supplierBlock(pdf: Pdf, party: SupplierParty) {
  pdf.kv("Supplier", party.name);
  if (party.address) pdf.kv("Address", party.address);
  if (party.vat_number) pdf.kv("VAT number", party.vat_number);
  // The number they quote back on the phone, and the one thing that lets them allocate a
  // payment without ringing to ask who sent it.
  if (party.account_number) pdf.kv("Our account with you", party.account_number);
}

export async function buildSupplierStatementPdf(data: SupplierStatementData): Promise<Uint8Array> {
  const { rows, ageing, party, brand, from, to } = data;
  const lang: Lang = data.lang ?? "en";
  const logo = await brandingLogoBytes(brand.logo_path ?? null);

  const pdf = await Pdf.create(`Supplier statement — ${party.name}`, {
    name: brand.name,
    primary: brand.brand_primary,
    logo,
    footer: brand.footer,
    poweredBy: brand.show_powered_by !== false,
  });

  pdf.header(`${from} to ${to}`);

  issuerBlock(pdf, brand);

  pdf.heading("Statement of this supplier's account");
  supplierBlock(pdf, party);
  pdf.kv("Period", `${from} to ${to}`);
  // Said on the document, not only on the screen: a supplier reading a figure needs to know
  // it includes VAT, because their own statement of the same account may well be ex-VAT.
  pdf.text("Every amount below includes VAT — it is what left, or has to leave, the bank.");

  const lines = withSupplierRunningBalance(rows);
  if (lines.length > 0) {
    pdf.heading("Account activity");
    pdf.table(
      ["Date", "Detail", "Charged", "Paid", "Balance"],
      lines.map((l) => [
        l.entry_date,
        [supplierStatementLabel(l, lang), l.reference].filter(Boolean).join(" · "),
        l.debit_cents ? rands(l.debit_cents) : "",
        l.credit_cents ? rands(l.credit_cents) : "",
        rands(l.balance_cents),
      ]),
      [70, 200, 75, 75, 80],
      [false, false, true, true, true],
    );
  } else {
    pdf.text("Nothing was bought from this supplier, and nothing paid to them, in this period.");
  }

  const totals = supplierStatementTotals(rows);
  pdf.heading("Summary");
  pdf.kv("Balance brought forward", rands(totals.openingCents));
  pdf.kv("Invoiced by them", rands(totals.billedCents));
  pdf.kv("Paid to them", `-${rands(totals.paidCents)}`);
  pdf.kv("Balance owed", rands(totals.closingCents));

  pdf.heading("How old the balance is");
  for (const b of SUPPLIER_AGEING_BUCKETS) pdf.kv(AGE_LABEL[b.key], rands(ageing[b.field]));
  pdf.kv("Total outstanding", rands(ageing.total_cents));
  // A supplier invoice carries no due date, so the buckets count from the supplier's OWN
  // invoice date. Stating it stops the ageing being read as a claim about lateness.
  pdf.text("Counted from the date on each of your invoices, not from a due date.");

  return pdf.save();
}

export async function buildSupplierRemittancePdf(data: SupplierRemittanceData): Promise<Uint8Array> {
  const { rows, party, brand, paidOn } = data;
  const logo = await brandingLogoBytes(brand.logo_path ?? null);

  const pdf = await Pdf.create(`Remittance advice — ${party.name}`, {
    name: brand.name,
    primary: brand.brand_primary,
    logo,
    footer: brand.footer,
    poweredBy: brand.show_powered_by !== false,
  });

  pdf.header(`Remittance advice · ${paidOn}`);

  issuerBlock(pdf, brand);

  pdf.heading("Paid to");
  supplierBlock(pdf, party);
  pdf.kv("Payment date", paidOn);

  const totals = remittanceTotals(rows);
  if (rows.length > 0) {
    pdf.heading("What this payment covers");
    pdf.table(
      ["Your invoice", "Dated", "Detail", "Ex VAT", "VAT", "Total"],
      rows.map((r) => [
        r.reference ?? "",
        r.expense_date,
        r.description ?? "",
        rands(r.amount_cents),
        rands(r.vat_cents),
        rands(r.total_cents),
      ]),
      [80, 65, 130, 70, 60, 75],
      [false, false, false, true, true, true],
    );

    pdf.heading("Total paid");
    pdf.kv("Ex VAT", rands(totals.exCents));
    pdf.kv("VAT", rands(totals.vatCents));
    pdf.kv("Paid", rands(totals.totalCents));
    // The whole reason the document exists: one EFT against several invoices, allocated by
    // the person who sent it rather than guessed at by the person who received it.
    pdf.text(
      totals.bills === 1
        ? "This payment settles the invoice listed above."
        : `This single payment settles the ${totals.bills} invoices listed above.`,
    );
  } else {
    pdf.text("No invoices from this supplier are recorded as paid on this date.");
  }

  return pdf.save();
}

const slug = (name: string, fallback: string) =>
  (name || fallback).replace(/\W+/g, "-").replace(/^-|-$/g, "").toLowerCase() || fallback;

export function supplierStatementFilename(party: SupplierParty, to: string): string {
  return `supplier-statement-${slug(party.name, "supplier")}-${to}.pdf`;
}

export function supplierRemittanceFilename(party: SupplierParty, paidOn: string): string {
  return `remittance-${slug(party.name, "supplier")}-${paidOn}.pdf`;
}
