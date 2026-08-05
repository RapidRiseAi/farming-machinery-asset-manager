import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop, homePathFor } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { vatPercent } from "@/lib/format";
import { brandingFrom, onBrand } from "@/lib/branding";
import { workshopPlanNameKey } from "@/lib/contractor-plan";
import { signedBrandingUrl } from "@/lib/partner-media";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, TextField, TextareaField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { Badge } from "@/components/ui/badge";
import { VatRateField } from "@/components/vat-rate-field";
import { LogoUpload } from "@/components/partner/logo-upload";
import { updatePartnerProfile, removePartnerLogo } from "./actions";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * The partner's own business profile (F14a).
 *
 * Everything a document needs to look like it came from THEM: the trading name, the
 * registration and VAT numbers a South African invoice is legally poorer without, the
 * banking details a farmer pays into, the colours, and the logo. Plus the document
 * defaults — numbering prefix, how long a quote stands, how long they give on an
 * invoice — so the builder starts from their house rules rather than ours.
 */
export default async function PartnerSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect(`${homePathFor(profile.role)}?denied=1`);
  const locale = profile.lang;
  const sp = await searchParams;

  const { workshop, plan } = await currentWorkshop(profile);
  const b = brandingFrom(workshop);
  const logoUrl = await signedBrandingUrl(workshop?.logo_path ?? null);

  const groups = [
    ["ps-identity", "partnerSettings.identity"],
    ["ps-contact", "partnerSettings.contact"],
    ["ps-bank", "partnerSettings.banking"],
    ["ps-brand", "partnerSettings.letterhead"],
    ["ps-docs", "partnerSettings.documentDefaults"],
  ] as const;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("partnerSettings.title", locale)}</h1>
        <PageInfoButton infoKey="partnerSettings" locale={locale} />
        {plan ? <Badge tone="brand">{t(workshopPlanNameKey(plan), locale)}</Badge> : null}
      </div>
      <p className="text-sand-600">{t("partnerSettings.lead", locale)}</p>

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      <nav
        aria-label={t("settings.jumpTo", locale)}
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {groups.map(([anchor, key]) => (
          <a
            key={anchor}
            href={`#${anchor}`}
            className="focus-ring shrink-0 rounded-full border border-sand-200 bg-white px-3 py-2 text-sm font-medium text-sand-700 hover:border-brand-300 hover:text-brand-700"
          >
            {t(key, locale)}
          </a>
        ))}
      </nav>

      {/* The letterhead as the farmer will see it, above the fields that change it —
          so a colour choice is judged against a document, not a swatch. */}
      <Card>
        <CardHeader><CardTitle>{t("partnerSettings.preview", locale)}</CardTitle></CardHeader>
        <div className="overflow-hidden rounded-xl border border-sand-200">
          <div
            className="flex items-center gap-3 px-4 py-3"
            style={{ backgroundColor: b.brand_primary ?? "#166534", color: onBrand(b.brand_primary ?? "#166534") }}
          >
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- a signed Storage URL, not a static asset
              <img src={logoUrl} alt="" className="h-9 w-9 rounded bg-white/90 object-contain p-0.5" />
            ) : null}
            <div className="min-w-0">
              <p className="truncate text-base font-semibold">{b.name}</p>
              {b.vat_number ? <p className="truncate text-xs opacity-90">{t("partnerSettings.vatNo", locale)} {b.vat_number}</p> : null}
            </div>
            <span className="ml-auto text-xs font-semibold uppercase tracking-wide opacity-90">
              {t("doc.kindInvoice", locale)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="text-sand-500">{`${workshop?.doc_prefix_invoice ?? "INV"}-0001`}</span>
            <span
              className="rounded-full px-2.5 py-1 text-xs font-semibold"
              style={{ backgroundColor: `${b.brand_secondary}1a`, color: b.brand_secondary ?? "#1f2937" }}
            >
              {t("partnerSettings.previewTotal", locale)}
            </span>
          </div>
        </div>
      </Card>

      <LogoUpload
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
              cancelLabel={t("common.cancel", locale)}
              closeLabel={t("ui.close", locale)}
            />
          ) : null
        }
      />

      <form action={updatePartnerProfile} className="flex flex-col gap-4">
        <Card id="ps-identity">
          <CardHeader><CardTitle>{t("partnerSettings.identity", locale)}</CardTitle></CardHeader>
          <div className="flex flex-col gap-3">
            <TextField name="name" label={t("partnerSettings.name", locale)} defaultValue={workshop?.name ?? ""} required />
            <TextField
              name="trading_name"
              label={t("partnerSettings.tradingName", locale)}
              hint={t("partnerSettings.tradingNameHint", locale)}
              defaultValue={workshop?.trading_name ?? ""}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField name="reg_number" label={t("partnerSettings.regNo", locale)} defaultValue={workshop?.reg_number ?? ""} />
              <TextField
                name="vat_number"
                label={t("partnerSettings.vatNo", locale)}
                hint={t("partnerSettings.vatNoHint", locale)}
                defaultValue={workshop?.vat_number ?? ""}
              />
            </div>
            <TextareaField name="address" label={t("partnerSettings.address", locale)} rows={3} defaultValue={workshop?.address ?? ""} />
          </div>
        </Card>

        <Card id="ps-contact">
          <CardHeader><CardTitle>{t("partnerSettings.contact", locale)}</CardTitle></CardHeader>
          <div className="grid gap-3 sm:grid-cols-2">
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
              fieldClassName="sm:col-span-2"
            />
          </div>
        </Card>

        <Card id="ps-bank">
          <CardHeader><CardTitle>{t("partnerSettings.banking", locale)}</CardTitle></CardHeader>
          <p className="mb-3 text-sm text-sand-500">{t("partnerSettings.bankingHint", locale)}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="bank_name" label={t("partnerSettings.bankName", locale)} defaultValue={workshop?.bank_name ?? ""} />
            <TextField name="bank_account_name" label={t("partnerSettings.bankAccountName", locale)} defaultValue={workshop?.bank_account_name ?? ""} />
            <TextField name="bank_account_number" label={t("partnerSettings.bankAccountNumber", locale)} defaultValue={workshop?.bank_account_number ?? ""} />
            <TextField name="bank_branch_code" label={t("partnerSettings.bankBranchCode", locale)} defaultValue={workshop?.bank_branch_code ?? ""} />
            <TextField name="bank_account_type" label={t("partnerSettings.bankAccountType", locale)} defaultValue={workshop?.bank_account_type ?? ""} />
          </div>
        </Card>

        <Card id="ps-brand">
          <CardHeader><CardTitle>{t("partnerSettings.letterhead", locale)}</CardTitle></CardHeader>
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("partnerSettings.brandPrimary", locale)} htmlFor="f-brand_primary" hint={t("partnerSettings.brandPrimaryHint", locale)}>
                <Input id="f-brand_primary" name="brand_primary" type="color" defaultValue={b.brand_primary ?? "#166534"} className="p-1" />
              </Field>
              <Field label={t("partnerSettings.brandSecondary", locale)} htmlFor="f-brand_secondary">
                <Input id="f-brand_secondary" name="brand_secondary" type="color" defaultValue={b.brand_secondary ?? "#1f2937"} className="p-1" />
              </Field>
            </div>
            <label className="flex items-start gap-3 text-sm text-sand-700">
              <input
                type="checkbox"
                name="show_powered_by"
                defaultChecked={b.show_powered_by !== false}
                className="mt-0.5 h-5 w-5 rounded border-sand-300 text-brand-600"
              />
              <span>
                {t("partnerSettings.poweredBy", locale)}
                <span className="block text-sand-500">{t("partnerSettings.poweredByHint", locale)}</span>
              </span>
            </label>
            <TextareaField
              name="doc_terms"
              label={t("partnerSettings.terms", locale)}
              hint={t("partnerSettings.termsHint", locale)}
              rows={4}
              defaultValue={workshop?.doc_terms ?? ""}
            />
            <TextField name="doc_footer" label={t("partnerSettings.footer", locale)} defaultValue={workshop?.doc_footer ?? ""} />
          </div>
        </Card>

        <Card id="ps-docs">
          <CardHeader><CardTitle>{t("partnerSettings.documentDefaults", locale)}</CardTitle></CardHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              name="doc_prefix_quote"
              label={t("partnerSettings.quotePrefix", locale)}
              hint={t("partnerSettings.prefixHint", locale)}
              defaultValue={workshop?.doc_prefix_quote ?? "QTE"}
              maxLength={8}
            />
            <TextField
              name="doc_prefix_invoice"
              label={t("partnerSettings.invoicePrefix", locale)}
              defaultValue={workshop?.doc_prefix_invoice ?? "INV"}
              maxLength={8}
            />
            <TextField
              name="quote_validity_days"
              type="number"
              min={0}
              max={365}
              label={t("partnerSettings.quoteValidity", locale)}
              defaultValue={String(b.quoteValidityDays)}
            />
            <TextField
              name="invoice_terms_days"
              type="number"
              min={0}
              max={365}
              label={t("partnerSettings.invoiceTerms", locale)}
              defaultValue={String(b.invoiceTermsDays)}
            />
            <div className="sm:col-span-2">
              <VatRateField defaultBps={b.defaultVatRateBps} locale={locale} />
            </div>
          </div>
            <p className="mt-2 text-xs text-sand-500">
            {t("partnerSettings.vatDefaultHint", locale)} {vatPercent(b.defaultVatRateBps)}%
          </p>
        </Card>

        <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-10 -mx-1 rounded-xl border border-sand-200 bg-white/95 p-2 shadow-soft backdrop-blur sm:bottom-4">
          <SubmitButton className="w-full">{t("common.save", locale)}</SubmitButton>
        </div>
      </form>
    </div>
  );
}
