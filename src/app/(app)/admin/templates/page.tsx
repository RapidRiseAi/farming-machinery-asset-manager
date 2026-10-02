import { requireRole } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/server";
import { MACHINE_TYPES, TYPE_LABELS } from "@/lib/machine-options";
import { createTemplate, updateTemplate, deleteTemplate } from "./actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ActionMenu } from "@/components/ui/action-menu";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { PlusIcon, TrashIcon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { num } from "@/lib/format";

type Line = { task: string; interval_hours: number | null; interval_months: number | null };
type Template = { id: string; name: string; machine_type: string | null; lines: Line[] };

/** One line, read as a sentence: "every 250 hours or 12 months". */
const intervalText = (l: Line): string => {
  const parts = [
    l.interval_hours != null ? `${num(l.interval_hours)} hours` : null,
    l.interval_months != null ? `${num(l.interval_months)} month${l.interval_months === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.length === 0 ? "no interval set" : `every ${parts.join(" or ")}`;
};

const LINES_HINT = "One line per task: Task | hours | months. Leave a number blank if it is not used.";

const linesToText = (lines: Line[]) =>
  lines.map((l) => `${l.task} | ${l.interval_hours ?? ""} | ${l.interval_months ?? ""}`).join("\n");

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  // The profile was discarded here, so this page had no locale to translate with.
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
  const sp = await searchParams;
  const supabase = await createClient();

  // Global library templates (farm_id null).
  const { data } = await supabase.from("service_templates").select("id, name, machine_type, lines").is("farm_id", null).is("deleted_at", null).order("name");
  const templates = (data as Template[] | null) ?? [];

  const typeSelect = (name: string, def: string) => (
    <Select name={name} defaultValue={def}>
      <option value="">Any type</option>
      {MACHINE_TYPES.map((ty) => (
        <option key={ty} value={ty}>{TYPE_LABELS[ty]}</option>
      ))}
    </Select>
  );

  const newTemplate = (
    <DialogForm
      trigger="New template"
      triggerIcon={<PlusIcon />}
      title="New template"
      description="A global template every farm can apply to a machine."
      closeLabel="Close"
    >
      <form action={createTemplate}>
        <DialogFields>
          <Field label="Name" htmlFor="tpl-name" required><Input id="tpl-name" name="name" required placeholder="Tractor, standard" /></Field>
          <Field label="Machine type" htmlFor="tpl-type">{typeSelect("machine_type", "")}</Field>
          <div className="sm:col-span-2">
            <Field label="Tasks" htmlFor="tpl-lines" hint={LINES_HINT}>
              <Textarea id="tpl-lines" name="lines" rows={5} placeholder={"Engine oil + filter | 250 | 12\nHydraulic service | 500 | 24"} />
            </Field>
          </div>
        </DialogFields>
        <DialogActions cancelLabel="Cancel">
          <SubmitButton>Create template</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  return (
    <PageContainer size="default">
      <PageHeader
        title="Service template library"
        meta={templates.length > 0 ? `${num(templates.length)} template${templates.length === 1 ? "" : "s"}` : undefined}
        lead="Global templates any farm can apply to a machine, so its service plan starts filled in."
        actions={newTemplate}
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      {templates.length === 0 ? (
        <EmptyState title="No global templates yet" hint="Add the first one with New template." />
      ) : (
        <ul className="flex flex-col gap-3">
          {templates.map((tpl) => (
            <li key={tpl.id}>
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="min-w-0 break-words font-semibold text-sand-900">{tpl.name}</h2>
                      <Badge tone="neutral">{tpl.machine_type ? TYPE_LABELS[tpl.machine_type] ?? tpl.machine_type : "Any type"}</Badge>
                    </div>
                    {(tpl.lines ?? []).length === 0 ? (
                      <p className="mt-1 text-sm text-sand-500">No tasks yet.</p>
                    ) : (
                      <ul className="mt-2 flex flex-col gap-1 text-sm">
                        {(tpl.lines ?? []).map((l, i) => (
                          <li key={i} className="flex flex-wrap justify-between gap-x-3">
                            <span className="min-w-0 break-words text-sand-900">{l.task}</span>
                            <span className="tnum text-sand-500">{intervalText(l)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                {/* Edit and delete, behind one button, like every other row in the
                    product. It was a `<details>` holding a three-field form plus the
                    delete, so each template shipped its editor to keep it hidden. */}
                  <ActionMenu
                    title={tpl.name}
                    label={`Actions for ${tpl.name}`}
                    closeLabel="Close"
                  >
                    <DialogForm
                      triggerLook="menuItem"
                      trigger="Edit"
                      title="Edit template"
                      description={tpl.name}
                      closeLabel="Close"
                    >
                      <form action={updateTemplate}>
                        <input type="hidden" name="id" value={tpl.id} />
                        <DialogFields>
                          <Field label="Name" htmlFor={`n-${tpl.id}`}><Input id={`n-${tpl.id}`} name="name" defaultValue={tpl.name} /></Field>
                          <Field label="Machine type" htmlFor={`t-${tpl.id}`}>{typeSelect("machine_type", tpl.machine_type ?? "")}</Field>
                          <div className="sm:col-span-2">
                            <Field label="Tasks" htmlFor={`l-${tpl.id}`} hint={LINES_HINT}>
                              <Textarea id={`l-${tpl.id}`} name="lines" rows={4} defaultValue={linesToText(tpl.lines ?? [])} />
                            </Field>
                          </div>
                        </DialogFields>
                        <DialogActions cancelLabel="Cancel">
                          <SubmitButton variant="primary">Save</SubmitButton>
                        </DialogActions>
                      </form>
                    </DialogForm>

                    <ConfirmDialog
                      action={deleteTemplate}
                      triggerLook="menuItem"
                      triggerIcon={<TrashIcon />}
                      triggerLabel="Delete template"
                      title={`Delete the “${tpl.name}” service template?`}
                      intro="This is a Rapid Rise template every farm can apply."
                      consequencesTitle="What happens when you press it"
                      consequences={[
                        "No farm can apply it to a machine again",
                        "Machines that already use it keep their service plans",
                      ]}
                      footnote="Nothing is really erased, it stops showing in the library and stays in the history."
                      confirmLabel="Yes, delete the template"
                      cancelLabel="Never mind"
                      closeLabel="Close"
                    >
                      <input type="hidden" name="id" value={tpl.id} />
                    </ConfirmDialog>
                  </ActionMenu>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
