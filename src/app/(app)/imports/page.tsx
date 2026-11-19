import Link from "next/link";
import { redirect } from "next/navigation";
import { currentFarmId, effectiveFarmRole, getFarmPlan, homePathFor, requireProfile } from "@/lib/auth";
import { planAllows } from "@/lib/entitlements";
import { featureOn } from "@/lib/features";
import { configuredProvider } from "@/lib/extraction";
import { createClient } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { downloadLabels } from "@/lib/interaction-labels";
import { Card } from "@/components/ui/card";
import { Flash } from "@/components/ui/flash";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { DownloadLink } from "@/components/ui/download-link";
import { DateText } from "@/components/ui/date-text";
import { PlusIcon } from "@/components/ui/icons";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { startDocumentImport, startReadingsImport } from "./actions";
import { BatchStatus, type BatchStatusValue } from "./batch-status";

export const dynamic = "force-dynamic";

type Batch = {
  id: string;
  source: "sheet" | "document";
  file_name: string | null;
  status: BatchStatusValue;
  created_at: string;
  written: number | null;
  skipped: number | null;
};

/**
 * Import review (task B5, 20261121110000): readings from a sheet are staged, each row is checked by
 * a person, and only then written. Owners and managers; every plan (reading photos and PDFs is a
 * separate, flagged path).
 */
export default async function ImportsPage({ searchParams }: { searchParams: Promise<{ error?: string; cancelled?: string }> }) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const sp = await searchParams;
  const farmId = await currentFarmId(profile);
  if (!farmId) redirect(`${homePathFor(profile.role)}?denied=1`);
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !["owner", "manager", "rr_admin"].includes(role)) redirect(`${homePathFor(profile.role)}?denied=1`);

  const supabase = await createClient();
  const { data, error } = await supabase.from("import_batches")
    .select("id,source,file_name,status,created_at,written,skipped")
    .eq("farm_id", farmId).order("created_at", { ascending: false }).limit(50);
  const batches = (data ?? []) as Batch[];
  // Reading documents shows only when everything it needs is in place: a configured reader, the
  // readiness flag for this business, and a plan with the paid-assistance path (the database and
  // the action check each again).
  const plan = await getFarmPlan(farmId);
  const documentsReady = !!configuredProvider() && !!plan && planAllows(plan, "voice_ai") && (await featureOn("document_extraction", farmId));

  return (
    <PageContainer size="narrow">
      <PageHeader
        title={t("imports.title", locale)}
        lead={t("imports.lead", locale)}
        locale={locale}
        back={{ href: "/machines", label: t("nav.machines", locale) }}
        actions={
          <>
          {documentsReady ? (
            <DialogForm trigger={t("imports.newDocument", locale)} triggerVariant="secondary" title={t("imports.newDocumentTitle", locale)}
              description={t("imports.newDocumentLead", locale)} closeLabel={t("ui.close", locale)} size="md">
              <form action={startDocumentImport}>
                <RequestIdInput action="imports:document" />
                <DialogFields columns={1}>
                  <Field label={t("imports.documentFile", locale)} hint={t("imports.documentHint", locale)} htmlFor="import_document">
                    <Input id="import_document" name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required />
                  </Field>
                </DialogFields>
                <DialogActions cancelLabel={t("common.cancel", locale)}>
                  <SubmitButton>{t("imports.documentRead", locale)}</SubmitButton>
                </DialogActions>
              </form>
            </DialogForm>
          ) : null}
          <DialogForm trigger={t("imports.new", locale)} triggerIcon={<PlusIcon />} title={t("imports.newTitle", locale)}
            description={t("imports.newLead", locale)} closeLabel={t("ui.close", locale)} size="md">
            <form action={startReadingsImport}>
              <RequestIdInput action="imports:start" />
              <DialogFields columns={1}>
                <Field label={t("imports.file", locale)} hint={t("imports.fileHint", locale)} htmlFor="import_file">
                  <Input id="import_file" name="file" type="file" accept=".csv,text/csv" required />
                </Field>
                <DownloadLink href="/api/imports/readings-template.csv" labels={downloadLabels(locale)} className="text-sm font-medium text-brand-700 underline">
                  {t("imports.template", locale)}
                </DownloadLink>
              </DialogFields>
              <DialogActions cancelLabel={t("common.cancel", locale)}>
                <SubmitButton>{t("imports.upload", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
          </>
        }
      />
      <Flash tone="error" message={error ? errorMessage("load_failed", locale) : errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.cancelled ? t("imports.cancelled", locale) : undefined} />

      {batches.length === 0 ? (
        <Card><p className="text-sm text-sand-600">{t("imports.empty", locale)}</p></Card>
      ) : (
        <Card>
          <ul className="divide-y divide-sand-200">
            {batches.map((b) => (
              <li key={b.id} className="py-3 first:pt-0 last:pb-0">
                <Link href={`/imports/${b.id}`} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0">
                    <span className="block break-words font-semibold text-sand-900">{b.file_name ?? t(`imports.source.${b.source}`, locale)}</span>
                    <span className="block text-sm text-sand-600">
                      <DateText value={b.created_at} locale={locale} />
                      {b.status === "confirmed"
                        ? ` · ${t("imports.writtenSkipped", locale).replace("{written}", String(b.written ?? 0)).replace("{skipped}", String(b.skipped ?? 0))}`
                        : ""}
                    </span>
                  </span>
                  <BatchStatus status={b.status} locale={locale} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </PageContainer>
  );
}
