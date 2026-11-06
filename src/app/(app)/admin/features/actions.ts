"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const HERE = "/admin/features";

/** Everyone gets it, or nobody but the businesses in testing. Through the admin's own client. */
export async function setFeatureReleased(formData: FormData) {
  await requireRole(["rr_admin"]);
  const key = String(formData.get("key") ?? "");
  const released = String(formData.get("released") ?? "") === "true";
  const supabase = await createClient();
  const { error } = await supabase
    .from("feature_flags")
    .update({ released, updated_at: new Date().toISOString() })
    .eq("key", key);
  if (error) redirect(`${HERE}?error=${errorCode(error, "app/admin/features:release")}`);
  revalidatePath("/", "layout");
  redirect(`${HERE}?saved=1`);
}

export async function grantFeature(formData: FormData) {
  const profile = await requireRole(["rr_admin"]);
  const key = String(formData.get("key") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  if (!key || !farmId) redirect(`${HERE}?error=missing`);
  const supabase = await createClient();
  const { error } = await supabase
    .from("farm_feature_access")
    .upsert({ key, farm_id: farmId, granted_by: profile.id }, { onConflict: "farm_id,key", ignoreDuplicates: true });
  if (error) redirect(`${HERE}?error=${errorCode(error, "app/admin/features:grant")}`);
  revalidatePath("/", "layout");
  redirect(`${HERE}?saved=1`);
}

export async function revokeFeature(formData: FormData) {
  await requireRole(["rr_admin"]);
  const key = String(formData.get("key") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.from("farm_feature_access").delete().eq("key", key).eq("farm_id", farmId);
  if (error) redirect(`${HERE}?error=${errorCode(error, "app/admin/features:revoke")}`);
  revalidatePath("/", "layout");
  redirect(`${HERE}?saved=1`);
}
