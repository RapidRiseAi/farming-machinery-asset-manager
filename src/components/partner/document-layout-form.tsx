"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { resolveLayout, type ResolvedLayout, type Density, type AccentStyle } from "@/lib/doc-layout";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { TextField, SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { updateDocumentLayout } from "@/app/(app)/contractor/settings/actions";

/**
 * Choosing how your documents look.
 *
 * The preview is the point. Every setting here changes a document a customer will read,
 * and a partner cannot judge "tight spacing" or "no colour" from the words — they have to
 * see it. So the preview is a real, miniature document that re-renders as the switches
 * move, using the same resolver the actual page and the PDF use.
 *
 * It is not a designer. The choices are a closed set, because each one has to be honoured
 * identically by the screen AND the PDF; anything only one of them could render would be
 * a promise the other quietly breaks.
 */
export function DocumentLayoutForm({
  locale,
  current,
  brandPrimary,
  vatRegistered,
  businessName,
}: {
  locale: Lang;
  current: unknown;
  brandPrimary: string;
  vatRegistered: boolean;
  businessName: string;
}) {
  const [l, setL] = useState<ResolvedLayout>(() => resolveLayout(current));
  const set = <K extends keyof ResolvedLayout>(key: K, value: ResolvedLayout[K]) =>
    setL((prev) => ({ ...prev, [key]: value }));

  const title =
    l.invoice_title || (vatRegistered ? t("doc.kindTaxInvoice", locale) : t("doc.kindInvoice", locale));
  const pad = l.density === "compact" ? "px-2 py-0.5" : "px-2.5 py-1.5";

  const Switch = ({ name, label, hint }: { name: keyof ResolvedLayout; label: string; hint?: string }) => (
    <label className="flex items-start gap-3 text-sm text-sand-700">
      <input
        type="checkbox"
        name={name}
        checked={l[name] as boolean}
        onChange={(e) => set(name, e.target.checked as never)}
        className="mt-0.5 h-5 w-5 rounded border-sand-300 text-brand-600"
      />
      <span>
        {label}
        {hint ? <span className="block text-xs text-sand-500">{hint}</span> : null}
      </span>
    </label>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("layout.title", locale)}</CardTitle>
      </CardHeader>
      <p className="text-sm text-sand-600">{t("layout.lead", locale)}</p>

      {/* ── The preview ─────────────────────────────────────────── */}
      <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wide text-sand-500">
        {t("layout.previewTitle", locale)}
      </p>
      <div className="overflow-hidden rounded-lg border border-sand-200">
        <div
          className={
            l.accent_style === "band"
              ? "flex items-center gap-2 px-3 py-2.5 text-white"
              : l.accent_style === "line"
                ? "flex items-center gap-2 border-t-4 bg-white px-3 py-2.5"
                : "flex items-center gap-2 border-b border-sand-200 bg-white px-3 py-2.5"
          }
          style={
            l.accent_style === "band"
              ? { backgroundColor: brandPrimary }
              : l.accent_style === "line"
                ? { borderTopColor: brandPrimary }
                : undefined
          }
        >
          <span className={`text-sm font-bold ${l.accent_style === "band" ? "" : "text-sand-900"}`}>
            {businessName}
          </span>
          <span className={`ml-auto text-xs font-semibold uppercase ${l.accent_style === "band" ? "opacity-90" : "text-sand-500"}`}>
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
            {[
              { d: "Oil filter", q: 2, u: 24500 },
              { d: "Labour — 3 hours", q: 3, u: 45000 },
            ].map((row, i) => (
              <tr key={row.d} className="border-b border-sand-50">
                {l.show_line_numbers ? <td className={`${pad} text-sand-500`}>{i + 1}</td> : null}
                <td className={`${pad} text-sand-900`}>{row.d}</td>
                <td className={`${pad} text-right text-sand-700`}>{row.q}</td>
                {l.show_unit_price ? <td className={`${pad} text-right text-sand-700`}>{rands(row.u)}</td> : null}
                <td className={`${pad} text-right font-medium text-sand-900`}>{rands(row.q * row.u)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="px-3 py-2 text-right text-xs">
          <span className="text-sand-500">{l.total_label ?? t("doc.total", locale)} </span>
          <span className="font-bold text-sand-900">{rands(vatRegistered ? 224250 : 195000)}</span>
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

      {/* ── The choices ─────────────────────────────────────────── */}
      <form action={updateDocumentLayout} className="mt-4 flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold text-sand-900">{t("layout.namesTitle", locale)}</p>
          <p className="-mt-2 text-sm text-sand-600">{t("layout.namesBody", locale)}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              name="quote_title"
              label={t("layout.quoteTitle", locale)}
              value={l.quote_title ?? ""}
              onChange={(e) => set("quote_title", e.target.value || null)}
            />
            <TextField
              name="invoice_title"
              label={t("layout.invoiceTitle", locale)}
              hint={vatRegistered ? t("layout.invoiceTitleHint", locale) : undefined}
              value={l.invoice_title ?? ""}
              onChange={(e) => set("invoice_title", e.target.value || null)}
            />
            <TextField
              name="credit_title"
              label={t("layout.creditTitle", locale)}
              value={l.credit_title ?? ""}
              onChange={(e) => set("credit_title", e.target.value || null)}
            />
            <TextField
              name="debit_title"
              label={t("layout.debitTitle", locale)}
              value={l.debit_title ?? ""}
              onChange={(e) => set("debit_title", e.target.value || null)}
            />
            <TextField
              name="bill_to_label"
              label={t("layout.billToLabel", locale)}
              value={l.bill_to_label ?? ""}
              onChange={(e) => set("bill_to_label", e.target.value || null)}
            />
            <TextField
              name="items_label"
              label={t("layout.itemsLabel", locale)}
              value={l.items_label ?? ""}
              onChange={(e) => set("items_label", e.target.value || null)}
            />
            <TextField
              name="total_label"
              label={t("layout.totalLabel", locale)}
              value={l.total_label ?? ""}
              onChange={(e) => set("total_label", e.target.value || null)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-sand-100 pt-4">
          <p className="text-sm font-semibold text-sand-900">{t("layout.blocksTitle", locale)}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Switch name="show_vehicle" label={t("layout.showVehicle", locale)} />
            <Switch name="show_vat_number" label={t("layout.showVatNumber", locale)} />
            <Switch name="show_banking" label={t("layout.showBanking", locale)} />
            <Switch name="show_line_numbers" label={t("layout.showLineNumbers", locale)} />
            <Switch
              name="show_unit_price"
              label={t("layout.showUnitPrice", locale)}
              hint={t("layout.showUnitPriceHint", locale)}
            />
            <Switch name="show_signature" label={t("layout.showSignature", locale)} />
            <Switch name="show_thanks" label={t("layout.showThanks", locale)} />
          </div>
          {l.show_thanks ? (
            <TextField
              name="thanks_text"
              label={t("layout.thanksText", locale)}
              value={l.thanks_text ?? ""}
              onChange={(e) => set("thanks_text", e.target.value || null)}
            />
          ) : (
            <input type="hidden" name="thanks_text" value={l.thanks_text ?? ""} />
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-sand-100 pt-4">
          <p className="text-sm font-semibold text-sand-900">{t("layout.lookTitle", locale)}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              name="density"
              label={t("layout.density", locale)}
              value={l.density}
              onChange={(e) => set("density", e.target.value as Density)}
            >
              <option value="comfortable">{t("layout.densityComfortable", locale)}</option>
              <option value="compact">{t("layout.densityCompact", locale)}</option>
            </SelectField>
            <SelectField
              name="accent_style"
              label={t("layout.accentStyle", locale)}
              value={l.accent_style}
              onChange={(e) => set("accent_style", e.target.value as AccentStyle)}
            >
              <option value="band">{t("layout.accentBand", locale)}</option>
              <option value="line">{t("layout.accentLine", locale)}</option>
              <option value="plain">{t("layout.accentPlain", locale)}</option>
            </SelectField>
          </div>
        </div>

        <p className="text-sm text-sand-500">{t("layout.frozenNote", locale)}</p>
        <SubmitButton className="self-start">{t("layout.save", locale)}</SubmitButton>
      </form>
    </Card>
  );
}
