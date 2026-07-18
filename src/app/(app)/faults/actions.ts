"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";

const URGENCIES = ["can_work", "limping", "stopped"];

export async function createFault(formData: FormData) {
  const profile = await requireRole(["owner", "manager", "mechanic", "operator"]);
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  const urgencyRaw = String(formData.get("urgency") ?? "can_work");
  const urgency = URGENCIES.includes(urgencyRaw) ? urgencyRaw : "can_work";
  const category = String(formData.get("category") ?? "").trim() || null;
  if (!machineId || !farmId || !description) redirect("/faults?error=Pick+a+machine+and+describe+the+problem");

  const supabase = await createClient();
  const { error } = await supabase.from("faults").insert({
    farm_id: farmId,
    machine_id: machineId,
    reported_by: profile.id,
    description,
    urgency,
    category,
    status: "open",
  });
  if (error) redirect(`/faults?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/faults");
  redirect("/faults?saved=1");
}

export async function resolveFault(formData: FormData) {
  await requireRole(["owner", "manager", "mechanic"]);
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  await supabase
    .from("faults")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/faults");
  redirect("/faults?saved=1");
}
