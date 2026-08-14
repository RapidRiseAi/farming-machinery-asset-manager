"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { effectiveFarmRole, requireProfile, requireRole } from "@/lib/auth";
import { recordFault } from "@/lib/domain/fleet-commands";

const URGENCIES = ["can_work", "limping", "stopped"];

export async function createFault(formData: FormData) {
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  const urgencyRaw = String(formData.get("urgency") ?? "can_work");
  const urgency = URGENCIES.includes(urgencyRaw) ? urgencyRaw : "can_work";
  const category = String(formData.get("category") ?? "").trim() || null;
  if (!machineId || !farmId || !description) redirect("/faults?error=Pick+a+machine+and+describe+the+problem");
  const profile = await requireProfile();
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !["rr_admin", "owner", "manager", "mechanic", "operator"].includes(role)) {
    redirect("/faults?error=You+cannot+report+a+fault+for+that+farm");
  }

  const supabase = await createClient();
  try {
    await recordFault(supabase, {
      farmId,
      machineId,
      description,
      urgency: urgency as "can_work" | "limping" | "stopped",
      category,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save the fault";
    redirect(`/faults?error=${encodeURIComponent(message)}`);
  }
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

// ── Fault lifecycle transitions (FR-7.3): Open → Acknowledged → In progress ──
const LIFECYCLE_ROLES = ["owner", "manager", "mechanic", "workshop"] as const;

/** Move a fault to `acknowledged` (someone has seen it). */
export async function acknowledgeFault(formData: FormData) {
  await requireRole([...LIFECYCLE_ROLES]);
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  await supabase.from("faults").update({ status: "acknowledged" }).eq("id", id);
  revalidatePath("/faults");
  redirect("/faults?saved=1");
}

/** Move a fault to `in_progress` (work started). */
export async function startFault(formData: FormData) {
  await requireRole([...LIFECYCLE_ROLES]);
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  await supabase.from("faults").update({ status: "in_progress" }).eq("id", id);
  revalidatePath("/faults");
  redirect("/faults?saved=1");
}

/** Assign (or clear) the fault's owner. A blank/unknown id clears the assignee;
 *  a cross-farm id is rejected — only an active user of the fault's farm is accepted. */
export async function assignFault(formData: FormData) {
  await requireRole(["owner", "manager", "mechanic"]);
  const id = String(formData.get("id") ?? "");
  const raw = String(formData.get("assigned_to") ?? "").trim();
  const supabase = await createClient();

  // The fault is RLS-scoped to the caller's farm(s).
  const { data: fault } = await supabase.from("faults").select("farm_id").eq("id", id).maybeSingle();
  const farmId = (fault as { farm_id: string } | null)?.farm_id;
  if (!farmId) redirect("/faults?error=Not+found");

  let assigned_to: string | null = null;
  if (raw) {
    const { data: u } = await supabase
      .from("users")
      .select("id")
      .eq("id", raw)
      .eq("farm_id", farmId)
      .eq("active", true)
      .is("deleted_at", null)
      .maybeSingle();
    if (u) assigned_to = raw;
  }
  await supabase.from("faults").update({ assigned_to }).eq("id", id);
  revalidatePath("/faults");
  redirect("/faults?saved=1");
}
