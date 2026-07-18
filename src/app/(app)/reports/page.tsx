import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";

type JC = { machine_id: string; type: string; total_cents: number; parts_total_cents: number; labour_total_cents: number; other_total_cents: number };
type Machine = { id: string; name: string; current_reading: number | null; meter_type: string };

function tally<T extends string>(rows: { k: T; n: number }[]): [T, number][] {
  const m = new Map<T, number>();
  for (const r of rows) m.set(r.k, (m.get(r.k) ?? 0) + r.n);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export default async function ReportsPage() {
  await requireProfile();
  const supabase = await createClient();

  const [{ data: jcData }, { data: mData }, { data: partsData }, { data: faultData }, { data: splData }] = await Promise.all([
    supabase.from("job_cards").select("machine_id, type, total_cents, parts_total_cents, labour_total_cents, other_total_cents"),
    supabase.from("machines").select("id, name, current_reading, meter_type"),
    supabase.from("job_card_lines").select("description").eq("kind", "part").is("deleted_at", null),
    supabase.from("faults").select("category"),
    supabase.from("service_plan_lines").select("status"),
  ]);
  const jcs = (jcData as JC[] | null) ?? [];
  const machines = (mData as Machine[] | null) ?? [];
  const parts = (partsData as { description: string | null }[] | null) ?? [];
  const faults = (faultData as { category: string | null }[] | null) ?? [];
  const spl = (splData as { status: string }[] | null) ?? [];

  // 1) Cost per machine (+ cost per hour for hours machines)
  const byMachine = new Map<string, { parts: number; labour: number; other: number; total: number }>();
  for (const j of jcs) {
    const a = byMachine.get(j.machine_id) ?? { parts: 0, labour: 0, other: 0, total: 0 };
    a.parts += j.parts_total_cents; a.labour += j.labour_total_cents; a.other += j.other_total_cents; a.total += j.total_cents;
    byMachine.set(j.machine_id, a);
  }
  const nameById = Object.fromEntries(machines.map((m) => [m.id, m]));

  // 2) Spend by job type
  const byType = tally(jcs.map((j) => ({ k: j.type as string, n: j.total_cents })));

  // 3) Service compliance
  const compliance = tally(spl.map((s) => ({ k: s.status, n: 1 })));

  // 4) Recurring problems
  const topParts = tally(parts.map((p) => ({ k: (p.description ?? "—") as string, n: 1 }))).slice(0, 5);
  const topFaults = tally(faults.map((f) => ({ k: (f.category ?? "uncategorised") as string, n: 1 }))).slice(0, 5);

  const cell = "py-1.5";
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Reports</h1>
        <a href="/reports/cost.csv" className="text-sm text-status-ok">Cost per machine · CSV ↓</a>
      </div>

      <section>
        <h2 className="mb-1 font-medium">Cost per machine</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-gray-500"><tr><th className={cell}>Machine</th><th>Parts</th><th>Labour</th><th>Other</th><th>Total</th><th>R/hr</th></tr></thead>
            <tbody>
              {[...byMachine.entries()].map(([id, a]) => {
                const m = nameById[id];
                const perHr = m && m.meter_type === "hours" && m.current_reading ? a.total / m.current_reading : null;
                return (
                  <tr key={id} className="border-t border-gray-100">
                    <td className={cell}>{m?.name ?? "—"}</td>
                    <td>{rands(a.parts)}</td><td>{rands(a.labour)}</td><td>{rands(a.other)}</td>
                    <td className="font-medium">{rands(a.total)}</td>
                    <td>{perHr != null ? rands(Math.round(perHr)) : "—"}</td>
                  </tr>
                );
              })}
              {byMachine.size === 0 ? <tr><td colSpan={6} className="py-3 text-gray-400">No job-card costs yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-6">
        <div>
          <h2 className="mb-1 font-medium">Spend by job type</h2>
          <ul className="text-sm">
            {byType.map(([k, n]) => <li key={k} className="flex justify-between"><span>{k.replace("_", " ")}</span><span>{rands(n)}</span></li>)}
            {byType.length === 0 ? <li className="text-gray-400">—</li> : null}
          </ul>
        </div>
        <div>
          <h2 className="mb-1 font-medium">Service compliance</h2>
          <ul className="text-sm">
            {compliance.map(([k, n]) => <li key={k} className="flex justify-between"><span>{k.replace("_", " ")}</span><span>{n}</span></li>)}
            {compliance.length === 0 ? <li className="text-gray-400">—</li> : null}
          </ul>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-6">
        <div>
          <h2 className="mb-1 font-medium">Most-replaced parts</h2>
          <ul className="text-sm">
            {topParts.map(([k, n]) => <li key={k} className="flex justify-between"><span>{k}</span><span>{n}</span></li>)}
            {topParts.length === 0 ? <li className="text-gray-400">—</li> : null}
          </ul>
        </div>
        <div>
          <h2 className="mb-1 font-medium">Top fault categories</h2>
          <ul className="text-sm">
            {topFaults.map(([k, n]) => <li key={k} className="flex justify-between"><span>{k}</span><span>{n}</span></li>)}
            {topFaults.length === 0 ? <li className="text-gray-400">—</li> : null}
          </ul>
        </div>
      </section>

      <Link href="/dashboard" className="text-sm text-gray-500">← Dashboard</Link>
    </div>
  );
}
