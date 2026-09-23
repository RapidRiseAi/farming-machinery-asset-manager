/**
 * Which columns of a partner's profile belong to which group on `/contractor/settings`.
 *
 * == Why this is not five inline arrays on the page ===========================
 * Because a typo in one of them is silent and expensive. Each dialog posts the columns
 * it owns in `__fields`, and `updatePartnerProfile` writes only those; a misspelled
 * column therefore means that dialog owns nothing it thinks it owns, so pressing Save
 * writes nothing, reports "Saved." and leaves the value exactly as it was. Nothing in
 * `tsc`, `lint` or the build can see it, because they are strings.
 *
 * Holding the lists here lets `partner-profile.test.ts` assert the two properties that
 * matter: every column the action can write is reachable from exactly one group, and no
 * group names a column the action does not know.
 */

/**
 * Every column `updatePartnerProfile` is allowed to write, in the order the action
 * declares them. Keep this in step with that action's `ownedUpdate` spec; the test
 * fails if a group names something absent from here.
 */
export const PARTNER_PROFILE_COLUMNS = [
  "name",
  "trading_name",
  "reg_number",
  "vat_number",
  "address",
  "phone",
  "whatsapp",
  "email",
  "website",
  "area",
  "bank_name",
  "bank_account_name",
  "bank_account_number",
  "bank_branch_code",
  "bank_account_type",
  "brand_primary",
  "brand_secondary",
  "show_powered_by",
  "doc_prefix_quote",
  "doc_prefix_invoice",
  "doc_prefix_credit",
  "quote_validity_days",
  "invoice_terms_days",
  "vat_registered",
  "default_vat_rate_bps",
  "doc_terms",
  "doc_footer",
] as const;

export type PartnerProfileColumn = (typeof PARTNER_PROFILE_COLUMNS)[number];

/** The five groups the screen edits, one dialog each. */
export const PARTNER_PROFILE_GROUPS = {
  identity: ["name", "trading_name", "reg_number", "vat_number", "address"],
  contact: ["phone", "whatsapp", "email", "website", "area"],
  banking: [
    "bank_name",
    "bank_account_name",
    "bank_account_number",
    "bank_branch_code",
    "bank_account_type",
  ],
  letterhead: ["brand_primary", "brand_secondary", "show_powered_by", "doc_terms", "doc_footer"],
  documents: [
    "doc_prefix_quote",
    "doc_prefix_invoice",
    "doc_prefix_credit",
    "quote_validity_days",
    "invoice_terms_days",
    "vat_registered",
    "default_vat_rate_bps",
  ],
} as const satisfies Record<string, readonly PartnerProfileColumn[]>;
