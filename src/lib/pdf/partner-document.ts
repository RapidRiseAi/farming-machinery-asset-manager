import "server-only";

import { Pdf } from "@/lib/pdf/doc";
import { rands } from "@/lib/money";
import { vatPercent } from "@/lib/format";
import { brandingFrom, brandingOf, type Branding } from "@/lib/branding";
import { brandingLogoBytes } from "@/lib/partner-media";
import { balanceDueCents, type DocKind } from "@/lib/partner-docs";

/**
 * A quote, invoice or credit note as a PDF on the partner's letterhead.
 *
 * Pulled out of the authenticated route so the emailed attachment and the customer's
 * public link render the SAME document — a partner's copy and the customer's copy
 * disagreeing is the kind of defect nobody reports and everybody distrusts.
 *
 * ── WHAT MAKES IT A TAX INVOICE ──────────────────────────────────────────────
 *
 * The old version printed the supplier's VAT number and address in full and reduced the
 * recipient to `farm.name`. Section 20(4) of the VAT Act requires the recipient's name,
 * address AND VAT registration number on a full tax invoice for a supply over R5 000 —
 * so a VAT-registered farmer could not claim the input tax on anything we produced, and
 * would only discover it at their VAT return. The bill-to block below is that fix.
 */

export type PdfDocRow = {
  id: string;
  kind: DocKind;
  number: string;
  subject: string | null;
  issue_date: string;
  due_date: string | null;
  status: string;
  source: string;
  subtotal_cents: number;
  discount_cents: number;
  vat_cents: number;
  total_cents: number;
  vat_rate_bps: number;
  amount_paid_cents: number;
  notes: string | null;
  terms: string | null;
  void_reason: string | null;
  bill_to_name: string | null;
  bill_to_contact: string | null;
  bill_to_email: string | null;
  bill_to_phone: string | null;
  bill_to_address: string | null;
  bill_to_vat_number: string | null;
  bill_to_reg_number: string | null;
  bill_to_reference: string | null;
  issuer_snapshot: unknown;
};

export type PdfLine = {
  description: string;
  part_no: string | null;
  qty: number;
  unit_price_cents: number;
  line_total_cents: number;
};

export type PdfContext = {
  doc: PdfDocRow;
  lines: PdfLine[];
  workshop: unknown;
  machine: { name: string; reg_no: string | null } | null;
  /** The invoice this credit note corrects, when there is one. */
  corrects: { number: string; issue_date: string } | null;
};

const LABEL: Record<DocKind, string> = {
  quote: "Quote",
  invoice: "Invoice",
  credit_note: "Credit note",
};

export function documentLabel(kind: DocKind): string {
  return LABEL[kind] ?? "Document";
}

export function documentFilename(doc: Pick<PdfDocRow, "kind" | "number">): string {
  return `${documentLabel(doc.kind).replace(/\s+/g, "-").toLowerCase()}-${doc.number}.pdf`;
}

