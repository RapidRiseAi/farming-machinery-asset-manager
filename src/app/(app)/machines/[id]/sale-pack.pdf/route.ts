import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { Pdf, pdfResponse } from "@/lib/pdf/doc";
import { summariseCosts, costPerMeter, COST_TYPES } from "@/lib/cost";
import { warrantyStatus, dateExpiryStatus, type ExpiryStatus } from "@/lib/compliance";

export const dynamic = "force-dynamic";

/**
 * Vehicle-sale doc pack (FR-13.4): one document a buyer/agent expects when a machine changes
 * hands — identity + full service history + lifetime costs/TCO + compliance (warranty +
 * licences). Server-route only; RLS scopes access to the caller's farm.
 */

type Machine = {
  id: string; name: string; type: string; make: string | null; model: string | null; year: number | null;
  serial_no: string | null; reg_no: string | null; meter_type: string; current_reading: number | null;
  current_reading_date: string | null; status: string; purchase_date: string | null; purchase_price_cents: number | null;
  supplier: string | null; warranty_expiry_date: string | null; warranty_expiry_hours: number | null;
};
type JC = { type: string; status: string; total_cents: number; date_out: string | null; created_at: string };
type Licence = { type: string; number: string | null; expiry_date: string; reminder_lead_days: number };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "machine";
const dash = (v: unknown) => (v == null || v === "" ? "—" : String(v));
const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const statusWord = (s: ExpiryStatus | null): string =>
  s === "expired" ? "EXPIRED" : s === "expiring" ? "Expiring soon" : s === "ok" ? "In date" : "—";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  const supabase = await createClient();
  const { data } = await supabase
    .from("machines")
    .select("id, name, type, make, model, year, serial_no, reg_no, meter_type, current_reading, current_reading_date, status, purchase_date, purchase_price_cents, supplier, warranty_expiry_date, warranty_expiry_hours")
    .eq("id", id).is("deleted_at", null).maybeSingle();
  const m = data as Machine | null;
  if (!m) return new Response("Not found", { status: 404 });

  const [{ data: jcData }, { data: costData }, { data: licData }] = await Promise.all([
    supabase.from("job_cards").select("type, status, total_cents, date_out, created_at").eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("cost_entries").select("type, amount_cents").eq("machine_id", id).is("deleted_at", null),
    supabase.from("licences").select("type, number, expiry_date, reminder_lead_days").eq("machine_id", id).is("deleted_at", null).order("expiry_date"),
  ]);
  const jobCards = (jcData as JC[] | null) ?? [];
  const costRows = (costData as { type: string; amount_cents: number | null }[] | null) ?? [];
  const licences = (licData as Licence[] | null) ?? [];

  const { total: tco, breakdown } = summariseCosts(costRows);
  const perMeter = m.meter_type === "hours" || m.meter_type === "km" ? costPerMeter(tco, m.current_reading) : null;

  const pdf = await Pdf.create(`Vehicle sale pack — ${m.name}`);
  pdf.header("Identity, service history, costs & compliance");

  pdf.heading("Identity");
  pdf.kv("Type", titleCase(m.type));
  pdf.kv("Make / model / year", `${dash(m.make)} ${m.model ?? ""} ${m.year ? `(${m.year})` : ""}`.trim());
  pdf.kv("Serial / VIN", dash(m.serial_no));
  pdf.kv("Registration", dash(m.reg_no));
  pdf.kv("Status", titleCase(m.status));
  pdf.kv("Current meter", m.current_reading != null ? `${m.current_reading} ${m.meter_type} (${dash(m.current_reading_date)})` : "—");
  pdf.kv("Purchased", `${dash(m.purchase_date)}${m.supplier ? ` · ${m.supplier}` : ""}`);
  pdf.kv("Purchase price (ex-VAT)", m.purchase_price_cents != null ? rands(m.purchase_price_cents) : "—");

  pdf.heading("Lifetime cost & TCO");
  pdf.kv("Total cost of ownership", rands(tco));
  pdf.kv(m.meter_type === "km" ? "Cost per km" : "Cost per hour", perMeter != null ? rands(perMeter) : "—");
  if (tco > 0) {
    pdf.table(
      ["Cost type", "Amount (ex-VAT)"],
      COST_TYPES.filter((ct) => breakdown[ct] > 0).map((ct) => [titleCase(ct), rands(breakdown[ct])]),
      [340, 159], [false, true],
    );
  }

  pdf.heading("Service & job-card history");
  if (jobCards.length === 0) pdf.text("No job cards.");
  else pdf.table(
    ["Date", "Type", "Status", "Total"],
    jobCards.map((j) => [j.date_out ?? j.created_at.slice(0, 10), titleCase(j.type), titleCase(j.status), rands(j.total_cents)]),
    [110, 160, 130, 99], [false, false, false, true],
  );

  pdf.heading("Compliance");
  pdf.kv("Warranty", `${dash(m.warranty_expiry_date)}${m.warranty_expiry_hours != null ? ` / ${m.warranty_expiry_hours}h` : ""} — ${statusWord(warrantyStatus(m))}`);
  if (licences.length > 0) {
    pdf.table(
      ["Document", "Number", "Expiry", "Status"],
      licences.map((l) => [titleCase(l.type), dash(l.number), l.expiry_date, statusWord(dateExpiryStatus(l.expiry_date, l.reminder_lead_days))]),
      [150, 149, 100, 100],
    );
  } else {
    pdf.text("No licences recorded.");
  }

  const bytes = await pdf.save();
  return pdfResponse(bytes, `sale-pack-${slug(m.name)}.pdf`);
}
