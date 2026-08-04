"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, SUPPORT_FARM_COOKIE } from "@/lib/auth";
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
 * Enter support mode for a farm (Scope §4.9 — impersonate for support, logged).
 *
 * This used to write an audit row and nothing else — no farm context, no session state —
 * while the button read "Act into farm", so staff believed they were inside a customer
 * account when they were not, and there was no banner or exit because there was no mode
 * to exit.
 *
 * What it does now: writes the `impersonate` audit row exactly as before, AND pins the
 * farm in a cookie so every farm-scoped surface narrows to that one customer, with a
 * banner naming them and a way out. Leaving writes a matching `exit` row, so the log
 * shows how long an admin was in a farm rather than only that they looked.
 *
 * This is a NARROWING, not a grant: rr_admin already reads every farm through
 * `app.is_rr_admin()` in RLS. The cookie only scopes what the UI asks for, so it cannot
 * widen access — see `supportFarmId` in lib/auth.ts.
 */
export async function impersonateFarm(formData: FormData) {
  await requireRole(["rr_admin"]);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/admin/farms?error=Missing+farm");
  const supabase = await createClient();

  // Only ever pin a farm that exists — a forged cookie is harmless but a real id keeps
  // the banner and the audit trail honest.
  const { data: farm } = await supabase.from("farms").select("id").eq("id", id).maybeSingle();
  if (!farm) redirect("/admin/farms?error=Farm+not+found");

  const { error } = await supabase.rpc("log_admin_farm_access", { p_farm: id, p_action: "impersonate" });
  if (error) redirect(`/admin/farms/${id}?error=${encodeURIComponent(error.message)}`);

  (await cookies()).set(SUPPORT_FARM_COOKIE, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 4,
  });

  revalidatePath("/", "layout");
  redirect("/dashboard");
}

/**
 * Leave support mode: clear the farm context and write the paired `exit` audit row, so
 * the log shows duration rather than a bare list of entries.
 */
export async function exitSupportMode() {
  await requireRole(["rr_admin"]);
  const store = await cookies();
  const id = store.get(SUPPORT_FARM_COOKIE)?.value;

  if (id) {
    const supabase = await createClient();
    // Best-effort: the exit must clear the cookie even if the log write fails, or an
    // admin could be stuck in a farm by a transient error.
    await supabase.rpc("log_admin_farm_access", { p_farm: id, p_action: "exit" });
  }

  store.set(SUPPORT_FARM_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  revalidatePath("/", "layout");
  redirect(id ? `/admin/farms/${id}?exited=1` : "/admin/farms");
}
