"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";

const TIERS = ["starter", "standard", "large"] as const;

export async function createFarm(formData: FormData) {
  await requireRole(["rr_admin"]);

  const name = String(formData.get("name") ?? "").trim();
  const tierInput = String(formData.get("tier") ?? "starter");
  const tier = (TIERS as readonly string[]).includes(tierInput) ? tierInput : "starter";

  if (!name) redirect("/admin/farms?error=Name+is+required");

  const supabase = await createClient();
  // RLS: farms_ins allows this only for rr_admin (with_check is_rr_admin()).
  const { error } = await supabase.from("farms").insert({ name, tier, status: "trial" });
  if (error) redirect(`/admin/farms?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/admin/farms");
  redirect("/admin/farms?created=1");
}
