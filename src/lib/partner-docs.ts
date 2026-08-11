/**
 * Partner documents — quotes and invoices (F14b, migration 0381).
 *
 * The shared model both sides read: the partner building or uploading the document, and
 * the farmer receiving it. Totals are mirrored from the SQL triggers so a line edited in
 * the browser shows the same number the database will store — the same discipline
 * `src/lib/fuel.ts` keeps with the consumption engine.
 *
 * Money throughout is integer cents. LINES ARE EX-VAT; the document total is
 * VAT-inclusive, because that is the number a farmer actually pays. Never introduce a
 * float here.
 */

export const DOC_KINDS = ["quote", "invoice", "credit_note", "debit_note"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** The kinds a partner starts from scratch. Both notes are always raised AGAINST an invoice. */
export const NEW_DOC_KINDS = ["quote", "invoice"] as const;

export const DOC_SOURCES = ["built", "uploaded"] as const;
export type DocSource = (typeof DOC_SOURCES)[number];

export const DOC_STATUSES = [
  "draft", "sent", "accepted", "declined", "part_paid", "paid", "cancelled", "expired", "void",
  // The customer is never going to pay (0422/0423). Not the same as void: the invoice was
  // correct and the work was done, so it stays on the statement and in the farm's cost
  // ledger — it just stops being money anyone is waiting for.
  "written_off",
] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const DOC_LINE_KINDS = ["part", "labour", "other"] as const;
export type DocLineKind = (typeof DOC_LINE_KINDS)[number];

export type DocLine = {
  id?: string;
  sort_order: number;
  kind: DocLineKind;
  part_no: string | null;
  description: string;
  qty: number;
  unit_price_cents: number;
  discount_cents: number;
  line_total_cents: number;
};

/**
 * Who a document is addressed to (0410). Exactly one of `farm_id` / `partner_client_id`
 * is set, or neither for a one-time customer typed straight onto the document. The
 * `bill_to_*` fields are what PRINTS, seeded from the farm or client and then editable —
 * a customer who moves premises next year must not silently restate last year's invoice.
 */
export type BillTo = {
  bill_to_name: string;
  bill_to_contact: string | null;
  bill_to_email: string | null;
  bill_to_phone: string | null;
  bill_to_address: string | null;
  bill_to_vat_number: string | null;
  bill_to_reg_number: string | null;
  bill_to_reference: string | null;
};

export type PartnerDocument = BillTo & {
  id: string;
  farm_id: string | null;
  partner_client_id: string | null;
  corrects_document_id: string | null;
  void_reason: string | null;
  workshop_id: string;
  machine_id: string | null;
  work_request_id: string | null;
  quote_id: string | null;
  kind: DocKind;
  status: DocStatus;
  source: DocSource;
  number: string;
  subject: string | null;
  issue_date: string;
  due_date: string | null;
  subtotal_cents: number;
  discount_cents: number;
  vat_cents: number;
  total_cents: number;
  vat_rate_bps: number;
  amount_paid_cents: number;
  notes: string | null;
  terms: string | null;
  declined_reason: string | null;
  upload_path: string | null;
  issuer_snapshot: IssuerSnapshot | null;
  created_at: string;
};

/** The letterhead frozen onto a document when it was issued (0381 `issuer_snapshot`). */
export type IssuerSnapshot = {
  name: string;
  reg_number?: string | null;
  vat_number?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  bank_name?: string | null;
  bank_account_name?: string | null;
  bank_account_number?: string | null;
  bank_branch_code?: string | null;
  bank_account_type?: string | null;
  brand_primary?: string | null;
  brand_secondary?: string | null;
  logo_path?: string | null;
  terms?: string | null;
  footer?: string | null;
  show_powered_by?: boolean;
  /** The layout chosen when this document was issued (G9, `lib/doc-layout`). */
  doc_layout?: unknown;
};

// ── Totals, mirroring the 0381 triggers ────────────────────────────

/** qty × unit price − line discount, ex-VAT, floored at zero. */
export function lineTotalCents(line: Pick<DocLine, "qty" | "unit_price_cents" | "discount_cents">): number {
  return Math.max(0, Math.round(line.qty * line.unit_price_cents) - (line.discount_cents || 0));
}

export type DocTotals = {
  /** Sum of the lines, ex-VAT, before the whole-document discount. */
  subtotalCents: number;
  /** The whole-document discount actually applied (never more than the subtotal). */
  discountCents: number;
  /** Ex-VAT after discount — the figure that reaches the cost ledger. */
  netCents: number;
  vatCents: number;
  /** VAT-inclusive: what the farmer pays. */
  totalCents: number;
};

export function documentTotals(
  lines: readonly Pick<DocLine, "qty" | "unit_price_cents" | "discount_cents">[],
  vatRateBps: number,
  documentDiscountCents = 0,
): DocTotals {
  const subtotalCents = lines.reduce((sum, l) => sum + lineTotalCents(l), 0);
  const discountCents = Math.min(Math.max(0, documentDiscountCents), subtotalCents);
  const netCents = subtotalCents - discountCents;
  const vatCents = Math.round((netCents * vatRateBps) / 10000);
  return { subtotalCents, discountCents, netCents, vatCents, totalCents: netCents + vatCents };
}

/** What is still owed on an invoice, VAT-inclusive. Never negative. */
export function balanceDueCents(doc: Pick<PartnerDocument, "total_cents" | "amount_paid_cents">): number {
  return Math.max(0, doc.total_cents - (doc.amount_paid_cents || 0));
}

// ── Status vocabulary ──────────────────────────────────────────────

/** A note is never started from scratch — it always corrects an invoice. */
export function isNote(kind: DocKind): boolean {
  return kind === "credit_note" || kind === "debit_note";
}

/** The statuses a document of this kind can actually be in, in lifecycle order. */
export function statusesFor(kind: DocKind): DocStatus[] {
  if (kind === "quote") return ["draft", "sent", "accepted", "declined", "expired", "cancelled"];
  if (kind === "credit_note" || kind === "debit_note") return ["draft", "sent", "void"];
  return ["draft", "sent", "part_paid", "paid", "written_off", "void"];
}

/**
 * Is this document still awaiting the customer? Drives the "needs a decision" lists.
 *
 * A credit note awaits nobody — it is money going back, not a bill and not an offer.
 * Before this it fell through the `else` branch and sat in the partner's "waiting on a
 * yes" pile forever, which is the sort of thing that makes a dashboard stop being read.
 */
export function awaitsCustomer(doc: Pick<PartnerDocument, "kind" | "status">): boolean {
  // Neither note awaits anybody: a credit is money going back, and a debit is chased
  // through the invoice it belongs to. Before this a note fell through the invoice branch
  // and sat in the partner's "waiting on a yes" pile forever.
  if (isNote(doc.kind)) return false;
  if (doc.kind === "quote") return doc.status === "sent";
  return doc.status === "sent" || doc.status === "part_paid";
}

/** A document that is settled needs no further action from anyone. */
export function isSettled(doc: Pick<PartnerDocument, "status">): boolean {
  return ["paid", "declined", "cancelled", "expired", "written_off"].includes(doc.status);
}

/**
 * Is this document counted in the farm's cost ledger? Mirrors the 0412 trigger exactly:
 * an issued INVOICE adds, an issued CREDIT NOTE subtracts. A quote is never a cost — it
 * is not money owed — and a void document is not one either.
 */
export function isCosted(doc: Pick<PartnerDocument, "kind" | "status">): boolean {
  return (doc.kind === "invoice" || isNote(doc.kind))
    // `written_off` counts too: the customer never paid, but the work was done on that
    // machine and its cost of ownership should say so.
    && ["sent", "part_paid", "paid", "written_off"].includes(doc.status);
}

/**
 * Signed contribution to the customer's balance. An invoice and a DEBIT note both add to
 * what is owed; a CREDIT note takes it back off. Mirrors the 0418 ledger trigger.
 */
export function ledgerSign(kind: DocKind): 1 | -1 | 0 {
  if (kind === "invoice" || kind === "debit_note") return 1;
  if (kind === "credit_note") return -1;
  return 0;
}

/** Only a draft can still be edited by its issuer; anything sent is a record. */
export function isEditable(doc: Pick<PartnerDocument, "status" | "source">): boolean {
  return doc.status === "draft";
}

/**
 * How a mistake on this document gets fixed — the question AutoVault never answered, and
 * the reason its statements drift. Three ways to be wrong, three different answers:
 *
 *   delete   nothing left our hands, so there is no record to preserve
 *   void     it should not exist at all — wrong customer, duplicate. Keeps the number and
 *            the history, stands the money down, and records why
 *   credit   the amount was wrong. A credit note against it, then a fresh invoice. This
 *            is what VAT Act s21 requires once a tax invoice has been issued
 */
export type Correction = "delete" | "void" | "credit" | "write_off";

export function correctionsFor(doc: Pick<PartnerDocument, "kind" | "status">): Correction[] {
  if (doc.status === "draft") return ["delete"];
  if (doc.status === "void" || doc.status === "cancelled") return [];
  // Already written off: the decision is made and it is off the ageing. Voiding it now
  // would claim the bill should never have existed, which is a different (and untrue)
  // statement about the same job.
  if (doc.status === "written_off") return [];
  // Notes attach to an INVOICE. A note on a note would be unreadable on a statement, and
  // the thing being corrected is always the invoice underneath.
  if (doc.kind === "invoice") {
    // Writing off is only meaningful while something is still owed.
    return doc.status === "paid" ? ["credit", "void"] : ["credit", "void", "write_off"];
  }
  return ["void"];
}



/** What is still owed once payments AND credit notes are taken off. Never negative. */
export function outstandingCents(
  doc: Pick<PartnerDocument, "total_cents" | "amount_paid_cents" | "kind" | "status">,
  creditedCents = 0,
): number {
  if (!isCosted(doc) || doc.kind !== "invoice") return 0;
  // Written off is not outstanding — that is the whole point of writing it off.
  if (doc.status === "written_off") return 0;
  return Math.max(0, doc.total_cents - (doc.amount_paid_cents || 0) - creditedCents);
}

/** Days past due, negative when it is not yet due. Null when the document has no due date. */
export function daysOverdue(dueDate: string | null, today = new Date()): number | null {
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T00:00:00Z`);
  const now = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return Math.round((now.getTime() - due.getTime()) / 86_400_000);
}

/** i18n key for a document status label (`docStatus.*`). */
export function docStatusKey(status: DocStatus): string {
  return `docStatus.${status}`;
}

/** Default due date: today + the partner's terms (invoice) or validity (quote) window. */
export function defaultDueDate(kind: DocKind, from: Date, quoteValidityDays: number, invoiceTermsDays: number): string {
  const days = kind === "quote" ? quoteValidityDays : invoiceTermsDays;
  const d = new Date(from);
  d.setDate(d.getDate() + Math.max(0, days));
  return d.toISOString().slice(0, 10);
}
