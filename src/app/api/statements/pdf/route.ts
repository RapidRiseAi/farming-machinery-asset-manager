import { requireRole, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Pdf, pdfResponse } from "@/lib/pdf/doc";
import { rands } from "@/lib/money";
import { brandingFrom } from "@/lib/branding";
import { brandingLogoBytes } from "@/lib/partner-media";
import {
  withRunningBalance, statementTotals, AGEING_BUCKETS, EMPTY_AGEING,
  type StatementRow, type Ageing,
} from "@/lib/statement";

export const dynamic = "force-dynamic";

const AGE_LABEL: Record<string, string> = {
  current: "Not yet due",
  d30: "1–30 days",
  d60: "31–60 days",
  d90: "60+ days",
};

/**
 * A statement of account as a PDF, on the partner's letterhead.
 *
 * Same rows as the screen and the CSV, because all three call
 * `app.partner_statement` — the reason that function exists rather than three
 * reconstructions that agree only by coincidence.
 *
 * `party` arrives as `farm:<uuid>` or `client:<uuid>`. Both are passed to a SECURITY
 * INVOKER function, so RLS decides whether this partner may see that customer's ledger; a
 * guessed id returns an empty statement rather than someone else's.
 */
export async function GET(request: Request) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) return new Response("Forbidden", { status: 403 });

  const url = new URL(request.url);
  const party = url.searchParams.get("party") ?? "";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const [kind, id] = party.split(":");
  if (!["farm", "client"].includes(kind) || !/^[0-9a-f-]{36}$/i.test(id ?? "")) {
    return new Response("Bad request", { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return new Response("Bad request", { status: 400 });
  }

  const farmId = kind === "farm" ? id : null;
  const clientId = kind === "client" ? id : null;
  const supabase = await createClient();

  const [{ data: stmt }, { data: aged }, { data: who }] = await Promise.all([
    supabase.rpc("partner_statement", {
      p_workshop: workshop.id, p_farm: farmId, p_client: clientId, p_from: from, p_to: to,
    }),
    supabase.rpc("partner_ageing", {
      p_workshop: workshop.id, p_farm: farmId, p_client: clientId,
    }),
    farmId
      ? supabase.from("farms").select("name, billing_address, vat_number").eq("id", farmId).maybeSingle()
      : supabase.from("partner_clients").select("name, address, vat_number").eq("id", clientId!).maybeSingle(),
  ]);

  const rows = (stmt ?? []) as StatementRow[];
  const ageing = ((aged ?? []) as Ageing[])[0] ?? EMPTY_AGEING;
  const party_ = who as { name: string; billing_address?: string | null; address?: string | null; vat_number: string | null } | null;

  const brand = brandingFrom(workshop);
  const logo = await brandingLogoBytes(brand.logo_path ?? null);
  const pdf = await Pdf.create(`Statement — ${party_?.name ?? ""}`, {
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
  pdf.kv("Customer", party_?.name ?? "");
  const address = party_?.billing_address ?? party_?.address ?? null;
  if (address) pdf.kv("Address", address);
  if (party_?.vat_number) pdf.kv("VAT number", party_.vat_number);
  pdf.kv("Period", `${from} to ${to}`);

  const lines = withRunningBalance(rows);
  if (lines.length > 0) {
    pdf.heading("Account activity");
    pdf.table(
      ["Date", "Detail", "Charged", "Paid off", "Balance"],
      lines.map((l) => [
        l.entry_date,
        [l.description, l.reference].filter(Boolean).join(" · "),
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
  pdf.kv("Balance due", rands(totals.closingCents));

  // The ageing is what turns a list of transactions into a request for payment.
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

  return pdfResponse(await pdf.save(), `statement-${(party_?.name ?? "customer").replace(/\W+/g, "-").toLowerCase()}-${to}.pdf`);
}
