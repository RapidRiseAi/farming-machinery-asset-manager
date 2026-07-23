"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { isPlan } from "@/lib/entitlements";

export async function createFarm(formData: FormData) {
  await requireRole(["rr_admin"]);

  const name = String(formData.get("name") ?? "").trim();
  const planInput = String(formData.get("plan") ?? "essential");
  const plan = isPlan(planInput) ? planInput : "essential";

  if (!name) redirect("/admin/farms?error=Name+is+required");

  const supabase = await createClient();
  // RLS: farms_ins allows this only for rr_admin (with_check is_rr_admin()).
  const { error } = await supabase.from("farms").insert({ name, plan, status: "trial" });
  if (error) redirect(`/admin/farms?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/admin/farms");
  redirect("/admin/farms?created=1");
}
