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
    fuel_anomaly_pct: intOr(formData, "fuel_anomaly_pct", 50),
    fuel_anomaly_min_history: intOr(formData, "fuel_anomaly_min_history", 3),
    warranty_lead_days: intOr(formData, "warranty_lead_days", 30),
    warranty_hours_lead: intOr(formData, "warranty_hours_lead", 50),
    licence_lead_days: intOr(formData, "licence_lead_days", 30),
    aarto_nomination_lead_days: intOr(formData, "aarto_nomination_lead_days", 14),
    repair_replace_pct: intOr(formData, "repair_replace_pct", 60),
    utilisation_hours_per_day: intOr(formData, "utilisation_hours_per_day", 10),
    utilisation_km_per_day: intOr(formData, "utilisation_km_per_day", 200),
    default_language: String(formData.get("default_language") ?? "af") === "en" ? "en" : "af",
  };

  const supabase = await createClient();
  // The farm's billing identity lives in real columns, not the settings blob — it goes on
  // a tax invoice, and a jsonb key is the wrong home for something a partner's PDF reads.
  // `farms_upd` is rr_admin only by design (the row carries the plan), so the owner writes
  // these through a narrow SECURITY DEFINER RPC (0410) that can touch nothing else.
  const billingError = (
    await supabase.rpc("update_farm_billing", {
      p_farm: profile.farm_id,
      p_trading: String(formData.get("trading_name") ?? ""),
      p_reg: String(formData.get("reg_number") ?? ""),
      p_vat: String(formData.get("vat_number") ?? ""),
      p_address: String(formData.get("billing_address") ?? ""),
      p_email: String(formData.get("billing_email") ?? ""),
    })
  ).error;
  if (billingError) redirect(`/settings?error=${encodeURIComponent(billingError.message)}`);

  const { error } = await supabase.rpc("update_farm_settings", { p_farm: profile.farm_id, p_settings: settings });
  if (error) redirect(`/settings?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/settings");
  redirect("/settings?saved=1");
}
