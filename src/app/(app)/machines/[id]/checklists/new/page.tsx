import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { isChecklistFieldType, type ChecklistFieldType } from "@/lib/checklists";
import { Card } from "@/components/ui/card";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { ChecklistForm, type FormTemplate } from "@/components/checklists/checklist-form";

type Machine = { id: string; farm_id: string; name: string; type: string; meter_type: string; current_reading: number | null };
type FieldRow = { id: string; sort_order: number; field_type: string; label: string; required: boolean; help_text: string | null; config: Record<string, unknown> | null };
type TplRow = { id: string; name: string; description: string | null; machine_type: string | null; checklist_template_fields: FieldRow[] | null };

export default async function NewMachineChecklistPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ template?: string }>;
}) {
  const profile = await requireRole(["owner", "manager", "mechanic", "workshop", "operator"]);
  const locale = profile.language;
  const { id } = await params;
  const sp = await searchParams;

  const supabase = await createClient();
  const { data: m } = await supabase
    .from("machines")
    .select("id, farm_id, name, type, meter_type, current_reading")
    .eq("id", id)
    .maybeSingle();
  const machine = m as Machine | null;
  if (!machine) notFound();

  // Templates usable for this machine: global (farm_id null via RLS) + own-farm, whose
  // machine_type matches the machine or is unset (any type). Mirrors the service-template
  // load on the machine detail page.
  const { data } = await supabase
    .from("checklist_templates")
    .select("id, name, description, machine_type, checklist_template_fields(id, sort_order, field_type, label, required, help_text, config)")
    .is("deleted_at", null)
    .is("checklist_template_fields.deleted_at", null)
    .or(`machine_type.eq.${machine.type},machine_type.is.null`)
    .order("name");
  const rows = (data as TplRow[] | null) ?? [];

  const templates: FormTemplate[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    fields: (r.checklist_template_fields ?? [])
      .filter((f) => isChecklistFieldType(f.field_type))
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((f) => ({
        id: f.id,
        sort_order: f.sort_order,
        field_type: f.field_type as ChecklistFieldType,
        label: f.label,
        required: f.required,
        help_text: f.help_text,
        config: f.config,
      })),
  }));

  return (
    <div className="flex flex-col gap-4">
      <Link href={`/machines/${machine.id}`} className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-sm text-sand-500">
        <ChevronLeftIcon className="text-[1rem]" />
        {machine.name}
      </Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("checklists.newChecklist", locale)}</h1>
        <p className="mt-0.5 text-sm text-sand-500">{t("checklists.fillHint", locale)}</p>
      </div>
      <Card>
        <ChecklistForm
          machineId={machine.id}
          meterType={machine.meter_type}
          currentReading={machine.current_reading}
          templates={templates}
          initialTemplateId={sp.template}
          locale={locale}
        />
      </Card>
    </div>
  );
}
