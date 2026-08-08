/**
 * Partner branding (F14a, migration 0380).
 *
 * A partner's letterhead in one shape, resolved once and used by three renderers that
 * must not disagree: the on-screen document, the print stylesheet, and the PDF. Anything
 * the partner has not filled in falls back to something presentable rather than a blank —
 * a partner who signs up and immediately sends a quote should get a document that looks
 * deliberate, not half-configured.
 */

import type { IssuerSnapshot } from "@/lib/partner-docs";

/** FleetWise's own green — the fallback letterhead colour, and the PDF wordmark colour. */
export const DEFAULT_BRAND_PRIMARY = "#166534";
export const DEFAULT_BRAND_SECONDARY = "#1f2937";

/** The `workshops` columns branding needs. Select these when you need a letterhead. */
export const BRANDING_COLUMNS =
  "id, name, trading_name, reg_number, vat_number, address, phone, whatsapp, email, website, " +
  "bank_name, bank_account_name, bank_account_number, bank_branch_code, bank_account_type, " +
  "logo_path, brand_primary, brand_secondary, show_powered_by, doc_prefix_quote, doc_prefix_invoice, " +
  "quote_validity_days, invoice_terms_days, default_vat_rate_bps, vat_registered, doc_terms, doc_footer, doc_prefix_credit";

export type WorkshopBrandingRow = {
  id: string;
  name: string;
  trading_name?: string | null;
  reg_number?: string | null;
  vat_number?: string | null;
  address?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  website?: string | null;
  /** Service area — not part of the letterhead, but read alongside it. */
  area?: string | null;
  bank_name?: string | null;
  bank_account_name?: string | null;
  bank_account_number?: string | null;
  bank_branch_code?: string | null;
  bank_account_type?: string | null;
  logo_path?: string | null;
  brand_primary?: string | null;
  brand_secondary?: string | null;
  show_powered_by?: boolean | null;
  doc_prefix_quote?: string | null;
  doc_prefix_invoice?: string | null;
  doc_prefix_credit?: string | null;
  quote_validity_days?: number | null;
  invoice_terms_days?: number | null;
  default_vat_rate_bps?: number | null;
  vat_registered?: boolean | null;
  doc_terms?: string | null;
  doc_footer?: string | null;
};

export type Branding = Required<Pick<IssuerSnapshot, "name">> & IssuerSnapshot & {
  quoteValidityDays: number;
  invoiceTermsDays: number;
  defaultVatRateBps: number;
  /** Does this partner charge VAT at all? False → documents carry no VAT line. */
  vatRegistered: boolean;
};

/** Resolve a workshop row into the letterhead, filling every gap with a sane default. */
export function brandingFrom(w: WorkshopBrandingRow | null | undefined): Branding {
  return {
    name: (w?.trading_name || w?.name || "").trim() || "Partner",
    reg_number: w?.reg_number ?? null,
    vat_number: w?.vat_number ?? null,
    address: w?.address ?? null,
    phone: w?.phone ?? w?.whatsapp ?? null,
    email: w?.email ?? null,
    website: w?.website ?? null,
    bank_name: w?.bank_name ?? null,
    bank_account_name: w?.bank_account_name ?? null,
    bank_account_number: w?.bank_account_number ?? null,
    bank_branch_code: w?.bank_branch_code ?? null,
    bank_account_type: w?.bank_account_type ?? null,
    brand_primary: normaliseHex(w?.brand_primary) ?? DEFAULT_BRAND_PRIMARY,
    brand_secondary: normaliseHex(w?.brand_secondary) ?? DEFAULT_BRAND_SECONDARY,
    logo_path: w?.logo_path ?? null,
    terms: w?.doc_terms ?? null,
    footer: w?.doc_footer ?? null,
    show_powered_by: w?.show_powered_by ?? true,
    quoteValidityDays: w?.quote_validity_days ?? 14,
    invoiceTermsDays: w?.invoice_terms_days ?? 30,
    // A partner below the registration threshold issues at zero, whatever the
    // stored rate says — the rate is kept so turning registration on restores it.
    defaultVatRateBps: w?.vat_registered === false ? 0 : (w?.default_vat_rate_bps ?? 1500),
    vatRegistered: w?.vat_registered !== false,
  };
}

/** The letterhead as stored on a document, so a rebrand never restates an old invoice. */
export function snapshotOf(b: Branding): IssuerSnapshot {
  const { quoteValidityDays: _q, invoiceTermsDays: _i, defaultVatRateBps: _v, vatRegistered: _r, ...snapshot } = b;
  return snapshot;
}

/**
 * Read a document's frozen letterhead, falling back to the partner's current one for
 * documents issued before snapshots existed (or still in draft, which have none yet).
 */
export function brandingOf(snapshot: IssuerSnapshot | null | undefined, current: Branding): Branding {
  if (!snapshot) return current;
  return { ...current, ...snapshot, name: snapshot.name || current.name };
}

/** `#RRGGBB`, lowercased — or null if it isn't one. Mirrors the 0380 check constraint. */
export function normaliseHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}

/** `#166534` → `{ r: 0.086, g: 0.396, b: 0.204 }` for pdf-lib's `rgb()`. */
export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const h = normaliseHex(hex) ?? DEFAULT_BRAND_PRIMARY;
  return {
    r: parseInt(h.slice(1, 3), 16) / 255,
    g: parseInt(h.slice(3, 5), 16) / 255,
    b: parseInt(h.slice(5, 7), 16) / 255,
  };
}

/**
 * Is this colour dark enough to carry white text? Relative luminance per WCAG — the
 * partner picks their brand colour, and their header must stay readable whether they
 * chose navy or a pale yellow.
 */
export function isDark(hex: string): boolean {
  const { r, g, b } = hexToRgb01(hex);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) < 0.45;
}

/** Text colour that stays legible on `hex`. */
export function onBrand(hex: string): string {
  return isDark(hex) ? "#ffffff" : "#111827";
}
