import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";

export default async function DashboardPage() {
  const profile = await requireProfile();
  const supabase = await createClient();

  const now = new Date();
  const firstThis = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const firstLast = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const staleDate = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);

  const [overdue, dueSoon, okc, faultsRes, workshopRes, spendThis, spendLast, staleRes] = await Promise.all([
    supabase.from("service_plan_lines").select("id", { count: "exact", head: true }).eq("status", "overdue"),
    supabase.from("service_plan_lines").select("id", { count: "exact", head: true }).eq("status", "due_soon"),
    supabase.from("service_plan_lines").select("id", { count: "exact", head: true }).eq("status", "ok"),
    supabase.from("faults").select("id, machine_id, description, urgency").neq("status", "resolved").order("created_at", { ascending: false }).limit(10),
    supabase.from("machines").select("id, name").eq("status", "in_workshop"),
    supabase.from("job_cards").select("total_cents").gte("date_out", firstThis),
    supabase.from("job_cards").select("total_cents").gte("date_out", firstLast).lt("date_out", firstThis),
    supabase.from("machines").select("id, name").neq("meter_type", "none").or(`current_reading_date.is.null,current_reading_date.lt.${staleDate}`),
  ]);

  const sum = (rows: { total_cents: number }[] | null | undefined) =>
    (rows ?? []).reduce((a, b) => a + (b.total_cents || 0), 0);
  const faults = (faultsRes.data as { id: string; machine_id: string; description: string | null; urgency: string | null }[] | null) ?? [];
  const inWorkshop = (workshopRes.data as { id: string; name: string }[] | null) ?? [];
  const stale = (staleRes.data as { id: string; name: string }[] | null) ?? [];

  const fIds = [...new Set(faults.map((f) => f.machine_id))];
  const { data: fm } = fIds.length ? await supabase.from("machines").select("id, name").in("id", fIds) : { data: [] };
  const nameById = Object.fromEntries(((fm as { id: string; name: string }[] | null) ?? []).map((m) => [m.id, m.name]));

  const Tile = ({ label, value, tone }: { label: string; value: number | string; tone?: string }) => (
    <div className="rounded-lg border border-gray-200 p-3 text-center">
      <div className={`text-2xl font-bold ${tone ?? ""}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-bold">Dashboard</h1>

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-600">Service board</h2>
        <div className="grid grid-cols-3 gap-2">
          <Tile label="Overdue" value={overdue.count ?? 0} tone="text-status-overdue" />
          <Tile label="Due soon" value={dueSoon.count ?? 0} tone="text-status-due" />
          <Tile label="OK" value={okc.count ?? 0} tone="text-status-ok" />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-2">
        <Tile label="Spend this month" value={rands(sum(spendThis.data))} />
        <Tile label="Spend last month" value={rands(sum(spendLast.data))} />
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-600">Open faults</h2>
          <Link href="/faults" className="text-xs text-status-ok">All →</Link>
        </div>
        <ul className="flex flex-col divide-y divide-gray-100 text-sm">
          {faults.map((f) => (
            <li key={f.id} className="flex justify-between py-1.5">
              <span>{nameById[f.machine_id] ?? "—"}: {f.description}</span>
              <span className="text-gray-500">{f.urgency}</span>
            </li>
          ))}
          {faults.length === 0 ? <li className="py-1.5 text-gray-400">No open faults.</li> : null}
        </ul>
      </section>

      <section className="grid grid-cols-2 gap-4">
        <div>
          <h2 className="mb-1 text-sm font-medium text-gray-600">In workshop</h2>
          <ul className="text-sm text-gray-700">
            {inWorkshop.map((m) => <li key={m.id}>{m.name}</li>)}
            {inWorkshop.length === 0 ? <li className="text-gray-400">None</li> : null}
          </ul>
        </div>
        <div>
          <h2 className="mb-1 text-sm font-medium text-gray-600">Stale readings</h2>
          <ul className="text-sm text-gray-700">
            {stale.map((m) => <li key={m.id}>{m.name}</li>)}
            {stale.length === 0 ? <li className="text-gray-400">None</li> : null}
          </ul>
        </div>
      </section>

      <p className="text-xs text-gray-400">{profile.name} · {profile.role}</p>
    </div>
  );
}
