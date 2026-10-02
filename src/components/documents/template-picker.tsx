import { t, type Lang } from "@/lib/i18n";
import { resolveLayout } from "@/lib/doc-layout";
import {
  DOC_TEMPLATES,
  docTemplateDescKey,
  docTemplateNameKey,
  docTemplateOf,
  layoutForTemplate,
  layoutMatchesTemplate,
  type DocTemplateId,
} from "@/lib/doc-templates";
import { Badge } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { DialogActions } from "@/components/ui/dialog-form";
import { DocumentPreview } from "@/components/documents/document-preview";
import { applyDocumentTemplate } from "@/app/(app)/contractor/settings/actions";

/**
 * Pick one of four documents (0505). Rendered INSIDE a `DialogForm` on
 * /contractor/settings, which shows the one document going out today on the page and
 * keeps these four behind "Change template".
 *
 * The preview is the whole point, and it is the SAME preview the layout dialog renders:
 * four of them, each showing this partner's own name, colour, logo, VAT number, bank and
 * wording in that template's shape. A partner should not have to read "no accent, roomy
 * rows, signature line" and imagine the result; they should look at four documents and
 * point at one.
 *
 * Radio cards with ONE apply button. It used to be four forms with a filled "Use this
 * one" each, which put four brand buttons on one screen competing for the same decision.
 * The card is a `<label>` around a real radio, so the whole miniature is the tap target,
 * and the ring follows `:checked` through CSS (`has-[:checked]`), so the picker is still
 * server-rendered with no state of its own. It posts the same `template` field as before.
 *
 * The tick is derived, not asserted. `doc_template` records what the partner chose, but
 * the layout switches can move afterwards; when they have, the card says so instead of
 * an "In use" badge that is no longer true, and choosing it again puts it back.
 */
export function DocumentTemplatePicker({
  locale,
  chosen,
  currentLayout,
  brandPrimary,
  businessName,
  vatRegistered,
  logoUrl,
  vatNumber,
  invoicePrefix,
  bankName,
  bankAccountNumber,
}: {
  locale: Lang;
  /** `workshops.doc_template` as stored. */
  chosen: unknown;
  /** `workshops.doc_layout` as stored, the partner's live wording rides into each preview. */
  currentLayout: unknown;
  brandPrimary: string;
  businessName: string;
  vatRegistered: boolean;
  logoUrl?: string | null;
  vatNumber?: string | null;
  invoicePrefix?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
}) {
  const chosenId: DocTemplateId = docTemplateOf(chosen);
  const live = resolveLayout(currentLayout);
  const chosenStillMatches = layoutMatchesTemplate(live, chosenId);

  return (
    <form action={applyDocumentTemplate} className="flex flex-col gap-4">
      <p className="text-sm text-sand-600">{t("docTemplate.keepsNote", locale)}</p>

      <fieldset className="min-w-0">
        <legend className="sr-only">{t("docTemplate.title", locale)}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {DOC_TEMPLATES.map((id) => {
            const isChosen = id === chosenId;
            return (
              <label
                key={id}
                className="flex min-w-0 cursor-pointer flex-col gap-3 rounded-xl border border-sand-200 bg-sand-50/40 p-3 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-tint/40 has-[:checked]:ring-1 has-[:checked]:ring-brand-500 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500"
              >
                <DocumentPreview
                  locale={locale}
                  layout={layoutForTemplate(id, currentLayout)}
                  brandPrimary={brandPrimary}
                  businessName={businessName}
                  vatRegistered={vatRegistered}
                  logoUrl={logoUrl}
                  vatNumber={vatNumber}
                  invoicePrefix={invoicePrefix}
                  bankName={bankName}
                  bankAccountNumber={bankAccountNumber}
                />

                <span className="flex min-h-[48px] flex-wrap items-center gap-x-3 gap-y-1 sm:min-h-[40px]">
                  <input
                    type="radio"
                    name="template"
                    value={id}
                    defaultChecked={isChosen}
                    className="h-5 w-5 shrink-0 accent-brand-600"
                  />
                  <span className="text-sm font-semibold text-sand-900">{t(docTemplateNameKey(id), locale)}</span>
                  {isChosen && chosenStillMatches ? <Badge tone="brand">{t("docTemplate.current", locale)}</Badge> : null}
                </span>
                <span className="-mt-2 text-sm text-sand-600">{t(docTemplateDescKey(id), locale)}</span>

                {/* A chosen template whose switches have since been hand-tuned: say so, and
                    let choosing it again be the way back. */}
                {isChosen && !chosenStillMatches ? (
                  <span className="text-xs text-sand-500">{t("partnerSettings.templateAdjusted", locale)}</span>
                ) : null}
              </label>
            );
          })}
        </div>
      </fieldset>

      <p className="text-sm text-sand-500">{t("docTemplate.frozenNote", locale)}</p>

      <DialogActions cancelLabel={t("common.cancel", locale)}>
        <SubmitButton variant="primary">{t("docTemplate.use", locale)}</SubmitButton>
      </DialogActions>
    </form>
  );
}
