"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireFarmRole, requireProfile } from "@/lib/auth";
import { MACHINE_STATUSES } from "@/lib/machine-options";

/**
 * Change only a machine's status (standby, in the workshop, sold, retired...).
 *
 * `updateMachine` validates and rewrites every column from the full edit form, so a
 * status-only dialog cannot post to it without wiping the rest of the record. This is
 * the small action for the header's "Change status", modelled on
 * `returnMachineToService`: owner/manager on the machine's own farm, and RLS scopes the
 * update as well. The `machines` audit trigger records the change.
 */
export async function setMachineStatus(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id) redirect("/machines?error=not-found");
  const back = `/machines/${id}`;
  if (!(MACHINE_STATUSES as readonly string[]).includes(status)) redirect(`${back}?error=forbidden`);

  const profile = await requireProfile();
  const supabase = await createClient();
  const { data } = await supabase
    .from("machines")
    .select("farm_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const farmId = (data as { farm_id: string } | null)?.farm_id ?? null;
  if (!farmId) redirect("/machines?error=not-found");
  await requireFarmRole(farmId, ["owner", "manager"], `${back}?error=forbidden`, profile);

  const { error } = await supabase
    .from("machines")
    .update({ status })
    .eq("id", id)
    .eq("farm_id", farmId);
  if (error) redirect(`${back}?error=${encodeURIComponent(error.message)}`);

  revalidatePath(back);
  revalidatePath("/machines");
  redirect(`${back}?saved=status`);
}
