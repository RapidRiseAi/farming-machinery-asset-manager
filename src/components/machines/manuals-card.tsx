import { createClient } from "@/lib/supabase/server";
import { soft } from "@/lib/supabase/must";
import { t, type Lang } from "@/lib/i18n";
import { configuredManualReader } from "@/lib/manuals";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { DateText } from "@/components/ui/date-text";
import { indexManual, removeManual } from "@/app/(app)/machines/manual-actions";
import { ManualUpload } from "./manual-upload";

type Doc = { id: string; created_at: string };
type Indexed = { attachment_id: string; title: string; pages: number; text_bytes: number; indexed_at: string };

/**
 * An asset's manuals and whether each can be asked about (task B5). Shown only where questions over
 * manuals are on for this business (Complete, the flag) and a reader is configured; owners and
 * managers make a manual searchable, read it again, or take it out of search. The text a manual adds
 * is stated, not hidden.
 */
export async function ManualsCard({ farmId, machineId, canEdit, locale }: { farmId: string; machineId: string; canEdit: boolean; locale: Lang }) {
  if (!configuredManualReader()) return null;
  const supabase = await createClient();
  const { data: on } = await supabase.rpc("manual_questions_available", { p_farm: farmId });
  if (on !== true) return null;

  const docs = (soft(await supabase.from("attachments").select("id, created_at")
    .eq("parent_type", "machine").eq("parent_id", machineId).eq("kind", "doc").is("deleted_at", null)
    .order("created_at", { ascending: false }).limit(50), "machine:manuals") ?? []) as Doc[];
  const indexed = docs.length
    ? (soft(await supabase.from("manual_index").select("attachment_id, title, pages, text_bytes, indexed_at")
        .in("attachment_id", docs.map((d) => d.id)), "machine:manual-index") ?? []) as Indexed[]
    : [];
  const byId = new Map(indexed.map((i) => [i.attachment_id, i]));
  const kb = (bytes: number) => Math.max(1, Math.round(bytes / 1000));

  return (
    <Card>
      <CardHeader><CardTitle>{t("manuals.title", locale)}</CardTitle></CardHeader>
      <p className="mb-3 text-sm text-sand-600">{t("manuals.lead", locale)}</p>
      {canEdit ? <div className="mb-3"><ManualUpload farmId={farmId} machineId={machineId} label={t("manuals.upload", locale)} locale={locale} /></div> : null}
      {docs.length === 0 ? <p className="text-sm text-sand-600">{t("manuals.empty", locale)}</p> : (
        <ul className="divide-y divide-sand-200">
          {docs.map((d) => {
            const ix = byId.get(d.id);
            return (
              <li key={d.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-words font-medium text-sand-900">
                    {ix?.title ?? t("manuals.untitled", locale)} · <DateText value={d.created_at} locale={locale} />
                  </span>
                  {ix
                    ? <StatusBadge tone="ok" shape="check" label={t("manuals.searchable", locale)} />
                    : <StatusBadge tone="neutral" shape="ring" label={t("manuals.notSearchable", locale)} />}
                </div>
                {ix ? (
                  <p className="text-sm text-sand-600">
                    {t("manuals.size", locale).replace("{pages}", String(ix.pages)).replace("{kb}", String(kb(ix.text_bytes)))}
                  </p>
                ) : null}
                {canEdit ? (
                  <div className="flex flex-wrap gap-2">
                    <DialogForm trigger={t(ix ? "manuals.readAgain" : "manuals.makeSearchable", locale)} triggerVariant="secondary" triggerSize="sm"
                      title={t("manuals.makeSearchable", locale)} description={t("manuals.makeSearchableLead", locale)} closeLabel={t("ui.close", locale)} size="md">
                      <form action={indexManual}>
                        <RequestIdInput action="manuals:index" />
                        <input type="hidden" name="machine_id" value={machineId} />
                        <input type="hidden" name="attachment_id" value={d.id} />
                        <DialogFields columns={1}>
                          <TextField name="title" label={t("manuals.docTitle", locale)} hint={t("manuals.docTitleHint", locale)} required maxLength={80} defaultValue={ix?.title} />
                        </DialogFields>
                        <DialogActions cancelLabel={t("common.cancel", locale)}>
                          <SubmitButton>{t("manuals.read", locale)}</SubmitButton>
                        </DialogActions>
                      </form>
                    </DialogForm>
                    {ix ? (
                      <form action={removeManual}>
                        <input type="hidden" name="machine_id" value={machineId} />
                        <input type="hidden" name="attachment_id" value={d.id} />
                        <SubmitButton variant="ghost" size="sm">{t("manuals.remove", locale)}</SubmitButton>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
