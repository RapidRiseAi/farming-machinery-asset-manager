"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { FUEL_ACTIVITIES } from "@/lib/fuel";

function bounce(msg: string): never {
  redirect(`/fuel?error=${encodeURIComponent(msg)}`);
}

/** Farm VAT rate (bps) from settings, default 15%. */
async function vatBps(supabase: Awaited<ReturnType<typeof createClient>>, farmId: string): Promise<number> {
  const { data } = await supabase.from("farms").select("settings").eq("id", farmId).maybeSingle();
  const s = (data as { settings: Record<string, unknown> } | null)?.settings ?? {};
  const v = s["vat_rate_bps"];
  return typeof v === "number" && v >= 0 ? v : 1500;
}

/** Add a storage tank (owner/manager). */
export async function addFuelTank(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  if (!profile.farm_id) bounce("No farm");
  const name = String(formData.get("name") ?? "").trim();
  const capRaw = String(formData.get("capacity_l") ?? "").trim();
  const capacity = capRaw === "" ? null : Number(capRaw);
  if (!name) bounce("Enter a tank name");

  const supabase = await createClient();
  const { error } = await supabase.from("fuel_tanks").insert({
    farm_id: profile.farm_id,
    name,
    capacity_l: capacity != null && Number.isFinite(capacity) && capacity > 0 ? capacity : null,
  });
  if (error) bounce(error.message);
  revalidatePath("/fuel");
  redirect("/fuel?saved=tank");
}

/** Log a delivery / fill into a tank (owner/manager). Cost is entered VAT-inclusive and
 *  stored ex-VAT (Scope §6) as a per-litre unit price. Deliveries are tank stock — they do
 *  NOT book a cost_entry (per-issue attribution model, migration 0241). */
export async function addFuelDelivery(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  if (!profile.farm_id) bounce("No farm");
  const farmId = profile.farm_id;
  const tankId = String(formData.get("tank_id") ?? "").trim();
  const dateRaw = String(formData.get("date") ?? "").trim();
  const litres = Number(String(formData.get("litres") ?? "").trim());
  const supplier = String(formData.get("supplier") ?? "").trim() || null;
  const invoiceNo = String(formData.get("invoice_no") ?? "").trim() || null;
  const inclCents = parseRandsToCents(String(formData.get("cost") ?? ""));
  if (!tankId || !Number.isFinite(litres) || litres <= 0) bounce("Enter a tank and litres");

  const supabase = await createClient();
  const rate = await vatBps(supabase, farmId);
  const exCents = inclCents != null ? exVatCents(inclCents, rate) : null;
  const pricePerL = exCents != null && litres > 0 ? Math.round(exCents / litres) : null;

  const { error } = await supabase.from("fuel_deliveries").insert({
    farm_id: farmId,
    tank_id: tankId,
    date: dateRaw || new Date().toISOString().slice(0, 10),
    litres,
    price_per_l_cents: pricePerL,
    vat_rate_bps: exCents != null ? rate : null,
    supplier,
    invoice_no: invoiceNo,
    by_user: profile.id,
  });
  if (error) bounce(error.message);
  revalidatePath("/fuel");
  redirect("/fuel?saved=delivery");
}

/** Log a per-machine draw (owner/manager/mechanic/operator). Cost is entered VAT-inclusive
 *  and stored ex-VAT; the issue is the authoritative per-machine fuel cost (→ cost_entries,
 *  migration 0241). Also writes a driver-usage log when a driver + meter are known (FR-13.1). */
export async function addFuelIssue(formData: FormData) {
  const profile = await requireRole(["owner", "manager", "mechanic", "operator"]);
  if (!profile.farm_id) bounce("No farm");
  const farmId = profile.farm_id;
  const tankId = String(formData.get("tank_id") ?? "").trim();
  const machineRaw = String(formData.get("machine_id") ?? "").trim();
  const dateRaw = String(formData.get("date") ?? "").trim();
  const litres = Number(String(formData.get("litres") ?? "").trim());
  const meterRaw = String(formData.get("meter_reading") ?? "").trim();
  const meter = meterRaw === "" ? null : Number(meterRaw);
  const activityRaw = String(formData.get("activity") ?? "").trim();
  const activity = (FUEL_ACTIVITIES as readonly string[]).includes(activityRaw) ? activityRaw : null;
  const inclCents = parseRandsToCents(String(formData.get("cost") ?? ""));
  if (!tankId || !Number.isFinite(litres) || litres <= 0) bounce("Enter a tank and litres");
  if (meter != null && (!Number.isFinite(meter) || meter < 0)) bounce("Enter a valid meter reading");

  const supabase = await createClient();

  // Validate the machine belongs to this farm (or allow farm-level: no machine).
  let machineId: string | null = null;
  if (machineRaw) {
    const { data: m } = await supabase
      .from("machines").select("id").eq("id", machineRaw).eq("farm_id", farmId).is("deleted_at", null).maybeSingle();
    if (m) machineId = machineRaw;
  }

  // Resolve the driver: an explicitly-chosen active farm user, else the person capturing.
  const driverRaw = String(formData.get("driver_user_id") ?? "").trim() || null;
  let driverId = profile.id;
  if (driverRaw) {
    const { data: drv } = await supabase
      .from("users").select("id").eq("id", driverRaw).eq("farm_id", farmId).eq("active", true).is("deleted_at", null).maybeSingle();
    if (drv) driverId = driverRaw;
  }

  const rate = await vatBps(supabase, farmId);
  const exCents = inclCents != null ? exVatCents(inclCents, rate) : null;
  const date = dateRaw || new Date().toISOString().slice(0, 10);

  const { error } = await supabase.from("fuel_issues").insert({
    farm_id: farmId,
    tank_id: tankId,
    machine_id: machineId,
    date,
    litres,
    meter_reading: meter,
    cost_cents: exCents,
    price_per_l_cents: exCents != null && litres > 0 ? Math.round(exCents / litres) : null,
    vat_rate_bps: exCents != null ? rate : null,
    activity,
    by_user: profile.id,
  });
  if (error) bounce(error.message);

  // Driver-usage log for a per-machine draw where the operator + meter are known (FR-13.1),
  // consistent with the reading/QR/job-card capture paths.
  if (machineId && meter != null) {
    await supabase.from("usage_logs").insert({
      farm_id: farmId,
      machine_id: machineId,
      driver_user_id: driverId,
      occurred_on: date,
      meter_reading: meter,
      source: "app",
      note: activity ? `Fuel draw (${activity})` : "Fuel draw",
    });
  }

  revalidatePath("/fuel");
  if (machineId) revalidatePath(`/machines/${machineId}`);
  redirect("/fuel?saved=draw");
}
