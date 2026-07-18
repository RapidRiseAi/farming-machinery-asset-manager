"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";

const TIERS = ["starter", "standard", "large"];
const STATUSES = ["trial", "active", "suspended", "cancelled"];

export async function updateFarm(formData: FormData) {
  await requireRole(["rr_admin"]);

  const id = String(formData.get("id") ?? "");
  const tier = String(formData.get("tier") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !TIERS.includes(tier) || !STATUSES.includes(status)) {
    redirect(`/admin/farms/${id}?error=Invalid+values`);
  }

  const supabase = await createClient();
  const { error } = await supabase.from("farms").update({ tier, status }).eq("id", id);
  if (error) redirect(`/admin/farms/${id}?error=${encodeURIComponent(error.message)}`);

  revalidatePath(`/admin/farms/${id}`);
  redirect(`/admin/farms/${id}?saved=1`);
}
