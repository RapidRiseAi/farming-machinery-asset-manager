"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";

function intOr(fd: FormData, k: string, dflt: number): number {
  const n = Number(String(fd.get(k) ?? ""));
  return Number.isFinite(n) ? n : dflt;
}

export async function updateSettings(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  if (!profile.farm_id) redirect("/settings?error=No+farm");

  const settings = {
    due_soon_hours: intOr(formData, "due_soon_hours", 25),
    due_soon_days: intOr(formData, "due_soon_days", 14),
    stale_reading_days: intOr(formData, "stale_reading_days", 30),
    vat_rate_bps: intOr(formData, "vat_rate_bps", 1500),
    approval_required: formData.get("approval_required") === "on",
    cost_visible_to_operators: formData.get("cost_visible_to_operators") === "on",
    quiet_hours_start: intOr(formData, "quiet_hours_start", 20),
    quiet_hours_end: intOr(formData, "quiet_hours_end", 5),
    default_language: String(formData.get("default_language") ?? "af") === "en" ? "en" : "af",
  };

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_farm_settings", { p_farm: profile.farm_id, p_settings: settings });
  if (error) redirect(`/settings?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/settings");
  redirect("/settings?saved=1");
}
