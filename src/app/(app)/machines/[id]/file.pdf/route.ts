import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { Pdf, pdfResponse } from "@/lib/pdf/doc";

export const dynamic = "force-dynamic";

type Machine = {
  id: string; name: string; type: string; make: string | null; model: string | null; year: number | null;
  serial_no: string | null; reg_no: string | null; meter_type: string; current_reading: number | null;
  current_reading_date: string | null; status: string;
};
type JC = { id: string; type: string; status: string; total_cents: number; date_out: string | null; created_at: string };
type Plan = { task: string; interval_hours: number | null; interval_months: number | null; last_done_reading: number | null; last_done_date: string | null; next_due_reading: number | null; next_due_date: string | null; status: string };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "machine";
const dash = (v: unknown) => (v == null || v === "" ? "—" : String(v));

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  const supabase = await createClient();
  const { data } = await supabase
    .from("machines")
    .select("id, name, type, make, model, year, serial_no, reg_no, meter_type, current_reading, current_reading_date, status")
    .eq("id", id).is("deleted_at", null).maybeSingle();
  const m = data as Machine | null;
  if (!m) return new Response("Not found", { status: 404 });

  const [{ data: jcData }, { data: planData }, { data: faultData }, { data: readingData }, { data: watchData }] = await Promise.all([
    supabase.from("job_cards").select("id, type, status, total_cents, date_out, created_at").eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("service_plan_lines").select("task, interval_hours, interval_months, last_done_reading, last_done_date, next_due_reading, next_due_date, status").eq("machine_id", id).is("deleted_at", null).order("created_at"),
    supabase.from("faults").select("description, urgency, status, created_at").eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("meter_readings").select("reading, reading_date, source").eq("machine_id", id).is("deleted_at", null).order("reading_date", { ascending: false }).limit(30),
    supabase.from("watch_items").select("text, status").eq("machine_id", id).order("created_at", { ascending: false }),
  ]);
  const jobCards = (jcData as JC[] | null) ?? [];
  const plan = (planData as Plan[] | null) ?? [];
  const faults = (faultData as { description: string | null; urgency: string | null; status: string; created_at: string }[] | null) ?? [];
  const readings = (readingData as { reading: number; reading_date: string; source: string }[] | null) ?? [];
  const watch = (watchData as { text: string; status: string }[] | null) ?? [];

  const totalSpend = jobCards.reduce((a, j) => a + (j.total_cents || 0), 0);
  const perHour = m.meter_type === "hours" && m.current_reading && m.current_reading > 0 ? Math.round(totalSpend / m.current_reading) : null;

  const pdf = await Pdf.create(`Machine file — ${m.name}`);
  pdf.header("Service book & history");

  pdf.kv("Type", m.type.replace(/_/g, " "));
  pdf.kv("Make / model / year", `${dash(m.make)} ${m.model ?? ""} ${m.year ? `(${m.year})` : ""}`.trim());
  pdf.kv("Serial / VIN", dash(m.serial_no));
  pdf.kv("Registration", dash(m.reg_no));
  pdf.kv("Status", m.status.replace(/_/g, " "));
  pdf.kv("Current meter", m.current_reading != null ? `${m.current_reading} ${m.meter_type} (${dash(m.current_reading_date)})` : "—");

  pdf.heading("Lifetime stats");
  pdf.kv("Total spend (ex-VAT)", rands(totalSpend));
  pdf.kv("Job cards", String(jobCards.length));
  pdf.kv("Cost per hour", perHour != null ? rands(perHour) : "—");

  pdf.heading("Service plan");
  if (plan.length === 0) pdf.text("No service plan.");
  else pdf.table(
    ["Task", "Interval", "Last done", "Next due", "Status"],
    plan.map((l) => [
      l.task,
      [l.interval_hours ? `${l.interval_hours}h` : "", l.interval_months ? `${l.interval_months}mo` : ""].filter(Boolean).join(" / "),
      `${dash(l.last_done_reading)} ${l.last_done_date ?? ""}`.trim(),
      `${dash(l.next_due_reading)} ${l.next_due_date ?? ""}`.trim(),
      l.status.replace(/_/g, " "),
    ]),
    [150, 90, 105, 105, 49],
  );

  pdf.heading("Job card history");
  if (jobCards.length === 0) pdf.text("No job cards.");
  else pdf.table(
    ["Date", "Type", "Status", "Total"],
    jobCards.map((j) => [j.date_out ?? j.created_at.slice(0, 10), j.type.replace(/_/g, " "), j.status.replace(/_/g, " "), rands(j.total_cents)]),
    [110, 160, 130, 99],
    [false, false, false, true],
  );

  pdf.heading("Fault history");
  if (faults.length === 0) pdf.text("No faults.");
  else pdf.table(
    ["Date", "Problem", "Urgency", "Status"],
    faults.map((f) => [f.created_at.slice(0, 10), f.description ?? "—", f.urgency ?? "—", f.status]),
    [80, 250, 90, 79],
  );

  pdf.heading("Recent meter readings");
  if (readings.length === 0) pdf.text("No readings.");
  else pdf.table(
    ["Date", "Reading", "Source"],
    readings.map((r) => [r.reading_date, `${r.reading} ${m.meter_type}`, r.source]),
    [140, 200, 159],
  );

  if (watch.filter((w) => w.status === "open").length > 0) {
    pdf.heading("Open watch items");
    for (const w of watch.filter((x) => x.status === "open")) pdf.text(`- ${w.text}`);
  }

  const bytes = await pdf.save();
  return pdfResponse(bytes, `machine-file-${slug(m.name)}.pdf`);
}
