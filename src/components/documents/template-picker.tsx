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
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { DocumentPreview } from "@/components/documents/document-preview";
import { applyDocumentTemplate } from "@/app/(app)/contractor/settings/actions";

/**
 * Pick one of four documents (0505).
 *
 * The preview is the whole point, and it is the SAME preview the 0434 switches render
 * below — four of them, each showing this partner's own name, colour, logo, VAT number and
 * wording in that template's shape. A partner should not have to read "no accent, roomy
 * rows, signature line" and imagine the result; they should look at four documents and
 * point at one.
 *
 * No client JavaScript. Each card is its own `<form>` posting one hidden field, so the
 * whole picker is server-rendered and works before hydration — which also keeps this
 * screen's bundle where it was. `SubmitButton` is the one client piece, and this route
 * already loads it for the rest of the settings page.
 *
 * The tick is derived, not asserted. `doc_template` records what the partner chose, but
 * the switches underneath can move afterwards; when they have, the card says so instead of
 * showing a tick that is no longer true.
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
}: {
  locale: Lang;
  /** `workshops.doc_template` as stored. */
  chosen: unknown;
  /** `workshops.doc_layout` as stored — the partner's live wording rides into each preview. */
  currentLayout: unknown;
  brandPrimary: string;
  businessName: string;
  vatRegistered: boolean;
  logoUrl?: string | null;
  vatNumber?: string | null;
}) {
  const chosenId: DocTemplateId = docTemplateOf(chosen);
  const live = resolveLayout(currentLayout);
  const chosenStillMatches = layoutMatchesTemplate(live, chosenId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("docTemplate.title", locale)}</CardTitle>
      </CardHeader>
      <p className="text-sm text-sand-600">{t("docTemplate.lead", locale)}</p>
      <p className="mt-1 text-sm text-sand-500">{t("docTemplate.keepsNote", locale)}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {DOC_TEMPLATES.map((id) => {
          const isChosen = id === chosenId;
          return (
            <form
              key={id}
              action={applyDocumentTemplate}
              className={`flex flex-col gap-3 rounded-xl border p-3 ${
                isChosen ? "border-brand-500 bg-brand-50/40 ring-1 ring-brand-500" : "border-sand-200 bg-sand-50/40"
              }`}
            >
              <input type="hidden" name="template" value={id} />

              <DocumentPreview
                locale={locale}
                layout={layoutForTemplate(id, currentLayout)}
                brandPrimary={brandPrimary}
                businessName={businessName}
                vatRegistered={vatRegistered}
                logoUrl={logoUrl}
                vatNumber={vatNumber}
              />

              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-sand-900">{t(docTemplateNameKey(id), locale)}</h3>
                {isChosen ? <Badge tone="brand">{t("docTemplate.current", locale)}</Badge> : null}
              </div>
              <p className="-mt-1 text-sm text-sand-600">{t(docTemplateDescKey(id), locale)}</p>

              {/* A chosen template whose switches have since been hand-tuned: say so, and
                  offer the way back rather than a tick that is not true any more. */}
              {isChosen && !chosenStillMatches ? (
                <p className="text-xs text-sand-500">{t("docTemplate.changedByHand", locale)}</p>
              ) : null}

              <div className="mt-auto">
                {isChosen && chosenStillMatches ? (
                  // Nothing to press: this IS the document going out. A button here would
                  // be an action with no effect, which teaches people to distrust buttons.
                  <p className="text-sm font-medium text-brand-700">{t("docTemplate.inUse", locale)}</p>
                ) : (
                  <SubmitButton
                    variant={isChosen ? "secondary" : "primary"}
                    size="sm"
                    className="w-full"
                  >
                    {isChosen ? t("docTemplate.reapply", locale) : t("docTemplate.use", locale)}
                  </SubmitButton>
                )}
              </div>
            </form>
          );
        })}
      </div>

      <p className="mt-4 text-sm text-sand-500">{t("docTemplate.frozenNote", locale)}</p>
    </Card>
  );
}
