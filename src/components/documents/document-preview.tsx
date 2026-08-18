import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import type { ResolvedLayout } from "@/lib/doc-layout";

/**
 * A miniature of the document a customer will actually receive.
 *
 * Extracted from the 0434 layout form so there is ONE preview in the codebase rather than
 * one per screen. It is now rendered in two places — under each of the four templates in
 * the picker, and live above the individual switches — and those two must never disagree,
 * because a partner comparing them is comparing the same document.
 *
 * It takes a `ResolvedLayout`, so it goes through the same resolver as the real page
 * (`documents/[id]`) and the PDF (`lib/pdf/partner-document`). A shape only this component
 * could draw would be a promise the other two quietly break.
 *
 * Deliberately NOT a client component: it has no state of its own. The picker renders four
 * of these on the server for nothing, and the layout form — which is a client component —
 * imports it and re-renders it as its switches move. Same markup either way.
 */

/** Two lines of a plausible workshop invoice, ex-VAT cents. */
const SAMPLE_LINES = [
  { description: "Oil filter", qty: 2, unitCents: 24_500 },
  { description: "Labour — 3 hours", qty: 3, unitCents: 45_000 },
] as const;

const SAMPLE_NET_CENTS = SAMPLE_LINES.reduce((sum, l) => sum + l.qty * l.unitCents, 0);

export type DocumentPreviewProps = {
  locale: Lang;
  layout: ResolvedLayout;
  /** The partner's own colour — what an accent band or hairline is painted with. */
  brandPrimary: string;
  businessName: string;
  /** Drives the heading, exactly as `documentTitle` does on the real document. */
  vatRegistered: boolean;
  /** Signed Storage URL for the partner's logo, when they have one. */
  logoUrl?: string | null;
  /** Their SARS VAT number, so the `show_vat_number` switch is visible here too. */
  vatNumber?: string | null;
};

export function DocumentPreview({
  locale,
  layout: l,
  brandPrimary,
  businessName,
  vatRegistered,
  logoUrl,
  vatNumber,
}: DocumentPreviewProps) {
  // The heading a VAT-registered partner's invoice must carry (VAT Act s20(4)) unless they
  // have typed their own. Mirrors `documentTitle(kind='invoice', …)`.
  const title =
    l.invoice_title || (vatRegistered ? t("doc.kindTaxInvoice", locale) : t("doc.kindInvoice", locale));
  const pad = l.density === "compact" ? "px-2 py-0.5" : "px-2.5 py-1.5";
  const band = l.accent_style === "band";

  return (
    <div className="overflow-hidden rounded-lg border border-sand-200 bg-white">
      <div
        className={
          band
            ? "flex items-center gap-2 px-3 py-2.5 text-white"
            : l.accent_style === "line"
              ? "flex items-center gap-2 border-t-4 bg-white px-3 py-2.5"
              : "flex items-center gap-2 border-b border-sand-200 bg-white px-3 py-2.5"
        }
        style={
          band
            ? { backgroundColor: brandPrimary }
            : l.accent_style === "line"
              ? { borderTopColor: brandPrimary }
              : undefined
        }
      >
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a signed Storage URL, not a static asset
          <img src={logoUrl} alt="" className="h-6 w-6 shrink-0 rounded bg-white/90 object-contain p-0.5" />
        ) : null}
        <span className="min-w-0">
          <span className={`block truncate text-sm font-bold ${band ? "" : "text-sand-900"}`}>
            {businessName}
          </span>
          {l.show_vat_number && vatNumber ? (
            <span className={`block truncate text-[0.65rem] ${band ? "opacity-90" : "text-sand-500"}`}>
              {t("partnerSettings.vatNo", locale)} {vatNumber}
            </span>
          ) : null}
        </span>
        <span className={`ml-auto shrink-0 text-xs font-semibold uppercase ${band ? "opacity-90" : "text-sand-500"}`}>
          {title}
        </span>
      </div>

      <div className="px-3 py-2 text-xs">
        <p className="font-semibold uppercase tracking-wide text-sand-500">
          {l.bill_to_label ?? t("doc.billTo", locale)}
        </p>
        <p className="text-sand-900">Weltevrede Boerdery</p>
        {l.show_vehicle ? <p className="text-sand-600">John Deere 6120M · CA 123-456</p> : null}
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="border-y border-sand-100 text-left text-sand-500">
            {l.show_line_numbers ? <th className={pad}>#</th> : null}
            <th className={pad}>{l.items_label ?? t("doc.lineDescription", locale)}</th>
            <th className={`${pad} text-right`}>{t("doc.lineQty", locale)}</th>
            {l.show_unit_price ? <th className={`${pad} text-right`}>{t("doc.lineUnit", locale)}</th> : null}
            <th className={`${pad} text-right`}>{t("doc.lineTotal", locale)}</th>
          </tr>
        </thead>
        <tbody>
          {SAMPLE_LINES.map((row, i) => (
            <tr key={row.description} className="border-b border-sand-50">
              {l.show_line_numbers ? <td className={`${pad} text-sand-500`}>{i + 1}</td> : null}
              <td className={`${pad} text-sand-900`}>{row.description}</td>
              <td className={`${pad} text-right text-sand-700`}>{row.qty}</td>
              {l.show_unit_price ? (
                <td className={`${pad} text-right text-sand-700`}>{rands(row.unitCents)}</td>
              ) : null}
              <td className={`${pad} text-right font-medium text-sand-900`}>{rands(row.qty * row.unitCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="px-3 py-2 text-right text-xs">
        <span className="text-sand-500">{l.total_label ?? t("doc.total", locale)} </span>
        <span className="font-bold text-sand-900">
          {rands(vatRegistered ? Math.round(SAMPLE_NET_CENTS * 1.15) : SAMPLE_NET_CENTS)}
        </span>
      </div>

      {l.show_banking ? (
        <p className="border-t border-sand-100 px-3 py-2 text-xs text-sand-600">
          {t("doc.howToPay", locale)}: FNB · 62… · {t("doc.useReference", locale)} INV-0042
        </p>
      ) : null}
      {l.show_thanks && l.thanks_text ? (
        <p className="px-3 pb-2 text-xs font-medium text-sand-700">{l.thanks_text}</p>
      ) : null}
      {l.show_signature ? (
        <div className="flex gap-6 px-3 pb-3 text-[0.65rem] text-sand-500">
          <span className="min-w-[8rem] border-t border-sand-300 pt-1">{t("doc.signedBy", locale)}</span>
          <span className="min-w-[5rem] border-t border-sand-300 pt-1">{t("doc.signedDate", locale)}</span>
        </div>
      ) : null}
    </div>
  );
}
