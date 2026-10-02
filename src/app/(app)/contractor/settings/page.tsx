import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { errorMessage } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { requireProfile, currentWorkshop, homePathFor } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { num, vatPercent } from "@/lib/format";
import { brandingFrom } from "@/lib/branding";
import { workshopPlanNameKey } from "@/lib/contractor-plan";
import { signedBrandingUrl } from "@/lib/partner-media";
import { LAYOUT_SWITCHES, resolveLayout } from "@/lib/doc-layout";
import { docTemplateNameKey, docTemplateOf, layoutMatchesTemplate } from "@/lib/doc-templates";
import { formatPhone } from "@/lib/phone-display";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, SelectField, TextField, TextareaField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { DocumentPreview } from "@/components/documents/document-preview";
import { DocumentLayoutForm } from "@/components/partner/document-layout-form";
import { DocumentTemplatePicker } from "@/components/documents/template-picker";
import { VatRateField } from "@/components/vat-rate-field";
import { LogoUpload } from "@/components/partner/logo-upload";
import { updatePartnerProfile, removePartnerLogo } from "./actions";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Fact, FactList } from "@/components/ui/facts";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { OWNED_FIELD } from "@/lib/partial-form";
import { PARTNER_PROFILE_GROUPS } from "@/lib/partner-profile";

/** The names a partner may give their own wording; any one set counts as "custom". */
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
 * The three account types South African banks issue. The VALUE is what is stored and
 * printed on the PDF (`pdf/partner-document.ts` prints it as typed), so it stays the
 * plain English word; the label is translated. A value saved before this was a select
 * is kept as an extra option, never silently dropped.
 */
const ACCOUNT_TYPES = [
  { value: "Cheque", key: "partnerSettings.accountTypeCheque" },
  { value: "Savings", key: "partnerSettings.accountTypeSavings" },
  { value: "Transmission", key: "partnerSettings.accountTypeTransmission" },
] as const;

/**
 * The partner's own business profile (F14a).
 *
 * Everything a document needs to look like it came from THEM: the trading name, the
 * registration and VAT numbers a South African invoice is legally poorer without, the
 * banking details a farmer pays into, the colours, and the logo. Plus the document
 * defaults, numbering prefix, how long a quote stands, how long they give on an
 * invoice, so the builder starts from their house rules rather than ours.
 *
 * == Order ====================================================================
 * The business first (who you are, how to reach you, where to pay you), then how the
 * documents look, then the numbering and VAT rules. It used to open on six document
 * miniatures and a sixteen-control layout form, and "Who you are" started some 5000px
 * down a phone. The design now states itself in ONE preview with two buttons, and the
 * template picker and the layout switches open in dialogs, so nothing on this page is a
 * field to fill in at rest.
 */
