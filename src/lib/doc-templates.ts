import { resolveLayout, type ResolvedLayout } from "@/lib/doc-layout";

/**
 * The handful of document TEMPLATES a partner chooses between (migration 0505).
 *
 * ── What this is, and deliberately is not ────────────────────────────────────
 *
 * Not a builder. 0434 already settled that argument: a partner does not want to design a
 * document, they want theirs to look like the one they have been sending for fifteen
 * years, and the differences that actually matter are always the same few. What 0434 gave
 * them was sixteen individual switches — correct, but sixteen switches is still a design
 * job, and most partners will never open it. So this layer sits ON TOP: four named,
 * opinionated presets that set those switches en masse, each one a shape a real workshop
 * actually sends.
 *
 * There is no parallel layout system. A template IS a set of 0434 layout keys, applied
 * through 0434's own `update_document_layout` merge, honoured by 0434's own resolver and
 * therefore by both renderers. Choose "Plain paper" and every switch below it moves; open
 * the switches afterwards and you can still change one. Nothing here can express a layout
 * the screen and the PDF cannot both render, because nothing here is new.
 *
 * ── What a template governs, and what it must never touch ────────────────────
 *
 * SHAPE only: spacing, how the partner's colour appears, and which blocks are on the
 * page. It does NOT touch the seven wording keys (`quote_title`, `invoice_title`,
 * `bill_to_label`, …) or the thank-you, for two reasons:
 *
 *   * those are the partner's own words, typed once and expected to stay typed — a
 *     template switch that silently renamed their documents would be the worst kind of
 *     surprise;
 *   * `invoice_title` is load-bearing in law. A VAT-registered vendor's invoice must be
 *     headed as a tax invoice (VAT Act s20(4)), and `documentTitle()` supplies exactly
 *     that when the key is empty. A template setting a friendlier heading would quietly
 *     invalidate the document. Leaving the key alone means the rule keeps winning.
 *
 * Customisation likewise survives untouched: the logo, both brand colours, standing
 * terms, footer and numbering all live in their own `workshops` columns (0380) and are
 * read by every template. `brand_primary` is what an accent band or hairline is PAINTED
 * WITH, so choosing a template and choosing a colour are not competing settings.
 *
 * ── Why the map lives here and not in SQL ────────────────────────────────────
 *
 * Both renderers are TypeScript, so this is the only place that could be the source of
 * truth without a mirror to drift. 0505 validates the template NAME (a closed set, so a
 * typo fails where it is made — the same discipline 0434 applies to layout keys) and does
 * not attempt to know what each name means. `workshops.doc_template` is therefore a
 * RECORD OF THE CHOICE, not an authority: what renders is always `doc_layout`.
 */

/** Every template id, in the order the picker shows them. */
export const DOC_TEMPLATES = ["classic", "compact", "plain", "totals_only"] as const;
export type DocTemplateId = (typeof DOC_TEMPLATES)[number];

/**
 * The default, and the one existing partners are on.
 *
 * `classic` is not "our favourite" — it is defined as the layout every partner already
 * had before templates existed, key for key (see `DOC_TEMPLATE_LAYOUTS.classic` against
 * `resolveLayout({})`). That is what makes 0505 safe to apply: the column default names a
 * template that changes nothing.
 */
export const DEFAULT_DOC_TEMPLATE: DocTemplateId = "classic";

/**
 * The layout keys a template sets. Everything else in `DocLayout` — the wording keys and
 * the thank-you — is deliberately outside a template's reach (see the header).
 */
export const TEMPLATE_LAYOUT_KEYS = [
  "density",
  "accent_style",
  "show_vehicle",
  "show_vat_number",
  "show_banking",
  "show_signature",
  "show_line_numbers",
  "show_unit_price",
] as const;
export type TemplateLayoutKey = (typeof TEMPLATE_LAYOUT_KEYS)[number];

/** A template's contribution to `doc_layout`: every governed key, explicitly. */
export type TemplateLayout = Pick<ResolvedLayout, TemplateLayoutKey>;

/**
 * Every key is spelled out on every template — never inherited, never omitted.
 *
 * `update_document_layout` MERGES, which is what stops a screen offering three settings
 * from wiping the other twelve. The flip side is that an omitted key would keep whatever
 * the previous template left behind, so switching from "Fits more on a page" to "Standard
 * letterhead" would leave the numbered lines on. Writing all eight every time makes a
 * template a complete statement about shape rather than a patch.
 */
