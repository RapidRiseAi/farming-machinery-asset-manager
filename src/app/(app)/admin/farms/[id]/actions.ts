"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { isPlan, isBillingPeriod } from "@/lib/entitlements";
import { getBillingAdapter } from "@/lib/billing";

const STATUSES = ["trial", "active", "suspended", "cancelled"];

export async function updateFarm(formData: FormData) {
  await requireRole(["rr_admin"]);

  const id = String(formData.get("id") ?? "");
  const plan = String(formData.get("plan") ?? "");
  const billingPeriod = String(formData.get("billing_period") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !isPlan(plan) || !isBillingPeriod(billingPeriod) || !STATUSES.includes(status)) {
    redirect(`/admin/farms/${id}?error=Invalid+values`);
  }

  const supabase = await createClient();
  // Sets plan/billing_period/status only — asset_count is trigger-maintained (0251),
  // never client-set. Pricing is display-only; no charge is made (payments deferred).
  const { error } = await supabase
    .from("farms")
    .update({ plan, billing_period: billingPeriod, status })
    .eq("id", id);
  if (error) redirect(`/admin/farms/${id}?error=${encodeURIComponent(error.message)}`);

  // Payment seam (deferred): reconcile the subscription with the billing provider. The
  // no-op adapter returns { deferred: true } and moves no money — this is the exact
  // lifecycle point where a real provider will plug in after research.
  const { data: after } = await supabase.from("farms").select("asset_count").eq("id", id).maybeSingle();
  await getBillingAdapter().syncSubscription({
    farmId: id,
    plan,
    billingPeriod,
    assetCount: (after as { asset_count: number } | null)?.asset_count ?? 0,
  });

  revalidatePath(`/admin/farms/${id}`);
  redirect(`/admin/farms/${id}?saved=1`);
}

/**
 * Record RR-admin "act into a farm" support access (Scope §4.9 — impersonate,
 * logged). Writes one append-only audit_log row via the guarded RPC every time.
 */
export async function impersonateFarm(formData: FormData) {
  await requireRole(["rr_admin"]);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/admin/farms?error=Missing+farm");
  const supabase = await createClient();
  const { error } = await supabase.rpc("log_admin_farm_access", { p_farm: id, p_action: "impersonate" });
  if (error) redirect(`/admin/farms/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/admin/farms/${id}`);
  redirect(`/admin/farms/${id}?entered=1`);
}
