import Link from "next/link";
import { errorMessage } from "@/lib/errors";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { typeLabel } from "@/lib/machine-options";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { ActionMenu } from "@/components/ui/action-menu";
import { menuItemClass } from "@/components/ui/menu-item";
import { CopyIcon, PlusIcon, TrashIcon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { deleteChecklistTemplate, duplicateChecklistTemplate } from "./actions";
import { num, relativeDate } from "@/lib/format";

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
  const locale = profile.lang;
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

  const closeLabel = t("ui.close", locale);

  return (
    <PageContainer>
      {/* The New template link was once a hand-rolled copy of the primary button whose
          `py-2` made it about 36px tall. `buttonVariants` carries the 48px phone floor. */}
      <PageHeader
        title={t("checklists.title", locale)}
        lead={t("checklists.subtitle", locale)}
        infoKey="checklists"
        locale={locale}
        actions={
          canCreate ? (
            <Link href="/checklists/new" className={buttonVariants({ variant: "primary" })}>
              <PlusIcon className="text-lg" />
              {t("checklists.newTemplate", locale)}
            </Link>
          ) : undefined
        }
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
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
            const editable = canEditRow(tpl);
            // A template this person cannot edit (the shared library, for a farm) can
            // still be copied into their own farm and changed there.
            const copyable = !editable && canCreate;
            return (
              <Card key={tpl.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="min-w-0 break-words font-semibold text-sand-900">
                        {editable ? (
                          <Link
                            href={`/checklists/${tpl.id}/edit`}
                            className="focus-ring rounded hover:underline"
                          >
                            {tpl.name}
                          </Link>
                        ) : (
                          tpl.name
                        )}
                      </h2>
                      <Badge tone={tpl.farm_id == null ? "info" : "neutral"}>
                        {tpl.farm_id == null ? t("checklists.scopeGlobal", locale) : t("checklists.scopeFarm", locale)}
                      </Badge>
                      {tpl.machine_type ? <Badge tone="neutral">{typeLabel(tpl.machine_type, locale)}</Badge> : null}
                    </div>
                    {tpl.description ? <p className="mt-1 text-sm text-sand-600">{tpl.description}</p> : null}
                    <p className="mt-1 text-xs text-sand-500">
                      {t("checklists.fieldCount", locale).replace("{n}", num(fieldCount))} ·{" "}
                      {t("checklists.updated", locale)} {relativeDate(tpl.updated_at, locale)}
                    </p>
                  </div>
                  {/* Every action on this template behind one button, titled with it.
                      These were three loose buttons, one of them 32px tall. */}
                  {editable ? (
                    <ActionMenu
                      title={tpl.name}
                      label={t("common.actions", locale)}
                      closeLabel={closeLabel}
                    >
                      <Link href={`/checklists/${tpl.id}/edit`} className={menuItemClass()}>
                        {t("common.edit", locale)}
                      </Link>
                      <form action={duplicateChecklistTemplate}>
                        <input type="hidden" name="id" value={tpl.id} />
                        <SubmitButton look="menuItem" leftIcon={<CopyIcon />}>
                          {t("checklists.duplicate", locale)}
                        </SubmitButton>
                      </form>
                      <ConfirmDialog
                        action={deleteChecklistTemplate}
                        triggerLook="menuItem"
                        triggerIcon={<TrashIcon />}
                        triggerLabel={t("common.delete", locale)}
                        title={t("confirm.deleteChecklistTemplateTitle", locale).replace("{template}", tpl.name)}
                        intro={t("confirm.deleteChecklistTemplateIntro", locale)}
                        consequencesTitle={t("confirm.whatHappens", locale)}
                        consequences={[
                          t("confirm.deleteChecklistTemplateEffect1", locale),
                          t("confirm.deleteChecklistTemplateEffect2", locale),
                        ]}
                        footnote={t("confirm.softDeleteNote", locale)}
                        confirmLabel={t("confirm.deleteChecklistTemplateYes", locale)}
                        cancelLabel={t("confirm.keepIt", locale)}
                        closeLabel={closeLabel}
                      >
                        <input type="hidden" name="id" value={tpl.id} />
                      </ConfirmDialog>
                    </ActionMenu>
                  ) : copyable ? (
                    <ActionMenu
                      title={tpl.name}
                      label={t("common.actions", locale)}
                      closeLabel={closeLabel}
                    >
                      <form action={duplicateChecklistTemplate}>
                        <input type="hidden" name="id" value={tpl.id} />
                        <SubmitButton look="menuItem" leftIcon={<CopyIcon />}>
                          {t("checklists.copyToFarm", locale)}
                        </SubmitButton>
                      </form>
                    </ActionMenu>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}
