import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import {
  saveJobCard,
  addLine,
  removeLine,
  completeJobCard,
  approveJobCard,
  toggleServiceLine,
} from "../actions";

type JobCard = {
  id: string; farm_id: string; machine_id: string; type: string; status: string;
  date_in: string | null; date_out: string | null; meter_reading: number | null;
  diagnosis: string | null; work_performed: string | null; recommendations: string | null;
  parts_total_cents: number; labour_total_cents: number; other_total_cents: number; total_cents: number;
  locked: boolean; created_from_fault_id: string | null;
};
type Line = {
  id: string; kind: string; description: string | null; part_no: string | null;
  qty: number | null; unit_cost_cents: number | null; hours: number | null; rate_cents: number | null; total_cents: number;
};
type PlanLine = { id: string; task: string; status: string };

const STATUSES = ["open", "in_progress", "waiting_parts", "completed"];

export default async function JobCardDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data } = await supabase.from("job_cards").select("*").eq("id", id).maybeSingle();
  const jc = data as JobCard | null;
  if (!jc) notFound();

  const [{ data: machineData }, { data: linesData }, { data: planData }, { data: coverData }] = await Promise.all([
    supabase.from("machines").select("name, meter_type").eq("id", jc.machine_id).maybeSingle(),
    supabase.from("job_card_lines").select("id, kind, description, part_no, qty, unit_cost_cents, hours, rate_cents, total_cents").eq("job_card_id", id).is("deleted_at", null),
    supabase.from("service_plan_lines").select("id, task, status").eq("machine_id", jc.machine_id).is("deleted_at", null),
    supabase.from("job_card_service_lines").select("service_plan_line_id").eq("job_card_id", id),
  ]);
  const machine = machineData as { name: string; meter_type: string } | null;
  const lines = (linesData as Line[] | null) ?? [];
  const planLines = (planData as PlanLine[] | null) ?? [];
  const covered = new Set(((coverData as { service_plan_line_id: string }[] | null) ?? []).map((c) => c.service_plan_line_id));

  const canApprove = profile.role === "owner" || profile.role === "manager";
  const locked = jc.locked;
  const input = "rounded border border-gray-300 p-2";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href="/jobcards" className="text-sm text-gray-500">← Job cards</Link>
        <h1 className="mt-1 text-xl font-bold">{machine?.name ?? "Job card"}</h1>
        <p className="text-sm text-gray-500">
          {jc.type.replace("_", " ")} · {jc.status.replace("_", " ")}
          {locked ? " · 🔒 approved & locked" : ""}
        </p>
      </div>

      {sp.error ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{sp.error}</p> : null}
      {sp.saved ? <p className="rounded bg-green-50 p-2 text-sm text-green-700">Saved.</p> : null}

      <div className="rounded-lg border border-gray-200 p-4 text-sm">
        <div className="flex justify-between"><span>Parts</span><span>{rands(jc.parts_total_cents)}</span></div>
        <div className="flex justify-between"><span>Labour</span><span>{rands(jc.labour_total_cents)}</span></div>
        <div className="flex justify-between"><span>Other</span><span>{rands(jc.other_total_cents)}</span></div>
        <div className="mt-1 flex justify-between border-t border-gray-100 pt-1 font-medium"><span>Total (ex-VAT)</span><span>{rands(jc.total_cents)}</span></div>
      </div>

      {/* Lines */}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Lines</h2>
        <ul className="flex flex-col divide-y divide-gray-100 text-sm">
          {lines.map((l) => (
            <li key={l.id} className="flex items-center justify-between py-2">
              <span>
                <span className="font-medium">{l.description ?? l.kind}</span>{" "}
                <span className="text-gray-500">
                  {l.kind === "part" ? `${l.qty ?? 0} × ${rands(l.unit_cost_cents)}` : null}
                  {l.kind === "labour" ? `${l.hours ?? 0}h × ${rands(l.rate_cents)}` : null}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span>{rands(l.total_cents)}</span>
                {!locked ? (
                  <form action={removeLine}>
                    <input type="hidden" name="line_id" value={l.id} />
                    <input type="hidden" name="job_card_id" value={jc.id} />
                    <button className="text-red-600">✕</button>
                  </form>
                ) : null}
              </span>
            </li>
          ))}
          {lines.length === 0 ? <li className="py-2 text-gray-400">No lines yet.</li> : null}
        </ul>

        {!locked ? (
          <form action={addLine} className="mt-1 flex flex-col gap-2 rounded-lg border border-gray-200 p-3">
            <input type="hidden" name="job_card_id" value={jc.id} />
            <input type="hidden" name="farm_id" value={jc.farm_id} />
            <select name="kind" className={input} defaultValue="part">
              <option value="part">Part</option>
              <option value="labour">Labour</option>
              <option value="other">Other</option>
            </select>
            <input name="description" placeholder="Description" className={input} />
            <div className="flex flex-wrap gap-2">
              <input name="part_no" placeholder="Part no." className={`${input} flex-1`} />
              <input name="qty" type="number" step="0.01" placeholder="Qty (part)" className={`${input} w-28`} />
              <input name="unit_cost" type="number" step="0.01" placeholder="Unit R (part/other)" className={`${input} w-40`} />
              <input name="hours" type="number" step="0.01" placeholder="Hours (labour)" className={`${input} w-32`} />
              <input name="rate" type="number" step="0.01" placeholder="Rate R/h (labour)" className={`${input} w-36`} />
            </div>
            <button className="self-start rounded-lg bg-status-ok px-4 py-2 text-sm font-medium text-white">Add line</button>
          </form>
        ) : null}
      </section>

      {/* Covered service lines (scheduled service) */}
      {jc.type === "scheduled_service" && !locked && planLines.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Service lines covered</h2>
          <p className="text-xs text-gray-500">Ticked lines reset to this meter reading on completion.</p>
          <ul className="flex flex-col gap-1 text-sm">
            {planLines.map((pl) => (
              <li key={pl.id}>
                <form action={toggleServiceLine} className="flex items-center gap-2">
                  <input type="hidden" name="job_card_id" value={jc.id} />
                  <input type="hidden" name="farm_id" value={jc.farm_id} />
                  <input type="hidden" name="service_plan_line_id" value={pl.id} />
                  <input type="hidden" name="on" value={covered.has(pl.id) ? "0" : "1"} />
                  <button className={covered.has(pl.id) ? "text-status-ok" : "text-gray-400"}>
                    {covered.has(pl.id) ? "☑" : "☐"}
                  </button>
                  <span>{pl.task}</span>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Details + lifecycle */}
      {!locked ? (
        <form action={saveJobCard} className="flex flex-col gap-2 rounded-lg border border-gray-200 p-4">
          <input type="hidden" name="id" value={jc.id} />
          <h2 className="font-medium">Details</h2>
          <select name="status" defaultValue={jc.status} className={input}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s.replace("_", " ")}</option>
            ))}
          </select>
          <input name="meter_reading" type="number" step="0.1" defaultValue={jc.meter_reading ?? ""} placeholder={`Meter reading${machine ? ` (${machine.meter_type})` : ""}`} className={input} />
          <textarea name="diagnosis" defaultValue={jc.diagnosis ?? ""} placeholder="Diagnosis / cause" rows={2} className={input} />
          <textarea name="work_performed" defaultValue={jc.work_performed ?? ""} placeholder="Work performed" rows={2} className={input} />
          <textarea name="recommendations" defaultValue={jc.recommendations ?? ""} placeholder="Recommendations (→ watch item)" rows={2} className={input} />
          <button className="self-start rounded-lg border border-gray-300 px-4 py-2 text-sm">Save</button>
        </form>
      ) : null}

      {!locked ? (
        <div className="flex flex-wrap gap-2">
          <form action={completeJobCard}>
            <input type="hidden" name="id" value={jc.id} />
            <input type="hidden" name="meter_reading" value={jc.meter_reading ?? ""} />
            <button className="rounded-lg bg-status-due px-4 py-2 text-sm font-medium text-white">Mark completed</button>
          </form>
          {canApprove ? (
            <form action={approveJobCard}>
              <input type="hidden" name="id" value={jc.id} />
              <button className="rounded-lg bg-status-ok px-4 py-2 text-sm font-medium text-white">Approve &amp; lock</button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
