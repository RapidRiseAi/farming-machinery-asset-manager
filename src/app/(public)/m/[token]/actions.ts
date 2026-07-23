"use server";

import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/service";

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
