"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireRole } from "@/lib/auth";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";

const HERE = "/admin/equipment-reviews";

/** Rapid Rise answers a classification review. The database checks it is Rapid Rise. */
export async function decideEquipmentReview(formData: FormData) {
  await requireRole(["rr_admin"]);
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!isUuid(id) || (status !== "confirmed" && status !== "declined")) redirect(`${HERE}?error=equipment-review-bad`);
  const note = String(formData.get("note") ?? "").trim().slice(0, 500);
  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_asset_classification_review", { p_review: id, p_status: status, p_note: note });
  if (error) redirect(`${HERE}?error=${errorCode(error, "admin:equipment-review")}`);
  revalidatePath(HERE);
  redirect(`${HERE}?saved=1`);
}
