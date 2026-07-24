import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { formatChecklistValue, type ChecklistFieldType } from "@/lib/checklists";
import { signChecklistPhotos } from "@/lib/checklist-media";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { deleteChecklistInstance } from "../actions";

type Instance = {
  id: string; farm_id: string; machine_id: string; template_name: string; status: string;
  meter_reading: number | null; notes: string | null; performed_by: string | null;
  completed_at: string | null; created_at: string;
};
type ValueRow = {
  id: string; sort_order: number; field_type: string; label: string;
  value_text: string | null; notes: string | null; attachment_id: string | null;
};

export default async function ChecklistInstancePage({ params }: { params: Promise<{ id: string; instanceId: string }> }) {
  const profile = await requireProfile();
  const locale = profile.language;
  const { id: machineId, instanceId } = await params;
  const canEdit = ["owner", "manager", "mechanic"].includes(profile.role);

  const supabase = await createClient();
  const [{ data: instData }, { data: mData }] = await Promise.all([
    supabase
      .from("checklist_instances")
      .select("id, farm_id, machine_id, template_name, status, meter_reading, notes, performed_by, completed_at, created_at")
      .eq("id", instanceId)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase.from("machines").select("id, name, meter_type").eq("id", machineId).maybeSingle(),
  ]);
  const instance = instData as Instance | null;
  const machine = mData as { id: string; name: string; meter_type: string } | null;
  if (!instance || !machine || instance.machine_id !== machineId) notFound();

  const { data: vData } = await supabase
    .from("checklist_instance_values")
    .select("id, sort_order, field_type, label, value_text, notes, attachment_id")
    .eq("instance_id", instanceId)
    .is("deleted_at", null)
    .order("sort_order");
  const values = (vData as ValueRow[] | null) ?? [];

  // Resolve performer name + photo signed URLs.
  let performerName: string | null = null;
  if (instance.performed_by) {
    const { data: u } = await supabase.from("users").select("name").eq("id", instance.performed_by).maybeSingle();
    performerName = (u as { name: string } | null)?.name ?? null;
  }
  const attIds = values.map((v) => v.attachment_id).filter((x): x is string => Boolean(x));
  const pathById = new Map<string, string | null>();
  if (attIds.length > 0) {
    const { data: atts } = await supabase.from("attachments").select("id, storage_path").in("id", attIds).is("deleted_at", null);
    for (const a of (atts as { id: string; storage_path: string | null }[] | null) ?? []) pathById.set(a.id, a.storage_path);
  }
  const orderedAttIds = values.map((v) => (v.attachment_id ? pathById.get(v.attachment_id) ?? null : null));
  const signed = await signChecklistPhotos(supabase, orderedAttIds);
  const photoUrlByValueIdx = new Map<number, string | null>();
  values.forEach((_, i) => photoUrlByValueIdx.set(i, signed[i]));

  const dateStr = (instance.completed_at ?? instance.created_at).slice(0, 10);

  return (
    <div className="flex flex-col gap-4">
      <Link href={`/machines/${machine.id}`} className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-sm text-sand-500">
        <ChevronLeftIcon className="text-[1rem]" />
        {machine.name}
      </Link>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-sand-900">{instance.template_name}</h1>
              <Badge tone={instance.status === "completed" ? "ok" : "warning"}>
                {instance.status === "completed" ? t("checklists.statusCompleted", locale) : t("checklists.statusDraft", locale)}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-sand-500">
              {dateStr}
              {performerName ? ` · ${t("checklists.by", locale)} ${performerName}` : ""}
              {instance.meter_reading != null ? ` · ${instance.meter_reading} ${machine.meter_type !== "none" ? machine.meter_type : ""}` : ""}
            </p>
          </div>
          {canEdit ? (
            <form action={deleteChecklistInstance}>
              <input type="hidden" name="id" value={instance.id} />
              <input type="hidden" name="machine_id" value={machine.id} />
              <SubmitButton variant="ghost" size="sm">{t("common.delete", locale)}</SubmitButton>
            </form>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("checklists.results", locale)}</CardTitle></CardHeader>
        {values.length === 0 ? (
          <p className="text-sm text-sand-500">{t("checklists.noValues", locale)}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-sand-100">
            {values.map((v, i) => {
              const ft = v.field_type as ChecklistFieldType;
              if (ft === "section_break") {
                return (
                  <li key={v.id} className="pt-3 first:pt-0">
                    <p className="text-sm font-semibold uppercase tracking-wide text-sand-600">{v.label}</p>
                  </li>
                );
              }
              const url = photoUrlByValueIdx.get(i) ?? null;
              return (
                <li key={v.id} className="flex flex-col gap-1 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm font-medium text-sand-800">{v.label}</span>
                    {ft === "checkbox" ? (
                      <Badge tone={v.value_text === "true" ? "ok" : "neutral"}>{formatChecklistValue(ft, v.value_text, locale)}</Badge>
                    ) : ft !== "photo" ? (
                      <span className="text-right text-sm font-medium tabular-nums text-sand-900">{formatChecklistValue(ft, v.value_text, locale)}</span>
                    ) : null}
                  </div>
                  {ft === "photo" && url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt={v.label} className="mt-1 max-h-64 w-full max-w-xs rounded-lg object-cover ring-1 ring-sand-200" />
                  ) : null}
                  {ft === "photo" && !url ? <span className="text-sm text-sand-400">{t("checklists.noPhoto", locale)}</span> : null}
                  {v.notes ? <p className="text-sm text-sand-500">{v.notes}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
        {instance.notes ? (
          <div className="mt-3 border-t border-sand-100 pt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-sand-400">{t("checklists.overallNotes", locale)}</p>
            <p className="mt-1 text-sm text-sand-700">{instance.notes}</p>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
