import { t, type Lang } from "@/lib/i18n";
import type { DocKind } from "@/lib/partner-docs";

/**
 * How a partner's documents are laid out (G9, migration 0434).
 *
 * A closed set of choices rather than a designer, because the differences that actually
 * matter between one workshop's invoice and another's are always the same few: what the
 * document is CALLED, which blocks appear, and how dense it is. Every value here has to
 * be honoured identically by the screen and the PDF — anything only one of them could
 * render would be a promise the other quietly breaks.
 *
 * `resolveLayout` is the only place defaults live, so a partner who has never opened the
 * settings screen and one who has cleared every box get the same document.
 */

export type Density = "comfortable" | "compact";
export type AccentStyle = "band" | "line" | "plain";

export type DocLayout = {
  quote_title?: string;
  invoice_title?: string;
  credit_title?: string;
  debit_title?: string;
  bill_to_label?: string;
  items_label?: string;
  total_label?: string;

  show_vehicle?: boolean;
  show_vat_number?: boolean;
  show_banking?: boolean;
  show_signature?: boolean;
  show_line_numbers?: boolean;
  show_unit_price?: boolean;
  show_thanks?: boolean;
  thanks_text?: string;

  density?: Density;
  accent_style?: AccentStyle;
};

export type ResolvedLayout = Required<Omit<DocLayout,
  "quote_title" | "invoice_title" | "credit_title" | "debit_title" |
  "bill_to_label" | "items_label" | "total_label" | "thanks_text">> & {
  quote_title: string | null;
  invoice_title: string | null;
  credit_title: string | null;
  debit_title: string | null;
  bill_to_label: string | null;
  items_label: string | null;
  total_label: string | null;
  thanks_text: string | null;
};

/** Every switch, with the default a partner gets before touching anything. */
export const LAYOUT_SWITCHES = [
  "show_vehicle", "show_vat_number", "show_banking", "show_line_numbers",
  "show_unit_price", "show_signature", "show_thanks",
] as const;

const DEFAULTS: ResolvedLayout = {
  quote_title: null,
  invoice_title: null,
  credit_title: null,
  debit_title: null,
  bill_to_label: null,
  items_label: null,
  total_label: null,
  show_vehicle: true,
  show_vat_number: true,
  show_banking: true,
  // Off by default: a signature line on a document that is emailed as a PDF is decoration
  // for most trades, and a workshop that wants one knows it does.
  show_signature: false,
  show_line_numbers: false,
  show_unit_price: true,
  show_thanks: false,
  thanks_text: null,
  density: "comfortable",
  accent_style: "band",
};

export function resolveLayout(raw: unknown): ResolvedLayout {
  const l = (raw && typeof raw === "object" ? raw : {}) as DocLayout;
  const bool = (v: boolean | undefined, d: boolean) => (typeof v === "boolean" ? v : d);
  const str = (v: string | undefined) => {
    const s = (v ?? "").trim();
    return s === "" ? null : s;
  };
  return {
    quote_title: str(l.quote_title),
    invoice_title: str(l.invoice_title),
    credit_title: str(l.credit_title),
    debit_title: str(l.debit_title),
    bill_to_label: str(l.bill_to_label),
    items_label: str(l.items_label),
    total_label: str(l.total_label),
    show_vehicle: bool(l.show_vehicle, DEFAULTS.show_vehicle),
    show_vat_number: bool(l.show_vat_number, DEFAULTS.show_vat_number),
    show_banking: bool(l.show_banking, DEFAULTS.show_banking),
    show_signature: bool(l.show_signature, DEFAULTS.show_signature),
    show_line_numbers: bool(l.show_line_numbers, DEFAULTS.show_line_numbers),
    show_unit_price: bool(l.show_unit_price, DEFAULTS.show_unit_price),
    show_thanks: bool(l.show_thanks, DEFAULTS.show_thanks),
    thanks_text: str(l.thanks_text),
    density: l.density === "compact" ? "compact" : DEFAULTS.density,
    accent_style:
      l.accent_style === "line" || l.accent_style === "plain" ? l.accent_style : DEFAULTS.accent_style,
  };
}

/**
 * What this document is called on its own face.
 *
 * The default for an invoice from a VAT-REGISTERED partner is "Tax invoice", and that is
 * not decoration: under VAT Act s20(4) a document has to be headed as one to be a valid
 * tax invoice, and a customer's own accountant will query it if it is not. A partner who
 * is not registered gets plain "Invoice", because heading it "tax invoice" would claim
 * something untrue.
 */
export function documentTitle(
  kind: DocKind,
  layout: ResolvedLayout,
  locale: Lang,
  vatRegistered: boolean,
): string {
  switch (kind) {
    case "quote":
      return layout.quote_title ?? t("doc.kindQuote", locale);
    case "credit_note":
      return layout.credit_title ?? t("doc.kindCreditNote", locale);
    case "debit_note":
      return layout.debit_title ?? t("doc.kindDebitNote", locale);
    default:
      return layout.invoice_title
        ?? (vatRegistered ? t("doc.kindTaxInvoice", locale) : t("doc.kindInvoice", locale));
  }
}

/** Tailwind padding for a table cell at this density — one place, both tables. */
export function cellPadding(density: Density): string {
  return density === "compact" ? "px-3 py-1" : "px-4 py-2";
}

/** Points of vertical padding in a PDF table row. Mirrors `cellPadding`. */
export function pdfRowGap(density: Density): number {
  return density === "compact" ? 4 : 8;
}
