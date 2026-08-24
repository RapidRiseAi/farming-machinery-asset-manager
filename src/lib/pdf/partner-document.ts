import "server-only";

import { Pdf } from "@/lib/pdf/doc";
import { rands } from "@/lib/money";
import { resolveLayout, pdfRowGap } from "@/lib/doc-layout";
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
  revision?: number;
  last_revision_reason?: string | null;
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

/**
 * The layout the partner chose, frozen onto the document at send time. The SAME resolver
 * the screen uses, so a customer who compares the emailed PDF with the page they were
 * linked to sees the same document — which is the entire point of putting the choices in
 * one closed set rather than letting each renderer interpret them.
 */
const LABEL: Record<DocKind, string> = {
  quote: "Quote",
  invoice: "Invoice",
  credit_note: "Credit note",
  debit_note: "Debit note",
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
  const layout = resolveLayout(brand.doc_layout);
  const logo = await brandingLogoBytes(brand.logo_path ?? null);

  // The title on the face of the document. A VAT-registered partner's invoice defaults to
  // "Tax invoice" because under VAT Act s20(4) it has to be headed as one to be a valid
  // tax invoice, and the customer's accountant will send it back if it is not.
  // A partner who is not VAT registered issues no VAT line anywhere on the document.
  // Printing "VAT 0.00" would still assert they charge it — the claim they must not make.
  const charging = Number(doc.vat_rate_bps) > 0;
  const label =
    doc.kind === "quote" ? (layout.quote_title ?? "Quote")
    : doc.kind === "credit_note" ? (layout.credit_title ?? "Credit note")
    : doc.kind === "debit_note" ? (layout.debit_title ?? "Debit note")
    : (layout.invoice_title ?? (charging ? "Tax invoice" : "Invoice"));
  const isInvoice = doc.kind === "invoice";
  const isCredit = doc.kind === "credit_note";
  const isDebit = doc.kind === "debit_note";
  const isNoteKind = isCredit || isDebit;

  const pdf = await Pdf.create(`${label} ${doc.number}`, {
    name: brand.name,
    primary: brand.brand_primary,
    logo,
    footer: brand.footer,
    poweredBy: brand.show_powered_by !== false,
    // 0505: the two 0434 keys this engine used to drop on the floor. A template that
    // promises "fits more on a page" or "no colour anywhere" is describing the EMAILED
    // PDF as much as the screen, so both keys have to reach here or the promise is only
    // half kept. `band` + `pdfRowGap("comfortable")` is the existing default and renders
    // exactly what this engine rendered before.
    accent: layout.accent_style,
    rowGap: pdfRowGap(layout.density),
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
  if (layout.show_vat_number && brand.vat_number) pdf.kv("VAT number", brand.vat_number);
  if (brand.address) pdf.kv("Address", brand.address);
  if (brand.phone) pdf.kv("Phone", brand.phone);
  if (brand.email) pdf.kv("Email", brand.email);

  // The recipient block, in full — this is what makes it claimable.
  //
  // The heading follows the partner's own `bill_to_label` (0434), like every other surface.
  // It was hardcoded to "To" here, so a partner who renamed it saw their wording on screen
  // and ours on the printed document — the one artefact the customer keeps.
  pdf.heading(layout.bill_to_label ?? "To");
  pdf.kv("Customer", doc.bill_to_name ?? "");
  if (doc.bill_to_contact) pdf.kv("Attention", doc.bill_to_contact);
  if (doc.bill_to_reg_number) pdf.kv("Registration", doc.bill_to_reg_number);
  if (doc.bill_to_vat_number) pdf.kv("VAT number", doc.bill_to_vat_number);
  if (doc.bill_to_address) pdf.kv("Address", doc.bill_to_address);
  if (doc.bill_to_email) pdf.kv("Email", doc.bill_to_email);
  if (layout.show_vehicle && machine) pdf.kv("Vehicle", [machine.name, machine.reg_no].filter(Boolean).join(" · "));
  if (doc.subject) pdf.kv("Subject", doc.subject);

  pdf.heading("Details");
  pdf.kv(`${label} number`, doc.number);
  pdf.kv("Issued", doc.issue_date);
  if (doc.bill_to_reference) pdf.kv("Your reference", doc.bill_to_reference);
  if (doc.due_date && !isNoteKind) pdf.kv(isInvoice ? "Due by" : "Valid until", doc.due_date);
  // A note that does not name the invoice it adjusts is not a note.
  if (isNoteKind && corrects) pdf.kv("Adjusts invoice", `${corrects.number} of ${corrects.issue_date}`);
  // A corrected document says so on its face, so a copy saved to somebody's desktop
  // cannot quietly outlive the version that replaced it.
  if ((doc.revision ?? 1) > 1) {
    pdf.kv("Version", String(doc.revision));
    if (doc.last_revision_reason) pdf.kv("Last corrected", doc.last_revision_reason);
  }

  if (lines.length > 0) {
    pdf.heading(layout.items_label ?? "Items");
    const headers = [
      ...(layout.show_line_numbers ? ["#"] : []),
      "Description",
      "Qty",
      ...(layout.show_unit_price ? [charging ? "Unit (ex VAT)" : "Unit"] : []),
      charging ? "Total (ex VAT)" : "Total",
    ];
    // The line-number column comes OUT of the description, not on top of the table. Before
    // this it was simply prepended, so turning line numbers on pushed the row 24pt wider
    // than the page's content width and the right-aligned total printed past the right
    // margin. Nobody saw it while the default was off; the "Fits more on a page" template
    // (0505) turns it on, so it would have shipped visibly.
    const numberW = layout.show_line_numbers ? 24 : 0;
    const widths = [
      ...(layout.show_line_numbers ? [numberW] : []),
      (layout.show_unit_price ? 260 : 340) - numberW,
      60,
      ...(layout.show_unit_price ? [90] : []),
      90,
    ];
    pdf.table(
      headers,
      lines.map((l, i) => [
        ...(layout.show_line_numbers ? [String(i + 1)] : []),
        l.part_no ? `${l.description} (${l.part_no})` : l.description,
        String(l.qty),
        ...(layout.show_unit_price ? [rands(l.unit_price_cents)] : []),
        rands(l.line_total_cents),
      ]),
      widths,
      headers.map((_, i) => i >= (layout.show_line_numbers ? 2 : 1)),
    );
  } else if (doc.source === "uploaded") {
    pdf.heading("Items");
    pdf.text("This document was produced in the partner's own system and attached as a file.");
  }

  pdf.heading("Totals");
  pdf.kv(charging ? "Subtotal (ex VAT)" : "Subtotal", rands(doc.subtotal_cents));
  if (doc.discount_cents > 0) pdf.kv("Discount", `-${rands(doc.discount_cents)}`);
  if (charging) pdf.kv(`VAT (${vatPercent(doc.vat_rate_bps)})`, rands(doc.vat_cents));
  pdf.kv(
    isCredit ? "Total credited" : isDebit ? "Additional amount due" : (layout.total_label ?? "Total"),
    rands(doc.total_cents),
  );
  if (isInvoice && doc.amount_paid_cents > 0) {
    pdf.kv("Paid so far", `-${rands(doc.amount_paid_cents)}`);
    pdf.kv("Balance due", rands(balanceDueCents(doc as never)));
  }

  if (layout.show_banking && isInvoice && brand.bank_name) {
    pdf.heading("How to pay");
    pdf.kv("Account name", brand.bank_account_name ?? brand.name);
    pdf.kv("Bank", brand.bank_name);
    if (brand.bank_account_number) pdf.kv("Account number", brand.bank_account_number);
    if (brand.bank_branch_code) pdf.kv("Branch code", brand.bank_branch_code);
    if (brand.bank_account_type) pdf.kv("Account type", brand.bank_account_type);
    pdf.kv("Reference", doc.number);
  }

  if (layout.show_thanks && layout.thanks_text) {
    pdf.text(layout.thanks_text);
  }
  if (layout.show_signature) {
    pdf.heading("Signature");
    pdf.kv("Signed", "____________________________");
    pdf.kv("Date", "____________________");
  }

  if (isNoteKind) {
    pdf.heading("What this means");
    pdf.text(
      isCredit
        ? corrects
          ? `This credit note reduces invoice ${corrects.number} by ${rands(doc.total_cents)}. Nothing is payable on this document.`
          : "Nothing is payable on this document."
        : corrects
          ? `This debit note adds ${rands(doc.total_cents)} to invoice ${corrects.number}. Pay it with that invoice, using the same reference.`
          : `This debit note adds ${rands(doc.total_cents)} to an earlier invoice.`,
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
