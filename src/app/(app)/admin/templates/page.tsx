import { requireRole } from "@/lib/auth";
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

type Line = { task: string; interval_hours: number | null; interval_months: number | null };
type Template = { id: string; name: string; machine_type: string | null; lines: Line[] };

const linesToText = (lines: Line[]) =>
  lines.map((l) => `${l.task} | ${l.interval_hours ?? ""} | ${l.interval_months ?? ""}`).join("\n");

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  await requireRole(["rr_admin"]);
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

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold tracking-tight text-sand-900">Service template library</h1>
      <p className="text-sm text-sand-500">Global templates farms can apply to a machine. One line per row: <code className="rounded bg-sand-100 px-1">Task | hours | months</code> (leave a number blank if not used).</p>
      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? "Saved." : undefined} />

      <Card>
        <CardHeader><CardTitle>New template</CardTitle></CardHeader>
        <form action={createTemplate} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="tpl-name" required><Input id="tpl-name" name="name" required placeholder="Tractor — standard" /></Field>
            <Field label="Machine type" htmlFor="tpl-type">{typeSelect("machine_type", "")}</Field>
          </div>
          <Field label="Lines" htmlFor="tpl-lines">
            <Textarea id="tpl-lines" name="lines" rows={4} placeholder={"Engine oil + filter | 250 | 12\nHydraulic service | 500 | 24"} />
          </Field>
          <SubmitButton variant="primary" className="self-start">Create template</SubmitButton>
        </form>
      </Card>

      {templates.length === 0 ? (
        <p className="text-sm text-sand-500">No global templates yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {templates.map((tpl) => (
            <li key={tpl.id}>
              <Card>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 className="font-semibold text-sand-900">{tpl.name}</h2>
                  <Badge tone="neutral">{tpl.machine_type ? TYPE_LABELS[tpl.machine_type] ?? tpl.machine_type : "Any type"}</Badge>
                </div>
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-brand-700">Edit ({tpl.lines?.length ?? 0} lines)</summary>
                  <form action={updateTemplate} className="mt-3 flex flex-col gap-3">
                    <input type="hidden" name="id" value={tpl.id} />
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Name" htmlFor={`n-${tpl.id}`}><Input id={`n-${tpl.id}`} name="name" defaultValue={tpl.name} /></Field>
                      <Field label="Machine type" htmlFor={`t-${tpl.id}`}>{typeSelect("machine_type", tpl.machine_type ?? "")}</Field>
                    </div>
                    <Field label="Lines" htmlFor={`l-${tpl.id}`}>
                      <Textarea id={`l-${tpl.id}`} name="lines" rows={4} defaultValue={linesToText(tpl.lines ?? [])} />
                    </Field>
                    <div className="flex gap-2">
                      <SubmitButton variant="primary" size="sm">Save</SubmitButton>
                    </div>
                  </form>
                  <form action={deleteTemplate} className="mt-2">
                    <input type="hidden" name="id" value={tpl.id} />
                    <button className="text-sm text-status-overdue">Delete template</button>
                  </form>
                </details>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
