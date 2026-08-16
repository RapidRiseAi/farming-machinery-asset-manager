import { requireRole, currentWorkshop, workshopEntitlementOr403 } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Pdf, pdfResponse } from "@/lib/pdf/doc";
import { rands } from "@/lib/money";
import { brandingFrom } from "@/lib/branding";
import { brandingLogoBytes } from "@/lib/partner-media";
import { EMPTY_VAT_RETURN, type VatReturn } from "@/lib/expenses";

export const dynamic = "force-dynamic";

/**
 * The VAT return as a PDF, on the partner's letterhead — the thing they hand their
 * accountant or file away with the period's paperwork.
 *
 * It states the basis on its face. A return that does not say whether it is on the
 * invoice or the payments basis is ambiguous to anyone reading it later, and the
 * difference is the entire timing of the liability.
 */
export async function GET(request: Request) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) return new Response("Forbidden", { status: 403 });
  const denied = await workshopEntitlementOr403("financials", profile);
  if (denied) return denied;

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return new Response("Bad request", { status: 400 });
  }

  const supabase = await createClient();
  const { data } = await supabase.rpc("partner_vat_return", {
    p_workshop: workshop.id, p_from: from, p_to: to,
  });
  const v = (((data ?? []) as VatReturn[])[0] ?? EMPTY_VAT_RETURN);

  const brand = brandingFrom(workshop);
  const logo = await brandingLogoBytes(brand.logo_path ?? null);
  const pdf = await Pdf.create(`VAT return — ${from} to ${to}`, {
    name: brand.name,
    primary: brand.brand_primary,
    logo,
    footer: brand.footer,
    poweredBy: brand.show_powered_by !== false,
  });

  pdf.header(`${from} to ${to}`);

  pdf.heading("Vendor");
  pdf.kv("Business", brand.name);
  if (brand.vat_number) pdf.kv("VAT number", brand.vat_number);
  if (brand.reg_number) pdf.kv("Company registration", brand.reg_number);
  pdf.kv("Period", `${from} to ${to}`);
  pdf.kv("Basis", "Invoice basis (time of supply)");

  pdf.heading("Output tax — what you charged");
  pdf.kv("Standard-rated sales (ex VAT)", rands(v.standard_ex_cents));
  if (v.zero_rated_cents > 0) pdf.kv("Zero-rated sales (ex VAT)", rands(v.zero_rated_cents));
  if (v.credits_ex_cents > 0) pdf.kv("Credit notes issued (ex VAT)", `-${rands(v.credits_ex_cents)}`);
  pdf.kv("Output VAT", rands(v.output_vat_cents));

  pdf.heading("Input tax — what you were charged");
  pdf.kv("Purchases (ex VAT, claimable)", rands(v.input_ex_cents));
  pdf.kv("Input VAT", rands(v.input_vat_cents));
  if (v.blocked_vat_cents > 0) pdf.kv("VAT paid but not claimable", rands(v.blocked_vat_cents));

  pdf.heading(v.net_vat_cents >= 0 ? "Payable to SARS" : "Refundable by SARS");
  pdf.kv(v.net_vat_cents >= 0 ? "Net VAT payable" : "Net VAT refundable", rands(Math.abs(v.net_vat_cents)));

  if (v.written_off_vat_cents > 0) {
    pdf.heading("Note");
    pdf.text(
      `${rands(v.written_off_vat_cents)} of the output VAT above sits on invoices that have been written off. ` +
      "Bad-debt relief is a separate claim under section 22 and has not been applied here.",
    );
  }

  pdf.text(
    "Prepared on the invoice basis: VAT is declared in the period an invoice was issued, not when it was paid. " +
    "Figures come from the documents and supplier invoices captured in FleetWise for this period.",
  );

  return pdfResponse(await pdf.save(), `vat-return-${from}-to-${to}.pdf`);
}