export async function buildDocumentPdf(ctx: PdfContext): Promise<{ bytes: Uint8Array; brand: Branding }> {
  const { doc, lines, machine, corrects } = ctx;
  const brand = brandingOf(doc.issuer_snapshot as never, brandingFrom(ctx.workshop as never));
  const logo = await brandingLogoBytes(brand.logo_path ?? null);

  const label = documentLabel(doc.kind);
  const isInvoice = doc.kind === "invoice";
  const isCredit = doc.kind === "credit_note";
  // A partner who is not VAT registered issues no VAT line anywhere on the document.
  // Printing "VAT 0.00" would still assert they charge it — the claim they must not make.
  const charging = Number(doc.vat_rate_bps) > 0;

  const pdf = await Pdf.create(`${label} ${doc.number}`, {
    name: brand.name,
    primary: brand.brand_primary,
    logo,
    footer: brand.footer,
    poweredBy: brand.show_powered_by !== false,
  });

  pdf.header([doc.bill_to_name, machine?.name].filter(Boolean).join(" · ") || undefined);

  // A void document must say so on its face. Otherwise a copy saved to someone's desktop
  // last month outlives the correction, and the number on it goes on being believed.
  if (doc.status === "void") {
    pdf.heading("Voided");
    pdf.text(`This ${label.toLowerCase()} has been cancelled and is not payable.`);
    if (doc.void_reason) pdf.kv("Reason", doc.void_reason);
  }

  pdf.heading("From");
  pdf.kv("Business", brand.name);
  if (brand.reg_number) pdf.kv("Registration", brand.reg_number);
  if (brand.vat_number) pdf.kv("VAT number", brand.vat_number);
  if (brand.address) pdf.kv("Address", brand.address);
  if (brand.phone) pdf.kv("Phone", brand.phone);
  if (brand.email) pdf.kv("Email", brand.email);

  // The recipient block, in full — this is what makes it claimable.
  pdf.heading("To");
  pdf.kv("Customer", doc.bill_to_name ?? "");
  if (doc.bill_to_contact) pdf.kv("Attention", doc.bill_to_contact);
  if (doc.bill_to_reg_number) pdf.kv("Registration", doc.bill_to_reg_number);
  if (doc.bill_to_vat_number) pdf.kv("VAT number", doc.bill_to_vat_number);
  if (doc.bill_to_address) pdf.kv("Address", doc.bill_to_address);
  if (doc.bill_to_email) pdf.kv("Email", doc.bill_to_email);
  if (machine) pdf.kv("Vehicle", [machine.name, machine.reg_no].filter(Boolean).join(" · "));
  if (doc.subject) pdf.kv("Subject", doc.subject);

  pdf.heading("Details");
  pdf.kv(`${label} number`, doc.number);
  pdf.kv("Issued", doc.issue_date);
  if (doc.bill_to_reference) pdf.kv("Your reference", doc.bill_to_reference);
  if (doc.due_date && !isCredit) pdf.kv(isInvoice ? "Due by" : "Valid until", doc.due_date);
  // A credit note that does not name the invoice it corrects is not a credit note.
  if (isCredit && corrects) pdf.kv("Corrects invoice", `${corrects.number} of ${corrects.issue_date}`);

  if (lines.length > 0) {
    pdf.heading("Items");
    pdf.table(
      charging
        ? ["Description", "Qty", "Unit (ex VAT)", "Total (ex VAT)"]
        : ["Description", "Qty", "Unit", "Total"],
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
  pdf.kv(charging ? "Subtotal (ex VAT)" : "Subtotal", rands(doc.subtotal_cents));
  if (doc.discount_cents > 0) pdf.kv("Discount", `-${rands(doc.discount_cents)}`);
  if (charging) pdf.kv(`VAT (${vatPercent(doc.vat_rate_bps)})`, rands(doc.vat_cents));
  pdf.kv(isCredit ? "Total credited" : "Total", rands(doc.total_cents));
  if (isInvoice && doc.amount_paid_cents > 0) {
    pdf.kv("Paid so far", `-${rands(doc.amount_paid_cents)}`);
    pdf.kv("Balance due", rands(balanceDueCents(doc as never)));
  }

  if (isInvoice && brand.bank_name) {
    pdf.heading("How to pay");
    pdf.kv("Account name", brand.bank_account_name ?? brand.name);
    pdf.kv("Bank", brand.bank_name);
    if (brand.bank_account_number) pdf.kv("Account number", brand.bank_account_number);
    if (brand.bank_branch_code) pdf.kv("Branch code", brand.bank_branch_code);
    if (brand.bank_account_type) pdf.kv("Account type", brand.bank_account_type);
    pdf.kv("Reference", doc.number);
  }

  if (isCredit) {
    pdf.heading("What this means");
    pdf.text(
      corrects
        ? `This credit note reduces invoice ${corrects.number} by ${rands(doc.total_cents)}. Nothing is payable on this document.`
        : "Nothing is payable on this document.",
    );
  }

  if (doc.notes) {
    pdf.heading("Notes");
    pdf.text(doc.notes);
  }
  if (doc.terms) {
    pdf.heading("Terms");
    pdf.text(doc.terms);
  }

  return { bytes: await pdf.save(), brand };
}
