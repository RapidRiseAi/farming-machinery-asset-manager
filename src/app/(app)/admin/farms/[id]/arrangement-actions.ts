"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireRole } from "@/lib/auth";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { randsToCents } from "@/lib/trips";

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

/** Record an accepted Done-For-You quote: it becomes this customer's price from the next invoice. */
export async function recordDfyQuote(formData: FormData) {
  const profile = await requireRole(["rr_admin"]);
  const farmId = String(formData.get("farm_id") ?? "");
  if (!isUuid(farmId)) redirect("/admin/farms?error=admin-farm-invalid");
  const reference = String(formData.get("reference") ?? "").trim().slice(0, 100);
  const price = randsToCents(String(formData.get("per_vehicle") ?? ""));
  const minimum = Number.parseInt(String(formData.get("min_vehicles") ?? "0"), 10);
  const period = String(formData.get("billing_period") ?? "monthly") === "annual" ? "annual" : "monthly";
  const accepted = String(formData.get("accepted_on") ?? "");
  if (!reference || price == null || !Number.isInteger(minimum) || minimum < 0 || minimum > 1000 || !/^\d{4}-\d{2}-\d{2}$/.test(accepted)) {
    redirect(back(farmId, "error=dfy-bad"));
  }

  const { error } = await createServiceClient().rpc("billing_record_dfy_quote", {
    p_farm: farmId,
    p_reference: reference,
    p_per_vehicle_incl_cents: price,
    p_min_vehicles: minimum,
    p_period: period,
    p_accepted_on: accepted,
    p_notes: String(formData.get("notes") ?? "").slice(0, 2000),
    p_by: profile.id,
  });
  if (error) redirect(back(farmId, `error=${errorCode(error, "app/admin/farms/arrangements:dfy", "dfy-bad")}`));
  revalidatePath(`/admin/farms/${farmId}`);
  redirect(back(farmId, "saved=1"));
}
