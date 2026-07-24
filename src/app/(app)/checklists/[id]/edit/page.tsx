import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { ratingMax, isChecklistFieldType, type ChecklistFieldType } from "@/lib/checklists";
import { Card } from "@/components/ui/card";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { ChecklistTemplateBuilder } from "@/components/checklists/template-builder";

type FieldRow = {
  sort_order: number;
  field_type: string;
  label: string;
  required: boolean;
  help_text: string | null;
  config: Record<string, unknown> | null;
};
type TemplateRow = {
  id: string;
  farm_id: string | null;
  name: string;
  description: string | null;
  machine_type: string | null;
  checklist_template_fields: FieldRow[] | null;
};

export default async function EditChecklistTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const profile = await requireRole(["owner", "manager", "mechanic", "rr_admin"]);
  const locale = profile.language;
  const { id } = await params;

  const supabase = await createClient();
  const { data } = await supabase
    .from("checklist_templates")
    .select("id, farm_id, name, description, machine_type, checklist_template_fields(sort_order, field_type, label, required, help_text, config)")
    .eq("id", id)
    .is("deleted_at", null)
    .is("checklist_template_fields.deleted_at", null)
    .maybeSingle();
  const tpl = data as TemplateRow | null;
  if (!tpl) notFound();

  const isGlobal = tpl.farm_id == null;
  // Global templates are RR-admin-only; a farm template is its own farm's crew.
  if (isGlobal && profile.role !== "rr_admin") redirect("/checklists?error=forbidden");

  const initialFields = (tpl.checklist_template_fields ?? [])
    .filter((f) => isChecklistFieldType(f.field_type))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((f) => ({
      field_type: f.field_type as ChecklistFieldType,
      label: f.label,
      required: f.required,
      help_text: f.help_text ?? "",
      rating_max: ratingMax(f.config),
    }));

  return (
    <div className="flex flex-col gap-4">
      <Link href="/checklists" className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-sm text-sand-500">
        <ChevronLeftIcon className="text-[1rem]" />
        {t("checklists.title", locale)}
      </Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("checklists.editTemplate", locale)}</h1>
        <p className="mt-0.5 text-sm text-sand-500">{t("checklists.builderHint", locale)}</p>
      </div>
      <Card>
        <ChecklistTemplateBuilder
          mode="edit"
          locale={locale}
          templateId={tpl.id}
          isGlobal={isGlobal}
          initialName={tpl.name}
          initialDescription={tpl.description ?? ""}
          initialMachineType={tpl.machine_type ?? ""}
          initialFields={initialFields}
        />
      </Card>
    </div>
  );
}
