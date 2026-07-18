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
  void reporter; // captured on faults; readings track by_user only for logged-in users

  redirect(`/m/${token}?sent=1`);
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
