"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireRole } from "@/lib/auth";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

const back = (farmId: string, query: string) => `/admin/farms/${farmId}?${query}`;

/**
 * Bill this site through a main site, or on its own again. A site billed through another must
 * not have a running subscription of its own, or it would be billed twice.
 */
export async function setBilledThrough(formData: FormData) {
  await requireRole(["rr_admin"]);
  const farmId = String(formData.get("farm_id") ?? "");
  const parentRaw = String(formData.get("billed_through") ?? "");
  if (!isUuid(farmId)) redirect("/admin/farms?error=admin-farm-invalid");
  const parent = isUuid(parentRaw) ? parentRaw : null;

  const svc = createServiceClient();
  if (parent) {
    const [{ data: own, error: ownError }, { data: main, error: mainError }] = await Promise.all([
      svc.from("billing_subscriptions").select("id").eq("farm_id", farmId).is("deleted_at", null).neq("status", "cancelled").limit(1),
      svc.from("billing_subscriptions").select("id").eq("farm_id", parent).is("deleted_at", null).neq("status", "cancelled").limit(1),
    ]);
    if (ownError || mainError) redirect(back(farmId, "error=pooled-failed"));
    if ((own ?? []).length > 0) redirect(back(farmId, "error=pooled-own-subscription"));
    if ((main ?? []).length === 0) redirect(back(farmId, "error=pooled-main-unpaid"));
  }

  const supabase = await createClient();
  const { error } = await supabase.from("farms").update({ billed_through: parent }).eq("id", farmId);
  if (error) redirect(back(farmId, `error=${errorCode(error, "app/admin/farms/arrangements:pooled", "pooled-failed")}`));
  revalidatePath(`/admin/farms/${farmId}`);
  redirect(back(farmId, "saved=1"));
}
