"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { resolveLayout, type ResolvedLayout, type Density, type AccentStyle } from "@/lib/doc-layout";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { TextField, SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { DocumentPreview } from "@/components/documents/document-preview";
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
  logoUrl,
  vatNumber,
}: {
  locale: Lang;
  current: unknown;
  brandPrimary: string;
  vatRegistered: boolean;
  businessName: string;
  /** Signed logo URL — passed through so this preview and the template picker's agree. */
  logoUrl?: string | null;
  vatNumber?: string | null;
}) {
  const [l, setL] = useState<ResolvedLayout>(() => resolveLayout(current));
  const set = <K extends keyof ResolvedLayout>(key: K, value: ResolvedLayout[K]) =>
    setL((prev) => ({ ...prev, [key]: value }));

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
      {/* The same miniature the template picker draws (0505) — one preview in the codebase,
          so the four templates and these switches can never show a different document. */}
      <DocumentPreview
        locale={locale}
        layout={l}
        brandPrimary={brandPrimary}
        businessName={businessName}
        vatRegistered={vatRegistered}
        logoUrl={logoUrl}
        vatNumber={vatNumber}
      />

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
