"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { isWorkshopPlan } from "@/lib/contractor-plan";

/**
 * Setting a partner's product (F14e). RR admin only, both here and in the database: the
 * `workshops_guard_plan` trigger (0380/0382) rejects a plan change from anyone else, so
 * a partner cannot promote themselves even if they reach the row another way.
 *
 * PAYMENTS ARE DEFERRED — this records which product a partner is on. It charges nobody.
 */
export async function setPartnerPlan(formData: FormData) {
  await requireRole(["rr_admin"]);

  const id = String(formData.get("workshop_id") ?? "");
  const plan = String(formData.get("plan") ?? "");
  if (!id || !isWorkshopPlan(plan)) redirect("/admin/partners?error=bad-plan");

  const supabase = await createClient();
  const { error } = await supabase.from("workshops").update({ plan }).eq("id", id);
  if (error) redirect(`/admin/partners?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/admin/partners");
  redirect("/admin/partners?saved=1");
}
