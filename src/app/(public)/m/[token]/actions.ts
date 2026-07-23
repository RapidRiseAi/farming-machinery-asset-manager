"use server";

import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/service";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { FUEL_ACTIVITIES } from "@/lib/fuel";

const URGENCIES = ["can_work", "limping", "stopped"];

async function machineFromToken(token: string) {
  const svc = createServiceClient();
  const { data } = await svc
    .from("machines")
    .select("id, farm_id")
    .eq("public_token", token)
    .is("deleted_at", null)
    .maybeSingle();
  return { svc, machine: data as { id: string; farm_id: string } | null };
}

/** Anonymous meter reading via QR — service role, gated by a valid token. */
export async function submitReading(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const reading = Number(String(formData.get("reading") ?? "").trim());
  const reporter = String(formData.get("name") ?? "").trim() || null;
  if (!token || !Number.isFinite(reading) || reading < 0) redirect(`/m/${token}?error=1`);

  const { svc, machine } = await machineFromToken(token);
  if (!machine) redirect(`/m/${token}?error=1`);

  const today = new Date().toISOString().slice(0, 10);
  await svc.from("meter_readings").insert({
    farm_id: machine.farm_id,
    machine_id: machine.id,
    reading,
    reading_date: today,
    source: "qr",
  });
  await svc
    .from("machines")
    .update({ current_reading: reading, current_reading_date: today })
    .eq("id", machine.id);
  // Record who operated the machine (AARTO driver-usage log, FR-13.1). Anonymous QR
  // capture has no user id, so the free-text name is the driver record.
  await svc.from("usage_logs").insert({
    farm_id: machine.farm_id,
    machine_id: machine.id,
    driver_name: reporter,
    occurred_on: today,
    meter_reading: reading,
    source: "qr",
  });

  redirect(`/m/${token}?sent=1`);
}

/** Anonymous "log service" via QR (FR-9.2) — service role, gated by a valid token.
 *  Records a completed scheduled-service job card in the machine's history with an
 *  optional meter reading (which advances the current reading + recalcs the schedule)
 *  and a driver-usage log. Never touches the DB from the browser (zero anon DB). */
export async function submitService(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  const readingRaw = String(formData.get("reading") ?? "").trim();
  const reading = readingRaw === "" ? null : Number(readingRaw);
  const driver = String(formData.get("name") ?? "").trim() || null;
  if (!token || (!note && readingRaw === "")) redirect(`/m/${token}?error=1`);
  if (reading != null && (!Number.isFinite(reading) || reading < 0)) redirect(`/m/${token}?error=1`);

  const { svc, machine } = await machineFromToken(token);
  if (!machine) redirect(`/m/${token}?error=1`);

  const today = new Date().toISOString().slice(0, 10);

  // Completed service job card — appears on the machine's history timeline.
  await svc.from("job_cards").insert({
    farm_id: machine.farm_id,
    machine_id: machine.id,
    type: "scheduled_service",
    status: "completed",
    date_in: today,
    date_out: today,
    reported_problem: "Field service (QR)",
    work_performed: note || null,
    meter_reading: reading,
  });

  if (reading != null) {
    // A reading advances the current reading + recalcs due status via its trigger.
    await svc.from("meter_readings").insert({
      farm_id: machine.farm_id,
      machine_id: machine.id,
      reading,
      reading_date: today,
      source: "qr",
    });
    await svc
      .from("machines")
      .update({ current_reading: reading, current_reading_date: today })
      .eq("id", machine.id);
  }

  // Driver-usage log for the service visit (FR-13.1).
  await svc.from("usage_logs").insert({
    farm_id: machine.farm_id,
    machine_id: machine.id,
    driver_name: driver,
    occurred_on: today,
    meter_reading: reading,
    source: "qr",
    note: note || "Field service (QR)",
  });

  redirect(`/m/${token}?sent=service`);
}

