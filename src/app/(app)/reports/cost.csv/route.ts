import { getUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/** Cost-per-machine CSV for the accountant (Scope §4.8). Farm-scoped by RLS. */
export async function GET() {
  const user = await getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const supabase = await createClient();
  const [{ data: jcData }, { data: mData }] = await Promise.all([
    supabase.from("job_cards").select("machine_id, parts_total_cents, labour_total_cents, other_total_cents, total_cents"),
    supabase.from("machines").select("id, name, current_reading, meter_type"),
  ]);
  const jcs = (jcData as { machine_id: string; parts_total_cents: number; labour_total_cents: number; other_total_cents: number; total_cents: number }[] | null) ?? [];
  const machines = (mData as { id: string; name: string; current_reading: number | null; meter_type: string }[] | null) ?? [];
  const mById = Object.fromEntries(machines.map((m) => [m.id, m]));

  const agg = new Map<string, { parts: number; labour: number; other: number; total: number }>();
  for (const j of jcs) {
    const a = agg.get(j.machine_id) ?? { parts: 0, labour: 0, other: 0, total: 0 };
    a.parts += j.parts_total_cents; a.labour += j.labour_total_cents; a.other += j.other_total_cents; a.total += j.total_cents;
    agg.set(j.machine_id, a);
  }

  const c = (cents: number) => (cents / 100).toFixed(2);
  const rows = [["Machine", "Parts (R)", "Labour (R)", "Other (R)", "Total (R)", "Cost per hour (R)"]];
  for (const [id, a] of agg.entries()) {
    const m = mById[id];
    const perHr = m && m.meter_type === "hours" && m.current_reading ? c(a.total / m.current_reading) : "";
    rows.push([m?.name ?? "—", c(a.parts), c(a.labour), c(a.other), c(a.total), perHr]);
  }
  const csv = rows.map((r) => r.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(",")).join("\r\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="cost-per-machine.csv"',
    },
  });
}
