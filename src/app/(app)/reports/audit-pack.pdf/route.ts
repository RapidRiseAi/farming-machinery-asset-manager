import { getProfile, checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Pdf, pdfResponse } from "@/lib/pdf/doc";
import { warrantyStatus, dateExpiryStatus, type ExpiryStatus } from "@/lib/compliance";

export const dynamic = "force-dynamic";

/**
 * GLOBALG.A.P. / SIZA audit pack (FR-13.4): a one-document fleet-compliance summary an auditor
 * asks for — assets on hand, service compliance, licence/warranty status, outstanding faults.
 * Server-route only (never exposes the service role); RLS scopes to the user's accessible farm.
 * Advanced reports (Professional+) gate, matching the reports surface it is linked from.
 */

type Machine = {
  id: string; name: string; type: string; status: string; meter_type: string;
  current_reading: number | null; warranty_expiry_date: string | null; warranty_expiry_hours: number | null;
};
type SPL = { machine_id: string; status: string; task: string };
type Licence = { machine_id: string; type: string; number: string | null; expiry_date: string; reminder_lead_days: number };
type Fault = { machine_id: string; description: string | null; urgency: string | null; created_at: string };

const dash = (v: unknown) => (v == null || v === "" ? "—" : String(v));
const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const statusWord = (s: ExpiryStatus | null): string =>
  s === "expired" ? "EXPIRED" : s === "expiring" ? "Expiring soon" : s === "ok" ? "In date" : "—";

export async function GET() {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  if (!(await checkEntitlement("advanced_reports", profile)).allowed)
    return new Response("Upgrade required", { status: 403 });

  const supabase = await createClient();
  const farmId = await currentFarmId(profile);

  let machinesQ = supabase.from("machines").select("id, name, type, status, meter_type, current_reading, warranty_expiry_date, warranty_expiry_hours").is("deleted_at", null).order("name");
  let splQ = supabase.from("service_plan_lines").select("machine_id, status, task").is("deleted_at", null);
  let licQ = supabase.from("licences").select("machine_id, type, number, expiry_date, reminder_lead_days").is("deleted_at", null);
  let faultQ = supabase.from("faults").select("machine_id, description, urgency, created_at").neq("status", "resolved").is("deleted_at", null).order("created_at", { ascending: false });
  if (farmId) {
    machinesQ = machinesQ.eq("farm_id", farmId);
    splQ = splQ.eq("farm_id", farmId);
    licQ = licQ.eq("farm_id", farmId);
    faultQ = faultQ.eq("farm_id", farmId);
  }

  const [farmRes, machinesRes, splRes, licRes, faultRes] = await Promise.all([
    supabase.from("farms").select("name").eq("id", farmId ?? profile.farm_id ?? "").maybeSingle(),
    machinesQ,
    splQ,
    licQ,
    faultQ,
  ]);

  const farmName = (farmRes.data as { name: string } | null)?.name ?? "";
  const machines = (machinesRes.data as Machine[] | null) ?? [];
  const spl = (splRes.data as SPL[] | null) ?? [];
  const licences = (licRes.data as Licence[] | null) ?? [];
  const faults = (faultRes.data as Fault[] | null) ?? [];

  // Retired/sold excluded from every fleet-compliance count (Scope §4.1 / C8).
  const active = machines.filter((m) => m.status !== "retired" && m.status !== "sold");
  const activeIds = new Set(active.map((m) => m.id));
  const nameById = new Map(machines.map((m) => [m.id, m.name]));

  const pdf = await Pdf.create(`Fleet compliance pack${farmName ? ` — ${farmName}` : ""}`);
  pdf.header("GLOBALG.A.P. / SIZA audit summary");

  // ── Assets on hand ─────────────────────────────────────────────
  pdf.heading("Assets on hand");
  pdf.kv("Active assets", String(active.length));
  const byType = new Map<string, number>();
  for (const m of active) byType.set(m.type, (byType.get(m.type) ?? 0) + 1);
  const byStatus = new Map<string, number>();
  for (const m of active) byStatus.set(m.status, (byStatus.get(m.status) ?? 0) + 1);
  pdf.kv("By type", [...byType.entries()].map(([k, v]) => `${titleCase(k)}: ${v}`).join(", ") || "—");
  pdf.kv("By status", [...byStatus.entries()].map(([k, v]) => `${titleCase(k)}: ${v}`).join(", ") || "—");

  // ── Service compliance ─────────────────────────────────────────
  const svc = { ok: 0, due_soon: 0, overdue: 0 } as Record<string, number>;
  const overdueList: { name: string; task: string }[] = [];
  for (const l of spl) {
    if (!activeIds.has(l.machine_id)) continue;
    if (l.status in svc) svc[l.status]++;
    if (l.status === "overdue") overdueList.push({ name: nameById.get(l.machine_id) ?? "—", task: l.task });
  }
  pdf.heading("Service compliance");
  pdf.kv("In date / Due soon / Overdue", `${svc.ok} / ${svc.due_soon} / ${svc.overdue}`);
  if (overdueList.length > 0) {
    pdf.table(
      ["Asset", "Overdue task"],
      overdueList.slice(0, 30).map((o) => [o.name, o.task]),
      [220, 279],
    );
  } else {
    pdf.text("No overdue services.");
  }

  // ── Licences & warranty ────────────────────────────────────────
  pdf.heading("Licences & warranty");
  type Row = { name: string; item: string; expiry: string; status: string; severity: number };
  const rows: Row[] = [];
  for (const m of active) {
    const ws = warrantyStatus(m);
    if (ws) {
      rows.push({
        name: m.name, item: "Warranty",
        expiry: dash(m.warranty_expiry_date) + (m.warranty_expiry_hours != null ? ` / ${m.warranty_expiry_hours}h` : ""),
        status: statusWord(ws), severity: ws === "expired" ? 0 : ws === "expiring" ? 1 : 2,
      });
    }
  }
  for (const l of licences) {
    if (!activeIds.has(l.machine_id)) continue;
    const s = dateExpiryStatus(l.expiry_date, l.reminder_lead_days);
    rows.push({
      name: nameById.get(l.machine_id) ?? "—", item: titleCase(l.type) + (l.number ? ` (${l.number})` : ""),
      expiry: l.expiry_date, status: statusWord(s), severity: s === "expired" ? 0 : s === "expiring" ? 1 : 2,
    });
  }
  rows.sort((a, b) => a.severity - b.severity || a.name.localeCompare(b.name));
  if (rows.length > 0) {
    pdf.table(
      ["Asset", "Document", "Expiry", "Status"],
      rows.map((r) => [r.name, r.item, r.expiry, r.status]),
      [150, 175, 100, 74],
    );
  } else {
    pdf.text("No licences or warranties recorded.");
  }

  // ── Outstanding faults ─────────────────────────────────────────
  pdf.heading("Outstanding faults");
  const openFaults = faults.filter((f) => activeIds.has(f.machine_id));
  if (openFaults.length > 0) {
    pdf.table(
      ["Date", "Asset", "Problem", "Urgency"],
      openFaults.slice(0, 40).map((f) => [f.created_at.slice(0, 10), nameById.get(f.machine_id) ?? "—", f.description ?? "—", dash(f.urgency)]),
      [80, 130, 210, 79],
    );
  } else {
    pdf.text("No outstanding faults.");
  }

  const bytes = await pdf.save();
  return pdfResponse(bytes, "fleet-compliance-pack.pdf");
}
