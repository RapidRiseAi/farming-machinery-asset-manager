"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  requireCurrentFarmRole,
  requireEntitlement,
} from "@/lib/auth";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { FUEL_ACTIVITIES } from "@/lib/fuel";
import { FleetCommandError, recordFuelIssue } from "@/lib/domain/fleet-commands";

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
  const { farmId } = await requireCurrentFarmRole(
    ["owner", "manager"],
    "/fuel?error=forbidden",
  );
  await requireEntitlement("fuel", "/fuel"); // plan gate (Professional+), not just hidden UI
  const name = String(formData.get("name") ?? "").trim();
  const capRaw = String(formData.get("capacity_l") ?? "").trim();
  const capacity = capRaw === "" ? null : Number(capRaw);
  if (!name) bounce("Enter a tank name");

  const supabase = await createClient();
  const { error } = await supabase.from("fuel_tanks").insert({
    farm_id: farmId,
    name,
    capacity_l: capacity != null && Number.isFinite(capacity) && capacity > 0 ? capacity : null,
  });
  if (error) bounce(error.message);
  revalidatePath("/fuel");
  redirect("/fuel?saved=tank");
}

/** Log a delivery / fill into a tank (owner/manager). Cost is entered VAT-inclusive and
 *  stored ex-VAT (Scope §6) as a per-litre unit price. Deliveries are tank stock, they do
 *  NOT book a cost_entry (per-issue attribution model, migration 0241). */
export async function addFuelDelivery(formData: FormData) {
  const { profile, farmId } = await requireCurrentFarmRole(
    ["owner", "manager"],
    "/fuel?error=forbidden",
  );
  await requireEntitlement("fuel", "/fuel"); // plan gate (Professional+)
  const tankId = String(formData.get("tank_id") ?? "").trim();
  const dateRaw = String(formData.get("date") ?? "").trim();
  const litres = Number(String(formData.get("litres") ?? "").trim());
  const supplier = String(formData.get("supplier") ?? "").trim() || null;
  const invoiceNo = String(formData.get("invoice_no") ?? "").trim() || null;
  const inclCents = parseRandsToCents(String(formData.get("cost") ?? ""));
  if (!tankId || !Number.isFinite(litres) || litres <= 0) bounce("Enter a tank and litres");

  const supabase = await createClient();
  const { data: tank } = await supabase
    .from("fuel_tanks")
    .select("id")
    .eq("id", tankId)
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!tank) bounce("Pick a tank");
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
  const { profile, farmId } = await requireCurrentFarmRole(
    ["owner", "manager", "mechanic", "operator"],
    "/fuel?error=forbidden",
  );
  await requireEntitlement("fuel", "/fuel"); // plan gate (Professional+)
  // Return to the originating machine page when asked, else the fuel page.
  const rawBack = String(formData.get("redirect_to") ?? "");
  const back = rawBack.startsWith("/machines/") ? rawBack : "/fuel";
  const fail = (msg: string): never => redirect(`${back}?error=${encodeURIComponent(msg)}`);
  const tankId = String(formData.get("tank_id") ?? "").trim();
  const machineRaw = String(formData.get("machine_id") ?? "").trim();
  const dateRaw = String(formData.get("date") ?? "").trim();
  const litres = Number(String(formData.get("litres") ?? "").trim());
  const meterRaw = String(formData.get("meter_reading") ?? "").trim();
  const meter = meterRaw === "" ? null : Number(meterRaw);
  const activityRaw = String(formData.get("activity") ?? "").trim();
  const activity = (FUEL_ACTIVITIES as readonly string[]).includes(activityRaw) ? activityRaw : null;
  const inclCents = parseRandsToCents(String(formData.get("cost") ?? ""));
  if (!tankId || !Number.isFinite(litres) || litres <= 0) fail("Enter a tank and litres");
  if (meter != null && (!Number.isFinite(meter) || meter < 0)) fail("Enter a valid meter reading");

  const supabase = await createClient();
  const { data: tank } = await supabase
    .from("fuel_tanks")
    .select("id")
    .eq("id", tankId)
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!tank) fail("Pick a tank");

  // Validate the machine belongs to this farm (or allow farm-level: no machine).
  let machineId: string | null = null;
  if (machineRaw) {
    const { data: m } = await supabase
      .from("machines").select("id").eq("id", machineRaw).eq("farm_id", farmId).is("deleted_at", null).maybeSingle();
    if (!m) fail("Pick a machine");
    machineId = machineRaw;
  }

  // Resolve the driver: an explicitly-chosen active farm user, else the person capturing.
  const driverRaw = String(formData.get("driver_user_id") ?? "").trim() || null;
  let driverId = profile.id;
  if (driverRaw) {
    const { data: isMember, error: memberError } = await supabase.rpc(
      "is_active_farm_member",
      { p_farm: farmId, p_user: driverRaw },
    );
    if (memberError || isMember !== true) fail("not-found");
    driverId = driverRaw;
  }

  const date = dateRaw || new Date().toISOString().slice(0, 10);

  // ONE transaction. This used to be two inserts, the draw, then the driver-usage log
  // whose result was never read, so a failure on the second left the litres and the cost
  // recorded and the driver's utilisation history quietly missing (the 11 September 2026
  // audit listed it). `record_fuel_issue` writes both or neither, re-checks the role and
  // the plan in the database, and converts the VAT-inclusive cost with the farm's own rate.
  try {
    await recordFuelIssue(supabase, {
      farmId,
      tankId,
      machineId,
      date,
      litres,
      meterReading: meter,
      costInclCents: inclCents,
      activity,
      driverUserId: driverId,
    });
  } catch (e) {
    fail(e instanceof FleetCommandError ? e.message : "Could not save that fuel draw");
  }

  revalidatePath("/fuel");
  if (machineId) revalidatePath(`/machines/${machineId}`);
  redirect(`${back}?saved=draw`);
}

/**
 * Record what the tank actually holds (SCOPE §9).
 *
 * The book balance is only ever as good as the captures behind it: diesel that leaves
 * without a draw being logged appears nowhere until somebody puts a stick in the tank.
 * This records the measurement and nothing else, no correcting entry, no adjustment. A
 * variance is a question for a person, and an adjustment would quietly answer it.
 */
export async function addFuelDip(formData: FormData) {
  const { profile, farmId } = await requireCurrentFarmRole(
    ["owner", "manager", "mechanic", "operator"],
    "/fuel?error=forbidden",
  );
  await requireEntitlement("fuel", "/fuel");
  const tankId = String(formData.get("tank_id") ?? "").trim();
  const litres = Number(String(formData.get("litres") ?? "").trim());
  const dippedOn = String(formData.get("dipped_on") ?? "").trim() || new Date().toISOString().slice(0, 10);
  const note = String(formData.get("note") ?? "").trim() || null;
  if (!tankId || !Number.isFinite(litres) || litres < 0) redirect("/fuel?error=invalid-values");

  const supabase = await createClient();
  const { error } = await supabase.from("fuel_dips").insert({
    farm_id: farmId,
    tank_id: tankId,
    dipped_on: dippedOn,
    litres,
    note,
    by_user: profile.id,
  });
  if (error) redirect("/fuel?error=save-failed");

  revalidatePath("/fuel");
  redirect("/fuel?saved=dip");
}
