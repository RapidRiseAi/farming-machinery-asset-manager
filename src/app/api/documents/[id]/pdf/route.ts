import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Pdf, pdfResponse } from "@/lib/pdf/doc";
import { rands } from "@/lib/money";
import { vatPercent } from "@/lib/format";
import { brandingFrom, brandingOf } from "@/lib/branding";
import { brandingLogoBytes } from "@/lib/partner-media";
import { balanceDueCents } from "@/lib/partner-docs";

export const dynamic = "force-dynamic";

/**
 * A quote or invoice as a PDF, on the PARTNER's letterhead (F14f).
 *
 * The document is fetched through the RLS-bound client, so this route needs no access
 * check of its own: `app.partner_doc_visible` (0381) already decides who may read the
 * row, which means a partner cannot pull another partner's invoice by guessing an id,
 * and a farm cannot pull another farm's.
 *
 * Branding comes from the document's own `issuer_snapshot` when it has one — a partner
 * who rebrands next year must not silently restate last year's invoice in new colours.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Forbidden", { status: 403 });

  const { id } = await params;
  const supabase = await createClient();

  const { data } = await supabase
    .from("partner_documents")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const doc = data as Record<string, unknown> | null;
  if (!doc) return new Response("Not found", { status: 404 });

  const [{ data: lineData }, { data: farmData }, { data: shopData }, { data: machineData }] = await Promise.all([
    supabase
      .from("partner_document_lines")
      .select("description, part_no, qty, unit_price_cents, line_total_cents")
      .eq("document_id", id)
      .is("deleted_at", null)
      .order("sort_order"),
    supabase.from("farms").select("name").eq("id", doc.farm_id as string).maybeSingle(),
    supabase.from("workshops").select("*").eq("id", doc.workshop_id as string).maybeSingle(),
    doc.machine_id
      ? supabase.from("machines").select("name, reg_number").eq("id", doc.machine_id as string).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const lines = (lineData ?? []) as {
    description: string; part_no: string | null; qty: number;
    unit_price_cents: number; line_total_cents: number;
  }[];
  const farm = farmData as { name: string } | null;
  const machine = machineData as { name: string; reg_number: string | null } | null;

  const brand = brandingOf(doc.issuer_snapshot as never, brandingFrom(shopData as never));
  const logo = await brandingLogoBytes(brand.logo_path ?? null);
  const isInvoice = doc.kind === "invoice";
  const label = isInvoice ? "Invoice" : "Quote";

  const pdf = await Pdf.create(`${label} ${doc.number as string}`, {
    name: brand.name,
    primary: brand.brand_primary,
    logo,
    footer: brand.footer,
    poweredBy: brand.show_powered_by !== false,
  });

  pdf.header([farm?.name, machine?.name].filter(Boolean).join(" · ") || undefined);

  // Who it is from, and who it is to — the two blocks any accountant looks for first.
  pdf.heading("From");
  pdf.kv("Business", brand.name);
  if (brand.reg_number) pdf.kv("Registration", brand.reg_number);
  if (brand.vat_number) pdf.kv("VAT number", brand.vat_number);
  if (brand.address) pdf.kv("Address", brand.address);
  if (brand.phone) pdf.kv("Phone", brand.phone);
  if (brand.email) pdf.kv("Email", brand.email);

  pdf.heading("To");
  pdf.kv("Customer", farm?.name ?? "");
  if (machine) pdf.kv("Vehicle", [machine.name, machine.reg_number].filter(Boolean).join(" · "));
  if (doc.subject) pdf.kv("Subject", String(doc.subject));

  pdf.heading("Details");
  pdf.kv(`${label} number`, String(doc.number));
  pdf.kv("Issued", String(doc.issue_date));
  if (doc.due_date) pdf.kv(isInvoice ? "Due by" : "Valid until", String(doc.due_date));

  if (lines.length > 0) {
    pdf.heading("Items");
    pdf.table(
      ["Description", "Qty", "Unit (ex VAT)", "Total (ex VAT)"],
      lines.map((l) => [
        l.part_no ? `${l.description} (${l.part_no})` : l.description,
        String(l.qty),
        rands(l.unit_price_cents),
        rands(l.line_total_cents),
      ]),
      [260, 60, 90, 90],
      [false, true, true, true],
    );
  } else if (doc.source === "uploaded") {
    pdf.heading("Items");
    pdf.text("This document was produced in the partner's own system and attached as a file.");
  }

  pdf.heading("Totals");
  pdf.kv("Subtotal (ex VAT)", rands(Number(doc.subtotal_cents)));
  if (Number(doc.discount_cents) > 0) pdf.kv("Discount", `-${rands(Number(doc.discount_cents))}`);
  pdf.kv(`VAT (${vatPercent(Number(doc.vat_rate_bps))})`, rands(Number(doc.vat_cents)));
  pdf.kv("Total", rands(Number(doc.total_cents)));
  if (isInvoice && Number(doc.amount_paid_cents) > 0) {
    pdf.kv("Paid so far", `-${rands(Number(doc.amount_paid_cents))}`);
    pdf.kv("Balance due", rands(balanceDueCents(doc as never)));
  }

  if (isInvoice && brand.bank_name) {
    pdf.heading("How to pay");
    pdf.kv("Account name", brand.bank_account_name ?? brand.name);
    pdf.kv("Bank", brand.bank_name);
    if (brand.bank_account_number) pdf.kv("Account number", brand.bank_account_number);
    if (brand.bank_branch_code) pdf.kv("Branch code", brand.bank_branch_code);
    pdf.kv("Reference", String(doc.number));
  }

  if (doc.notes) {
    pdf.heading("Notes");
    pdf.text(String(doc.notes));
  }
  if (doc.terms) {
    pdf.heading("Terms");
    pdf.text(String(doc.terms), { size: 9 });
  }

  const bytes = await pdf.save();
  return pdfResponse(bytes, `${String(doc.number).toLowerCase()}.pdf`);
}