/** Anonymous "log fuel" via QR (FR-6.1 / FR-9.2) — service role, gated by a valid token.
 *  Records a per-machine fuel draw (litres, optional cost/meter/activity/driver) and a
 *  driver-usage log. Cost is entered VAT-inclusive and stored ex-VAT (Scope §6). If the
 *  farm has no tank yet, a default tank is created server-side so field capture never
 *  fails. Never touches the DB from the browser (zero anon DB). */
export async function submitFuel(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const litres = Number(String(formData.get("litres") ?? "").trim());
  const meterRaw = String(formData.get("reading") ?? "").trim();
  const meter = meterRaw === "" ? null : Number(meterRaw);
  const driver = String(formData.get("name") ?? "").trim() || null;
  const activityRaw = String(formData.get("activity") ?? "").trim();
  const activity = (FUEL_ACTIVITIES as readonly string[]).includes(activityRaw) ? activityRaw : null;
  const inclCents = parseRandsToCents(String(formData.get("cost") ?? ""));
  if (!token || !Number.isFinite(litres) || litres <= 0) redirect(`/m/${token}?error=1`);
  if (meter != null && (!Number.isFinite(meter) || meter < 0)) redirect(`/m/${token}?error=1`);

  const { svc, machine } = await machineFromToken(token);
  if (!machine) redirect(`/m/${token}?error=1`);

  // Ex-VAT conversion using the farm's VAT rate (default 15%).
  const { data: farm } = await svc.from("farms").select("settings").eq("id", machine.farm_id).maybeSingle();
  const rate = (() => {
    const v = (farm as { settings?: Record<string, unknown> } | null)?.settings?.["vat_rate_bps"];
    return typeof v === "number" && v >= 0 ? v : 1500;
  })();
  const exCents = inclCents != null ? exVatCents(inclCents, rate) : null;

  // Resolve a tank for this farm, creating a default one if none exists yet.
  const { data: tank } = await svc
    .from("fuel_tanks").select("id").eq("farm_id", machine.farm_id).is("deleted_at", null).order("created_at").limit(1).maybeSingle();
  let tankId = (tank as { id: string } | null)?.id ?? null;
  if (!tankId) {
    const { data: created } = await svc
      .from("fuel_tanks").insert({ farm_id: machine.farm_id, name: "Default tank" }).select("id").single();
    tankId = (created as { id: string } | null)?.id ?? null;
  }
  if (!tankId) redirect(`/m/${token}?error=1`);

  const today = new Date().toISOString().slice(0, 10);
  await svc.from("fuel_issues").insert({
    farm_id: machine.farm_id,
    tank_id: tankId,
    machine_id: machine.id,
    date: today,
    litres,
    meter_reading: meter,
    cost_cents: exCents,
    price_per_l_cents: exCents != null && litres > 0 ? Math.round(exCents / litres) : null,
    vat_rate_bps: exCents != null ? rate : null,
    activity,
    driver_name: driver,
  });

  // Driver-usage log for the draw (FR-13.1). Anonymous QR has no user id → free-text name.
  await svc.from("usage_logs").insert({
    farm_id: machine.farm_id,
    machine_id: machine.id,
    driver_name: driver,
    occurred_on: today,
    meter_reading: meter,
    source: "qr",
    note: activity ? `Fuel draw (${activity})` : "Fuel draw (QR)",
  });

  redirect(`/m/${token}?sent=fuel`);
}

/** Anonymous fault report via QR — service role, gated by a valid token. */
export async function submitFault(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  const urgencyRaw = String(formData.get("urgency") ?? "can_work");
  const urgency = URGENCIES.includes(urgencyRaw) ? urgencyRaw : "can_work";
  const reporter = String(formData.get("name") ?? "").trim() || null;
  if (!token || !description) redirect(`/m/${token}?error=1`);

  const { svc, machine } = await machineFromToken(token);
  if (!machine) redirect(`/m/${token}?error=1`);

  await svc.from("faults").insert({
    farm_id: machine.farm_id,
    machine_id: machine.id,
    description,
    urgency,
    reporter_name: reporter,
    status: "open",
  });

  redirect(`/m/${token}?sent=1`);
}
