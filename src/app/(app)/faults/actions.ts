"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { effectiveFarmRole, requireFarmRole, requireProfile, type Role } from "@/lib/auth";
import { recordFault } from "@/lib/domain/fleet-commands";
import { errorCode } from "@/lib/action-errors";

const URGENCIES = ["can_work", "limping", "stopped"];

async function faultContext(id: string, roles: readonly Role[]) {
  const profile = await requireProfile();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("faults")
    .select("farm_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  // A failed read is not a missing fault.
  if (error) redirect(`/faults?error=${errorCode(error, "faults:context")}`);
  const farmId = (data as { farm_id: string } | null)?.farm_id;
  if (!farmId) redirect("/faults?error=not-found");
  const auth = await requireFarmRole(farmId, roles, "/faults?error=forbidden", profile);
  return { ...auth, supabase };
}

async function updateFaultStatus(
  id: string,
  status: string,
  roles: readonly Role[],
  extra: Record<string, unknown> = {},
) {
  const { farmId, supabase } = await faultContext(id, roles);
  const { data, error } = await supabase
    .from("faults")
    .update({ status, ...extra })
    .eq("id", id)
    .eq("farm_id", farmId)
    .select("id")
    .maybeSingle();
  if (error || !data) redirect("/faults?error=save-failed");
}

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
    // Never the database's words in the URL: a refusal our SQL raises keeps its own, and
    // anything else is reported and said as "try again".
    redirect(`/faults?error=${errorCode(error as Error, "faults:create")}`);
  }
  revalidatePath("/faults");
  redirect("/faults?saved=1");
}

export async function resolveFault(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/faults?error=missing-id");
  await updateFaultStatus(id, "resolved", ["owner", "manager", "mechanic"], {
    resolved_at: new Date().toISOString(),
  });
  revalidatePath("/faults");
  revalidatePath("/driver");
  // A specific outcome word, so the page says what changed rather than "Saved.".
  redirect("/faults?saved=resolved");
}

// == Fault lifecycle transitions (FR-7.3): Open → Acknowledged → In progress ==
const LIFECYCLE_ROLES = ["owner", "manager", "mechanic", "workshop"] as const;

/** Move a fault to `acknowledged` (someone has seen it). */
export async function acknowledgeFault(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/faults?error=missing-id");
  await updateFaultStatus(id, "acknowledged", LIFECYCLE_ROLES);
  revalidatePath("/faults");
  redirect("/faults?saved=acknowledged");
}

/** Move a fault to `in_progress` (work started). */
export async function startFault(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/faults?error=missing-id");
  await updateFaultStatus(id, "in_progress", LIFECYCLE_ROLES);
  revalidatePath("/faults");
  redirect("/faults?saved=started");
}

/** Assign (or clear) the fault's owner. A blank/unknown id clears the assignee;
 *  a cross-farm id is rejected, only an active user of the fault's farm is accepted. */
export async function assignFault(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/faults?error=missing-id");
  const raw = String(formData.get("assigned_to") ?? "").trim();
  const { farmId, supabase } = await faultContext(id, ["owner", "manager", "mechanic"]);

  let assigned_to: string | null = null;
  if (raw) {
    const { data: isMember, error: memberError } = await supabase.rpc(
      "is_active_farm_member",
      { p_farm: farmId, p_user: raw },
    );
    // A failed check is not "that person is not on the farm".
    if (memberError) redirect(`/faults?error=${errorCode(memberError, "faults:assign:member")}`);
    if (isMember !== true) redirect("/faults?error=not-found");
    assigned_to = raw;
  }
  const { data, error } = await supabase
    .from("faults")
    .update({ assigned_to })
    .eq("id", id)
    .eq("farm_id", farmId)
    .select("id")
    .maybeSingle();
  if (error || !data) redirect("/faults?error=save-failed");
  revalidatePath("/faults");
  redirect("/faults?saved=assigned");
}
