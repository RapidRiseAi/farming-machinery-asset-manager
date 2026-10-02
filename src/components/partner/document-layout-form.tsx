"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import {
  LAYOUT_SWITCHES,
  resolveLayout,
  type ResolvedLayout,
  type Density,
  type AccentStyle,
} from "@/lib/doc-layout";
import { TextField, SelectField } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { DialogActions, DialogSection } from "@/components/ui/dialog-form";
import { DocumentPreview } from "@/components/documents/document-preview";
import { updateDocumentLayout } from "@/app/(app)/contractor/settings/actions";

/** The seven names a partner may override; empty means the normal wording. */
const NAME_KEYS = [
  "quote_title",
  "invoice_title",
  "credit_title",
  "debit_title",
  "bill_to_label",
  "items_label",
  "total_label",
] as const;

/**
 * Choosing how your documents look. Rendered INSIDE a `DialogForm` on
 * /contractor/settings: the page states the current choices, and this is what opens when
 * the partner asks to change them.
 *
 * The preview is the point. Every setting here changes a document a customer will read,
 * and a partner cannot judge "tight spacing" or "no colour" from the words, they have to
 * see it. So the preview is a real, miniature document at the top of the dialog that
 * re-renders as the switches move, using the same resolver the actual page and the PDF use.
 *
 * The choices sit in three collapsed sections under it, because sixteen controls opened at
 * once was the clutter this dialog exists to remove. They are native `<details>`, so a
 * closed section's fields are still in the form and still post: closing "What appears on
 * the page" does not switch every block off on save.
 *
 * State resets on every open: the dialog unmounts its body on close, so a Cancel throws
 * the unsaved changes away and the next open starts from what is saved.
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
  invoicePrefix,
  bankName,
  bankAccountNumber,
}: {
  locale: Lang;
  current: unknown;
  brandPrimary: string;
  vatRegistered: boolean;
  businessName: string;
  /** Signed logo URL, passed through so this preview and the template picker's agree. */
  logoUrl?: string | null;
  vatNumber?: string | null;
  invoicePrefix?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
}) {
  const [l, setL] = useState<ResolvedLayout>(() => resolveLayout(current));
  const set = <K extends keyof ResolvedLayout>(key: K, value: ResolvedLayout[K]) =>
    setL((prev) => ({ ...prev, [key]: value }));
  // Open the names section when the partner already has names of their own, so an edit
  // never hides the values they came to change. Read once, from what is saved.
  const [hasCustomNames] = useState(() => {
    const saved = resolveLayout(current);
    return NAME_KEYS.some((key) => Boolean(saved[key]));
  });

  // Plain render helpers, not components: a component declared inside this one would be
  // a new type on every keystroke, remount its input and drop focus mid-word.
  const switchRow = (name: (typeof LAYOUT_SWITCHES)[number], label: string, hint?: string) => (
    <Checkbox
      key={name}
      name={name}
      checked={l[name]}
      onChange={(e) => set(name, e.target.checked)}
      label={label}
      hint={hint}
    />
  );

  const nameField = (name: (typeof NAME_KEYS)[number], label: string, hint?: string) => (
    <TextField
      key={name}
      name={name}
      label={label}
      hint={hint}
      value={l[name] ?? ""}
      onChange={(e) => set(name, e.target.value || null)}
    />
  );

  return (
    <form action={updateDocumentLayout} className="flex flex-col gap-4">
      {/* == The preview =========================================== */}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-sand-500">
          {t("layout.previewTitle", locale)}
        </p>
        {/* The same miniature the page and the template picker draw, one preview in the
            codebase, so the templates and these switches can never show a different
            document. */}
        <DocumentPreview
          locale={locale}
          layout={l}
          brandPrimary={brandPrimary}
          businessName={businessName}
          vatRegistered={vatRegistered}
          logoUrl={logoUrl}
          vatNumber={vatNumber}
          invoicePrefix={invoicePrefix}
          bankName={bankName}
          bankAccountNumber={bankAccountNumber}
        />
      </div>

      {/* == The choices =========================================== */}
      <div className="grid gap-1">
        <DialogSection title={t("layout.namesTitle", locale)} defaultOpen={hasCustomNames}>
          <p className="text-sm text-sand-600 sm:col-span-2">{t("layout.namesBody", locale)}</p>
          {nameField("quote_title", t("layout.quoteTitle", locale))}
          {nameField(
            "invoice_title",
            t("layout.invoiceTitle", locale),
            vatRegistered ? t("layout.invoiceTitleHint", locale) : undefined,
          )}
          {nameField("credit_title", t("layout.creditTitle", locale))}
          {nameField("debit_title", t("layout.debitTitle", locale))}
          {nameField("bill_to_label", t("layout.billToLabel", locale))}
          {nameField("items_label", t("layout.itemsLabel", locale))}
          {nameField("total_label", t("layout.totalLabel", locale))}
        </DialogSection>

        <DialogSection title={t("layout.blocksTitle", locale)}>
          {switchRow("show_vehicle", t("layout.showVehicle", locale))}
          {switchRow("show_vat_number", t("layout.showVatNumber", locale))}
          {switchRow("show_banking", t("layout.showBanking", locale))}
          {switchRow("show_line_numbers", t("layout.showLineNumbers", locale))}
          {switchRow("show_unit_price", t("layout.showUnitPrice", locale), t("layout.showUnitPriceHint", locale))}
          {switchRow("show_signature", t("layout.showSignature", locale))}
          {switchRow("show_thanks", t("layout.showThanks", locale))}
          {l.show_thanks ? (
            <div className="sm:col-span-2">
              <TextField
                name="thanks_text"
                label={t("layout.thanksText", locale)}
                value={l.thanks_text ?? ""}
                onChange={(e) => set("thanks_text", e.target.value || null)}
              />
            </div>
          ) : (
            <input type="hidden" name="thanks_text" value={l.thanks_text ?? ""} />
          )}
        </DialogSection>

        <DialogSection title={t("layout.lookTitle", locale)}>
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
        </DialogSection>
      </div>

      <p className="text-sm text-sand-500">{t("layout.frozenNote", locale)}</p>
      <DialogActions cancelLabel={t("common.cancel", locale)}>
        <SubmitButton variant="primary">{t("layout.save", locale)}</SubmitButton>
      </DialogActions>
    </form>
  );
}