export default async function PartnerSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; layout?: string; template?: string }>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect(`${homePathFor(profile.role)}?denied=1`);
  const locale = profile.lang;
  const sp = await searchParams;

  const { workshop, plan } = await currentWorkshop(profile);
  const b = brandingFrom(workshop);
  const logoUrl = await signedBrandingUrl(workshop?.logo_path ?? null);

  // `doc_template` is not part of `BRANDING_COLUMNS`, that list is the LETTERHEAD, and the
  // template is a record of which preset produced it, read only by this screen. One narrow
  // read rather than widening a shape four other surfaces depend on. RLS scopes it: a
  // partner reads its own workshop row and no other.
  let chosenTemplate: string | null = null;
  if (workshop) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("workshops")
      .select("doc_template")
      .eq("id", workshop.id)
      .maybeSingle();
    chosenTemplate = (data as { doc_template?: string } | null)?.doc_template ?? null;
  }

  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const notSet = t("settings.notSet", locale);
  const yesNo = (on: boolean) => t(on ? "common.yes" : "common.no", locale);
  // The unit lives in the value ("14 days"), not in brackets on the label.
  const days = (n: number) =>
    n === 1 ? t("partnerSettings.oneDay", locale) : t("partnerSettings.nDays", locale).replace("{n}", num(n, 0));
  // An example of the shape, not a claim about the next number: the counter is not read
  // here, so "Next: TJI-0001" would be false for anyone who has sent an invoice.
  const prefixExample = (prefix: string) =>
    t("partnerSettings.prefixExample", locale).replace("{example}", `${prefix}-0001`);

  // A VAT-registered partner's invoice is titled "Tax invoice" (doc-layout `documentTitle`),
  // and a tax invoice without the supplier's VAT number is not one (VAT Act s20(4)).
  const vatNumber = (workshop?.vat_number ?? "").trim();
  const vatNumberMissing = b.vatRegistered && !vatNumber;

  const primary = b.brand_primary ?? "#00572c";
  const currentLayout = (workshop as { doc_layout?: unknown } | null)?.doc_layout;
  const live = resolveLayout(currentLayout);
  const templateId = docTemplateOf(chosenTemplate);
  const templateMatches = layoutMatchesTemplate(live, templateId);
  const customNames = NAME_KEYS.filter((key) => Boolean(live[key])).length;
  const onPageList = LAYOUT_SWITCHES.filter((key) => live[key])
    .map((key) => t(`partnerSettings.onPage.${key}`, locale))
    .join(", ");
  const onPage = onPageList ? onPageList.charAt(0).toUpperCase() + onPageList.slice(1) : t("partnerSettings.onPageNone", locale);

  // One set of props for every miniature on and behind this page, so the page preview,
  // the four templates and the layout dialog all show the same partner.
  const preview = {
    locale,
    brandPrimary: primary,
    businessName: b.name,
    vatRegistered: b.vatRegistered,
    logoUrl,
    vatNumber: b.vat_number,
    invoicePrefix: workshop?.doc_prefix_invoice ?? null,
    bankName: workshop?.bank_name ?? null,
    bankAccountNumber: workshop?.bank_account_number ?? null,
  };

  const storedAccountType = (workshop?.bank_account_type ?? "").trim();
  const knownAccountType = ACCOUNT_TYPES.find(
    (a) => a.value.toLowerCase() === storedAccountType.toLowerCase(),
  );
  const legacyAccountType = storedAccountType && !knownAccountType ? storedAccountType : null;

  const quotePrefix = workshop?.doc_prefix_quote ?? "QTE";
  const invoicePrefix = workshop?.doc_prefix_invoice ?? "INV";
  const creditPrefix = workshop?.doc_prefix_credit ?? "CN";

  /**
   * One group of the profile: what it is set to, and an Edit button that opens only its
   * fields. `owns` becomes the `__fields` marker that keeps this dialog from resetting
   * the other four groups when it saves.
   */
  const group = ({
    title,
    owns,
    facts,
    fields,
    hint,
    before,
  }: {
    title: string;
    owns: readonly string[];
    facts: ReactNode;
    fields: ReactNode;
    hint?: string;
    /** A row above the facts that is not a fact, e.g. the logo. */
    before?: ReactNode;
  }) => (
    <Card>
      <CardHeader
        action={
          <DialogForm
            trigger={t("common.edit", locale)}
            triggerVariant="secondary"
            triggerSize="sm"
            title={title}
            description={hint}
            closeLabel={closeLabel}
            size="md"
          >
            <form action={updatePartnerProfile}>
              <input type="hidden" name={OWNED_FIELD} value={owns.join(" ")} />
              <DialogFields columns={1}>{fields}</DialogFields>
              <DialogActions cancelLabel={cancelLabel}>
                <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
        }
      >
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      {hint ? <p className="mb-2 text-sm text-sand-500">{hint}</p> : null}
      {before}
      <FactList>{facts}</FactList>
    </Card>
  );

  const swatch = (hex: string) => (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="h-4 w-4 shrink-0 rounded border border-sand-300" style={{ backgroundColor: hex }} />
      <span className="font-mono text-xs">{hex}</span>
    </span>
  );

  return (
    <PageContainer size="narrow">
      <PageHeader
        title={t("partnerSettings.title", locale)}
        lead={t("partnerSettings.lead", locale)}
        infoKey="partnerSettings"
        locale={locale}
        badge={plan ? <Badge tone="brand">{t(workshopPlanNameKey(plan), locale)}</Badge> : undefined}
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />
      <Flash tone="success" message={sp.layout ? t("layout.savedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.template ? t("docTemplate.savedFlash", locale) : undefined} />
      {/* A standing condition, not the result of a save, so it leaves the URL alone. */}
      <Flash
        tone="warning"
        clearParams={false}
        message={
          vatNumberMissing
            ? t("partnerSettings.vatNumberMissing", locale).replace("{card}", t("partnerSettings.identity", locale))
            : undefined
        }
      />

      {/*
        Each group states what it is set to and carries one Edit button.

        It was one `<form>` of about twenty-five controls across five cards, with a
        jump-to nav across the top and a sticky Save that followed you down, all three of
        which were treatments for the same problem: the page was too big to take in, and
        a contractor could not answer "what number does my next invoice get?" without
        reading the contents of a text box.

        Each dialog declares the COLUMNS it owns in `__fields`, because
        `updatePartnerProfile` writes one `.update()` over every column and would
        otherwise reset the ones it did not carry. See `src/lib/partial-form.ts`.
      */}
      {group({
        title: t("partnerSettings.identity", locale),
        owns: PARTNER_PROFILE_GROUPS.identity,
        facts: (
          <>
            <Fact label={t("partnerSettings.name", locale)} value={workshop?.name || notSet} muted={!workshop?.name} />
            <Fact label={t("partnerSettings.tradingName", locale)} value={workshop?.trading_name || notSet} muted={!workshop?.trading_name} />
            <Fact label={t("partnerSettings.regNo", locale)} value={workshop?.reg_number || notSet} muted={!workshop?.reg_number} />
            <Fact
              label={t("partnerSettings.vatNo", locale)}
              value={
                vatNumberMissing ? (
                  <StatusBadge label={t("partnerSettings.vatNoNeeded", locale)} tone="warning" shape="triangle" />
                ) : (
                  vatNumber || notSet
                )
              }
              muted={!vatNumber && !vatNumberMissing}
            />
            <Fact label={t("partnerSettings.address", locale)} value={workshop?.address || notSet} muted={!workshop?.address} />
          </>
        ),
        fields: (
          <>
            <TextField name="name" label={t("partnerSettings.name", locale)} defaultValue={workshop?.name ?? ""} required />
            <TextField
              name="trading_name"
              label={t("partnerSettings.tradingName", locale)}
              hint={t("partnerSettings.tradingNameHint", locale)}
              defaultValue={workshop?.trading_name ?? ""}
            />
            <TextField name="reg_number" label={t("partnerSettings.regNo", locale)} defaultValue={workshop?.reg_number ?? ""} />
            <TextField
              name="vat_number"
              label={t("partnerSettings.vatNo", locale)}
              hint={t("partnerSettings.vatNoHint", locale)}
              defaultValue={workshop?.vat_number ?? ""}
            />
            <TextareaField name="address" label={t("partnerSettings.address", locale)} rows={3} defaultValue={workshop?.address ?? ""} />
          </>
        ),
      })}

      {group({
        title: t("partnerSettings.contact", locale),
        owns: PARTNER_PROFILE_GROUPS.contact,
        facts: (
          <>
            {/* Grouped for reading only; the stored value, and the input, stay as typed. */}
            <Fact label={t("partnerSettings.phone", locale)} value={formatPhone(workshop?.phone) || notSet} muted={!workshop?.phone} />
            <Fact label={t("partnerSettings.whatsapp", locale)} value={formatPhone(workshop?.whatsapp) || notSet} muted={!workshop?.whatsapp} />
            <Fact
              label={t("partnerSettings.email", locale)}
              value={workshop?.email ? <span className="break-all">{workshop.email}</span> : notSet}
              muted={!workshop?.email}
            />
            <Fact
              label={t("partnerSettings.website", locale)}
              value={workshop?.website ? <span className="break-all">{workshop.website}</span> : notSet}
              muted={!workshop?.website}
            />
            <Fact label={t("partnerSettings.area", locale)} value={workshop?.area || notSet} muted={!workshop?.area} />
          </>
        ),
        fields: (
          <>
            <TextField name="phone" type="tel" label={t("partnerSettings.phone", locale)} defaultValue={workshop?.phone ?? ""} />
            <TextField
              name="whatsapp"
              type="tel"
              label={t("partnerSettings.whatsapp", locale)}
              hint={t("partnerSettings.whatsappHint", locale)}
              defaultValue={workshop?.whatsapp ?? ""}
            />
            <TextField name="email" type="email" label={t("partnerSettings.email", locale)} defaultValue={workshop?.email ?? ""} />
            <TextField name="website" label={t("partnerSettings.website", locale)} defaultValue={workshop?.website ?? ""} />
            <TextField
              name="area"
              label={t("partnerSettings.area", locale)}
              hint={t("partnerSettings.areaHint", locale)}
              defaultValue={workshop?.area ?? ""}
            />
          </>
        ),
      })}

      {group({
        title: t("partnerSettings.banking", locale),
        hint: t("partnerSettings.bankingHint", locale),
        owns: PARTNER_PROFILE_GROUPS.banking,
        facts: (
          <>
            <Fact label={t("partnerSettings.bankName", locale)} value={workshop?.bank_name || notSet} muted={!workshop?.bank_name} />
            <Fact label={t("partnerSettings.bankAccountName", locale)} value={workshop?.bank_account_name || notSet} muted={!workshop?.bank_account_name} />
            <Fact label={t("partnerSettings.bankAccountNumber", locale)} value={workshop?.bank_account_number || notSet} muted={!workshop?.bank_account_number} />
            <Fact label={t("partnerSettings.bankBranchCode", locale)} value={workshop?.bank_branch_code || notSet} muted={!workshop?.bank_branch_code} />
            <Fact
              label={t("partnerSettings.bankAccountType", locale)}
              value={knownAccountType ? t(knownAccountType.key, locale) : storedAccountType || notSet}
              muted={!storedAccountType}
            />
          </>
        ),
        fields: (
          <>
            <TextField name="bank_name" label={t("partnerSettings.bankName", locale)} defaultValue={workshop?.bank_name ?? ""} />
            <TextField name="bank_account_name" label={t("partnerSettings.bankAccountName", locale)} defaultValue={workshop?.bank_account_name ?? ""} />
            <TextField
              name="bank_account_number"
              inputMode="numeric"
              label={t("partnerSettings.bankAccountNumber", locale)}
              defaultValue={workshop?.bank_account_number ?? ""}
            />
            <TextField
              name="bank_branch_code"
              inputMode="numeric"
              label={t("partnerSettings.bankBranchCode", locale)}
              hint={t("partnerSettings.branchCodeHint", locale)}
              defaultValue={workshop?.bank_branch_code ?? ""}
            />
            <SelectField
              name="bank_account_type"
              label={t("partnerSettings.bankAccountType", locale)}
              defaultValue={knownAccountType?.value ?? storedAccountType}
            >
              <option value="">{notSet}</option>
              {ACCOUNT_TYPES.map((a) => (
                <option key={a.value} value={a.value}>
                  {t(a.key, locale)}
                </option>
              ))}
              {legacyAccountType ? <option value={legacyAccountType}>{legacyAccountType}</option> : null}
            </SelectField>
          </>
        ),
      })}

      {/* The document going out today, drawn once. The four templates and the sixteen
          layout controls each open in a dialog with their own live previews, so the page
          states the choice and the dialogs change it. Both triggers are secondary: this
          screen has no filled button at rest. */}
      <Card>
        <CardHeader>
          <CardTitle>{t("partnerSettings.preview", locale)}</CardTitle>
        </CardHeader>
        <DocumentPreview {...preview} layout={live} />
        <FactList className="mt-2">
          <Fact
            label={t("partnerSettings.template", locale)}
            value={t(docTemplateNameKey(templateId), locale)}
            hint={templateMatches ? undefined : t("partnerSettings.templateAdjusted", locale)}
          />
          <Fact
            label={t("partnerSettings.wording", locale)}
            value={
              customNames === 0
                ? t("partnerSettings.wordingStandard", locale)
                : customNames === 1
                  ? t("partnerSettings.wordingCustomOne", locale)
                  : t("partnerSettings.wordingCustom", locale).replace("{n}", num(customNames, 0))
            }
          />
          <Fact label={t("partnerSettings.onPageLabel", locale)} value={onPage} />
          <Fact
            label={t("layout.density", locale)}
            value={t(live.density === "compact" ? "layout.densityCompact" : "layout.densityComfortable", locale)}
          />
          <Fact
            label={t("layout.accentStyle", locale)}
            value={t(
              live.accent_style === "line" ? "layout.accentLine" : live.accent_style === "plain" ? "layout.accentPlain" : "layout.accentBand",
              locale,
            )}
          />
        </FactList>
        <div className="mt-3 flex flex-wrap gap-2">
          <DialogForm
            trigger={t("partnerSettings.changeTemplate", locale)}
            triggerVariant="secondary"
            triggerSize="sm"
            title={t("docTemplate.title", locale)}
            description={t("docTemplate.lead", locale)}
            closeLabel={closeLabel}
            size="lg"
          >
            <DocumentTemplatePicker {...preview} chosen={chosenTemplate} currentLayout={currentLayout} />
          </DialogForm>
          <DialogForm
            trigger={t("partnerSettings.adjustLayout", locale)}
            triggerVariant="secondary"
            triggerSize="sm"
            title={t("layout.title", locale)}
            description={t("layout.lead", locale)}
            closeLabel={closeLabel}
            size="lg"
          >
            <DocumentLayoutForm {...preview} current={currentLayout} />
          </DialogForm>
        </div>
      </Card>

      {group({
        title: t("partnerSettings.letterhead", locale),
        owns: PARTNER_PROFILE_GROUPS.letterhead,
        // The logo sits with the colours it is judged against. It uploads through its
        // own action (not a profile column), so it is a row here, not a field in Edit.
        before: (
          <LogoUpload
            bare
            locale={locale}
            currentUrl={logoUrl}
            removeAction={
              logoUrl ? (
                <ConfirmDialog
                  action={removePartnerLogo}
                  triggerLabel={t("partnerSettings.removeLogo", locale)}
                  triggerVariant="secondary"
                  triggerSize="sm"
                  title={t("partnerSettings.removeLogo", locale)}
                  intro={t("partnerSettings.removeLogoBody", locale)}
                  confirmLabel={t("partnerSettings.removeLogo", locale)}
                  cancelLabel={cancelLabel}
                  closeLabel={closeLabel}
                />
              ) : null
            }
          />
        ),
        facts: (
          <>
            {/* The swatch as well as the hex: a hex code is not a colour anybody can read. */}
            <Fact label={t("partnerSettings.brandPrimary", locale)} value={swatch(primary)} />
            <Fact label={t("partnerSettings.brandSecondary", locale)} value={swatch(b.brand_secondary ?? "#1f2937")} />
            <Fact label={t("partnerSettings.poweredBy", locale)} value={yesNo(b.show_powered_by !== false)} />
            <Fact label={t("partnerSettings.terms", locale)} value={workshop?.doc_terms || notSet} muted={!workshop?.doc_terms} />
            <Fact label={t("partnerSettings.footer", locale)} value={workshop?.doc_footer || notSet} muted={!workshop?.doc_footer} />
          </>
        ),
        fields: (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("partnerSettings.brandPrimary", locale)} htmlFor="f-brand_primary" hint={t("partnerSettings.brandPrimaryHint", locale)}>
                <Input id="f-brand_primary" name="brand_primary" type="color" defaultValue={primary} className="p-1" />
              </Field>
              <Field label={t("partnerSettings.brandSecondary", locale)} htmlFor="f-brand_secondary">
                <Input id="f-brand_secondary" name="brand_secondary" type="color" defaultValue={b.brand_secondary ?? "#1f2937"} className="p-1" />
              </Field>
            </div>
            <Checkbox
              name="show_powered_by"
              defaultChecked={b.show_powered_by !== false}
              label={t("partnerSettings.poweredBy", locale)}
              hint={t("partnerSettings.poweredByHint", locale)}
            />
            <TextareaField
              name="doc_terms"
              label={t("partnerSettings.terms", locale)}
              hint={t("partnerSettings.termsHint", locale)}
              rows={4}
              defaultValue={workshop?.doc_terms ?? ""}
            />
            <TextField name="doc_footer" label={t("partnerSettings.footer", locale)} defaultValue={workshop?.doc_footer ?? ""} />
          </>
        ),
      })}

      {group({
        title: t("partnerSettings.documentDefaults", locale),
        owns: PARTNER_PROFILE_GROUPS.documents,
        facts: (
          <>
            <Fact label={t("partnerSettings.quotePrefix", locale)} value={quotePrefix} hint={prefixExample(quotePrefix)} />
            <Fact label={t("partnerSettings.invoicePrefix", locale)} value={invoicePrefix} hint={prefixExample(invoicePrefix)} />
            <Fact label={t("partnerSettings.prefixCredit", locale)} value={creditPrefix} hint={prefixExample(creditPrefix)} />
            <Fact label={t("partnerSettings.quoteValidity", locale)} value={days(b.quoteValidityDays)} />
            <Fact label={t("partnerSettings.invoiceTerms", locale)} value={days(b.invoiceTermsDays)} />
            <Fact
              label={t("partnerSettings.vatRegistered", locale)}
              value={yesNo(b.vatRegistered)}
              hint={
                b.vatRegistered
                  ? vatPercent(b.defaultVatRateBps)
                  : t("partnerSettings.vatNotRegisteredNote", locale)
              }
            />
          </>
        ),
        fields: (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                name="doc_prefix_quote"
                label={t("partnerSettings.quotePrefix", locale)}
                hint={t("partnerSettings.prefixHint", locale)}
                defaultValue={quotePrefix}
                maxLength={8}
              />
              <TextField
                name="doc_prefix_invoice"
                label={t("partnerSettings.invoicePrefix", locale)}
                defaultValue={invoicePrefix}
                maxLength={8}
              />
              {/* Its own series: a credit note is a different kind of document under
                  s21, and sharing the invoice counter makes both unreadable. */}
              <TextField
                name="doc_prefix_credit"
                label={t("partnerSettings.prefixCredit", locale)}
                defaultValue={creditPrefix}
                maxLength={8}
              />
              <TextField
                name="quote_validity_days"
                type="number"
                inputMode="numeric"
                min={0}
                max={365}
                label={t("partnerSettings.quoteValidity", locale)}
                hint={t("partnerSettings.quoteValidityHint", locale)}
                defaultValue={String(b.quoteValidityDays)}
              />
              <TextField
                name="invoice_terms_days"
                type="number"
                inputMode="numeric"
                min={0}
                max={365}
                label={t("partnerSettings.invoiceTerms", locale)}
                hint={t("partnerSettings.invoiceTermsHint", locale)}
                defaultValue={String(b.invoiceTermsDays)}
              />
            </div>
            {/* Registration first, then the rate, because "do you charge VAT at all"
                decides whether the rate matters, and most one-van operations do not. */}
            <Checkbox
              name="vat_registered"
              defaultChecked={b.vatRegistered}
              label={t("partnerSettings.vatRegistered", locale)}
              hint={t("partnerSettings.vatRegisteredHint", locale)}
            />
            <VatRateField defaultBps={workshop?.default_vat_rate_bps ?? 1500} locale={locale} />
          </>
        ),
      })}
    </PageContainer>
  );
}
