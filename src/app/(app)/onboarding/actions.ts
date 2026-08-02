"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";

/**
 * Onboarding step 3 ("put a QR sticker on each machine") used to share step 1's
 * `machines > 0` condition, so adding one machine ticked both — farms were told the
 * stickers were up when nobody had printed them, and the whole no-login driver flow
 * never started (audit bug 1).
 *
 * The step now needs its own explicit acknowledgement. It rides on the existing
 * `farms.settings` jsonb via the existing owner/manager-guarded `update_farm_settings`
 * RPC (0204), which merges with `||` — no schema change, no new policy, and every
 * other settings key is left alone.
 */
export async function acknowledgeQrLabels(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  if (!profile.farm_id) redirect("/onboarding?error=No+farm");

  const undo = String(formData.get("undo") ?? "") === "1";
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_farm_settings", {
    p_farm: profile.farm_id,
    p_settings: { qr_labels_printed_at: undo ? null : new Date().toISOString() },
  });
  if (error) redirect(`/onboarding?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/onboarding");
  redirect(undo ? "/onboarding" : "/onboarding?saved=qr_labels");
}