export const DOC_TEMPLATE_LAYOUTS: Record<DocTemplateId, TemplateLayout> = {
  /**
   * What everybody already has. Colour across the top, roomy rows, a price against every
   * line. Must stay byte-identical to `resolveLayout({})` on all eight keys.
   */
  classic: {
    density: "comfortable",
    accent_style: "band",
    show_vehicle: true,
    show_vat_number: true,
    show_banking: true,
    show_signature: false,
    show_line_numbers: false,
    show_unit_price: true,
  },
  /**
   * For a long job. Tight rows and numbered lines, and a hairline instead of a filled
   * band — which also gives back the top of the page. A twenty-line strip-and-rebuild
   * lands on one sheet instead of two, which matters to whoever is holding the printer.
   */
  compact: {
    density: "compact",
    accent_style: "line",
    show_vehicle: true,
    show_vat_number: true,
    show_banking: true,
    show_signature: false,
    show_line_numbers: true,
    show_unit_price: true,
  },
  /**
   * No colour anywhere, and a line to sign. For the partner who prints on paper, hands it
   * over at the vehicle and wants a signature, or whose customer photocopies and files
   * everything — a solid colour band comes out of a mono copier as a grey smear that eats
   * the business name with it.
   */
  plain: {
    density: "comfortable",
    accent_style: "plain",
    show_vehicle: true,
    show_vat_number: true,
    show_banking: true,
    show_signature: true,
    show_line_numbers: false,
    show_unit_price: true,
  },
  /**
   * Says what was done and what each item came to, without printing a rate per hour or
   * per part. A real and common trade preference rather than a style: a workshop that
   * quotes a job, not a rate card, does not want its labour rate on a page that gets
   * shown to the next supplier.
   */
  totals_only: {
    density: "comfortable",
    accent_style: "band",
    show_vehicle: true,
    show_vat_number: true,
    show_banking: true,
    show_signature: false,
    show_line_numbers: false,
    show_unit_price: false,
  },
};

export function isDocTemplate(value: unknown): value is DocTemplateId {
  return typeof value === "string" && (DOC_TEMPLATES as readonly string[]).includes(value);
}

/** The stored value as a template id, falling back to the one that changes nothing. */
export function docTemplateOf(value: unknown): DocTemplateId {
  return isDocTemplate(value) ? value : DEFAULT_DOC_TEMPLATE;
}

/** The layout keys this template applies. */
export function templateLayout(id: DocTemplateId): TemplateLayout {
  return DOC_TEMPLATE_LAYOUTS[id];
}

/** i18n keys — plain words a mechanic would use, not design vocabulary. */
export function docTemplateNameKey(id: DocTemplateId): string {
  return `docTemplate.name.${id}`;
}
export function docTemplateDescKey(id: DocTemplateId): string {
  return `docTemplate.desc.${id}`;
}

/**
 * A preview of what this template's documents look like, resolved through 0434's own
 * resolver so the miniature in the picker cannot drift from the real page or the PDF.
 *
 * `current` is the partner's live layout: their wording, their thank-you and anything
 * they hand-tuned outside the eight keys carries into the preview, which is the point —
 * a partner judging "Plain paper" should see their own document in it, not a specimen.
 */
export function layoutForTemplate(id: DocTemplateId, current: unknown): ResolvedLayout {
  return { ...resolveLayout(current), ...DOC_TEMPLATE_LAYOUTS[id] };
}

/**
 * Does the live layout still match the template the partner chose?
 *
 * The stored name records a choice; the switches below the picker can move afterwards.
 * When they have, the picker says so rather than showing a tick that is no longer true —
 * a settings screen that claims a state it is not in is worse than one that says nothing.
 */
export function layoutMatchesTemplate(layout: ResolvedLayout, id: DocTemplateId): boolean {
  const wanted = DOC_TEMPLATE_LAYOUTS[id];
  return TEMPLATE_LAYOUT_KEYS.every((key) => layout[key] === wanted[key]);
}

/** The template this layout IS, or null when it is the partner's own mix of switches. */
export function matchTemplate(layout: ResolvedLayout): DocTemplateId | null {
  return DOC_TEMPLATES.find((id) => layoutMatchesTemplate(layout, id)) ?? null;
}
