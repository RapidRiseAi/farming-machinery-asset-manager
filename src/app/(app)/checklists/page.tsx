import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { typeLabel } from "@/lib/machine-options";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { ChevronRightIcon, PlusIcon } from "@/components/ui/icons";
import { deleteChecklistTemplate, duplicateChecklistTemplate } from "./actions";

type TemplateRow = {
  id: string;
  farm_id: string | null;
  name: string;
  description: string | null;
  machine_type: string | null;
  updated_at: string;
  checklist_template_fields: { id: string }[] | null;
};

type SP = { error?: string; saved?: string };

export default async function ChecklistsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const profile = await requireProfile();
  const sp = await searchParams;
  const locale = profile.language;
  const canManageFarm = ["owner", "manager", "mechanic"].includes(profile.role);
  const isAdmin = profile.role === "rr_admin";
  const canCreate = canManageFarm || isAdmin;

  const supabase = await createClient();
  const { data } = await supabase
    .from("checklist_templates")
    .select("id, farm_id, name, description, machine_type, updated_at, checklist_template_fields(id)")
    .is("deleted_at", null)
    .is("checklist_template_fields.deleted_at", null)
    .order("name");
  const templates = (data as TemplateRow[] | null) ?? [];

  // A global row is editable only by RR admin; a farm row by that farm's crew (RLS also enforces).
  const canEditRow = (tpl: TemplateRow) => (tpl.farm_id == null ? isAdmin : canManageFarm);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("checklists.title", locale)}</h1>
          <p className="mt-0.5 text-sm text-sand-500">{t("checklists.subtitle", locale)}</p>
        </div>
        {canCreate ? (
          <Link
            href="/checklists/new"
            className="focus-ring inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <PlusIcon className="text-[1.1rem]" />
            {t("checklists.newTemplate", locale)}
          </Link>
        ) : null}
      </div>

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      {templates.length === 0 ? (
        <Card>
          <EmptyState
            title={t("checklists.empty", locale)}
            hint={canCreate ? t("checklists.emptyHint", locale) : undefined}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {templates.map((tpl) => {
            const fieldCount = (tpl.checklist_template_fields ?? []).length;
            return (
              <Card key={tpl.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold text-sand-900">{tpl.name}</h2>
                      <Badge tone={tpl.farm_id == null ? "info" : "neutral"}>
                        {tpl.farm_id == null ? t("checklists.scopeGlobal", locale) : t("checklists.scopeFarm", locale)}
                      </Badge>
                      {tpl.machine_type ? <Badge tone="neutral">{typeLabel(tpl.machine_type, locale)}</Badge> : null}
                    </div>
                    {tpl.description ? <p className="mt-1 text-sm text-sand-600">{tpl.description}</p> : null}
                    <p className="mt-1 text-xs text-sand-500">
                      {t("checklists.fieldCount", locale).replace("{n}", String(fieldCount))} ·{" "}
                      {t("checklists.updated", locale)} {tpl.updated_at.slice(0, 10)}
                    </p>
                  </div>
                  {canEditRow(tpl) ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Link
                        href={`/checklists/${tpl.id}/edit`}
                        className="focus-ring inline-flex items-center gap-1 rounded-lg border border-sand-300 px-3 py-1.5 font-medium text-sand-700 hover:bg-sand-50"
                      >
                        {t("common.edit", locale)}
                      </Link>
                      <form action={duplicateChecklistTemplate}>
                        <input type="hidden" name="id" value={tpl.id} />
                        <SubmitButton variant="secondary" size="sm">{t("checklists.duplicate", locale)}</SubmitButton>
                      </form>
                      <form action={deleteChecklistTemplate}>
                        <input type="hidden" name="id" value={tpl.id} />
                        <button className="focus-ring rounded-lg px-2 py-1.5 text-status-overdue hover:bg-red-50">
                          {t("common.delete", locale)}
                        </button>
                      </form>
                    </div>
                  ) : (
                    <span className="flex items-center text-sand-300"><ChevronRightIcon /></span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
