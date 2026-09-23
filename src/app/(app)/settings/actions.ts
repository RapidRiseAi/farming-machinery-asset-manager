"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { formOwnsBilling, mergeSettings } from "@/lib/settings";

/**
 * Save the farm's settings.
 *
 * == Why it reads before it writes ============================================
 * `update_farm_settings` takes the WHOLE blob, so this has to send every key on every
 * save. It used to build that blob out of the submitted form alone, which was correct
 * while one form posted all eighteen keys together and became data loss the moment the
 * screen started editing one group at a time.
 *
 * So the stored blob is loaded and the form is merged over it. A form says which keys
 * it owns (`__fields`) and nothing else is read from it. The merge itself is pure and
 * tested in `src/lib/settings.test.ts`, including the case that motivated it: saving
 * quiet hours must not reset the farm's VAT rate.
 */
export async function updateSettings(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  if (!profile.farm_id) redirect("/settings?error=No+farm");

  const supabase = await createClient();

  const { data: farm } = await supabase
    .from("farms")
    .select("settings")
    .eq("id", profile.farm_id)
    .maybeSingle();

  const settings = mergeSettings(
    (farm as { settings: Record<string, unknown> | null } | null)?.settings ?? null,
    formData,
  );

  // The farm's billing identity lives in real columns, not the settings blob, it goes on
  // a tax invoice, and a jsonb key is the wrong home for something a partner's PDF reads.
  // `farms_upd` is rr_admin only by design (the row carries the plan), so the owner writes
  // these through a narrow SECURITY DEFINER RPC (0410) that can touch nothing else.
  //
  // Only called by a form that OWNS these fields: the RPC overwrites all five columns
  // from whatever it is handed, so calling it from the quiet-hours dialog would blank
  // the farm's VAT number and, with it, its ability to claim input VAT back.
  if (formOwnsBilling(formData)) {
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
  }

  const { error } = await supabase.rpc("update_farm_settings", { p_farm: profile.farm_id, p_settings: settings });
  if (error) redirect(`/settings?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/settings");
  redirect("/settings?saved=1");
}
