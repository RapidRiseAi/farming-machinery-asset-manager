import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { Pdf, pdfResponse } from "@/lib/pdf/doc";
import { warrantyStatus, type ExpiryStatus } from "@/lib/compliance";

export const dynamic = "force-dynamic";

/**
 * Warranty-claim doc pack (FR-13.4): the evidence a manufacturer/dealer wants for a claim —
 * the machine's identity, its warranty terms + current status, and the relevant service &
 * fault history that shows the asset was maintained. Server-route only; RLS-scoped.
 */

type Machine = {
  id: string; name: string; type: string; make: string | null; model: string | null; year: number | null;
  serial_no: string | null; reg_no: string | null; meter_type: string; current_reading: number | null;
  current_reading_date: string | null; status: string; purchase_date: string | null; supplier: string | null;
  warranty_expiry_date: string | null; warranty_expiry_hours: number | null;
};
type JC = { type: string; status: string; total_cents: number; date_out: string | null; created_at: string };
type Fault = { description: string | null; urgency: string | null; status: string; created_at: string };
type PlanLine = { task: string; interval_hours: number | null; interval_months: number | null; last_done_reading: number | null; last_done_date: string | null; status: string };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "machine";
const dash = (v: unknown) => (v == null || v === "" ? "—" : String(v));
const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const statusWord = (s: ExpiryStatus | null): string =>
  s === "expired" ? "EXPIRED" : s === "expiring" ? "Expiring soon" : s === "ok" ? "In warranty" : "—";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  const supabase = await createClient();
  const { data } = await supabase
    .from("machines")
    .select("id, name, type, make, model, year, serial_no, reg_no, meter_type, current_reading, current_reading_date, status, purchase_date, supplier, warranty_expiry_date, warranty_expiry_hours")
    .eq("id", id).is("deleted_at", null).maybeSingle();
  const m = data as Machine | null;
  if (!m) return new Response("Not found", { status: 404 });

  const [{ data: jcData }, { data: faultData }, { data: planData }] = await Promise.all([
    supabase.from("job_cards").select("type, status, total_cents, date_out, created_at").eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("faults").select("description, urgency, status, created_at").eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("service_plan_lines").select("task, interval_hours, interval_months, last_done_reading, last_done_date, status").eq("machine_id", id).is("deleted_at", null).order("created_at"),
  ]);
  const jobCards = (jcData as JC[] | null) ?? [];
  const faults = (faultData as Fault[] | null) ?? [];
  const plan = (planData as PlanLine[] | null) ?? [];

  const pdf = await Pdf.create(`Warranty claim pack — ${m.name}`);
  pdf.header("Machine, warranty terms & maintenance evidence");

  pdf.heading("Machine");
  pdf.kv("Type", titleCase(m.type));
  pdf.kv("Make / model / year", `${dash(m.make)} ${m.model ?? ""} ${m.year ? `(${m.year})` : ""}`.trim());
  pdf.kv("Serial / VIN", dash(m.serial_no));
  pdf.kv("Registration", dash(m.reg_no));
  pdf.kv("Current meter", m.current_reading != null ? `${m.current_reading} ${m.meter_type} (${dash(m.current_reading_date)})` : "—");
  pdf.kv("Purchased", `${dash(m.purchase_date)}${m.supplier ? ` · ${m.supplier}` : ""}`);

  pdf.heading("Warranty");
  pdf.kv("Expiry date", dash(m.warranty_expiry_date));
  pdf.kv("Expiry (hours)", m.warranty_expiry_hours != null ? `${m.warranty_expiry_hours} h` : "—");
  pdf.kv("Status", statusWord(warrantyStatus(m)));

  pdf.heading("Service history (maintenance evidence)");
  if (plan.length > 0) {
    pdf.table(
      ["Task", "Interval", "Last done", "Status"],
      plan.map((l) => [
        l.task,
        [l.interval_hours ? `${l.interval_hours}h` : "", l.interval_months ? `${l.interval_months}mo` : ""].filter(Boolean).join(" / "),
        `${dash(l.last_done_reading)} ${l.last_done_date ?? ""}`.trim(),
        titleCase(l.status),
      ]),
      [170, 100, 140, 89],
    );
    pdf.gap(6);
  }
  if (jobCards.length === 0) pdf.text("No job cards.");
  else pdf.table(
    ["Date", "Type", "Status", "Total"],
    jobCards.map((j) => [j.date_out ?? j.created_at.slice(0, 10), titleCase(j.type), titleCase(j.status), rands(j.total_cents)]),
    [110, 160, 130, 99], [false, false, false, true],
  );

  pdf.heading("Fault history");
  if (faults.length === 0) pdf.text("No faults recorded.");
  else pdf.table(
    ["Date", "Problem", "Urgency", "Status"],
    faults.map((f) => [f.created_at.slice(0, 10), f.description ?? "—", dash(f.urgency), titleCase(f.status)]),
    [80, 250, 90, 79],
  );

  const bytes = await pdf.save();
  return pdfResponse(bytes, `warranty-pack-${slug(m.name)}.pdf`);
}
