"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, SUPPORT_FARM_COOKIE } from "@/lib/auth";
import { isPlan, isBillingPeriod } from "@/lib/entitlements";
import { getBillingAdapter } from "@/lib/billing";
import { errorCode } from "@/lib/action-errors";
import { captureError } from "@/lib/observability";
import { isUuid } from "@/lib/ids";
import { supportRefusal } from "@/lib/support/refusals";

/**
 * Statuses an admin may SET here. Not "trial" (founder decision 9: no free trial at
 * launch) and not "active": access starts only after a payment is received (decision 3).
 *
 * HOOK(billing-payments): the payments work records a payment made outside the app (EFT,
 * invoice, payment link) and activates the farm from that record. Until it lands an admin
 * cannot switch a farm on from this dialog; the farm keeps whatever status it already has.
 */
const SETTABLE_STATUSES = ["suspended", "cancelled"];

export async function updateFarm(formData: FormData) {
  await requireRole(["rr_admin"]);

  const id = String(formData.get("id") ?? "");
  const plan = String(formData.get("plan") ?? "");
  const billingPeriod = String(formData.get("billing_period") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!isUuid(id)) redirect("/admin/farms?error=not-found");
  if (!isPlan(plan) || !isBillingPeriod(billingPeriod)) {
    redirect(`/admin/farms/${id}?error=admin-farm-invalid`);
  }

  const supabase = await createClient();
  const { data: current, error: currentError } = await supabase.from("farms").select("status").eq("id", id).maybeSingle();
  if (currentError) redirect(`/admin/farms/${id}?error=${errorCode(currentError, "app/admin/farms/[id]/actions:updateFarm:read")}`);
  if (!current) redirect("/admin/farms?error=not-found");
  const currentStatus = (current as { status: string }).status;
  // The status the farm already has is always allowed back (nothing changes); a new one
  // only when it is a switch OFF. Switching on comes from a recorded payment (see above).
  if (status !== currentStatus && !SETTABLE_STATUSES.includes(status)) {
    redirect(`/admin/farms/${id}?error=admin-farm-activate-by-payment`);
  }

  // Sets plan/billing_period/status only, asset_count is trigger-maintained (0251),
  // never client-set.
  const { error } = await supabase
    .from("farms")
    .update({ plan, billing_period: billingPeriod, status })
    .eq("id", id);
  if (error) redirect(`/admin/farms/${id}?error=${errorCode(error, "app/admin/farms/[id]/actions:updateFarm")}`);

  // Payment seam: reconcile the subscription with the billing provider. The no-op
  // adapter returns { deferred: true } and moves no money.
  const { data: after, error: afterError } = await supabase.from("farms").select("asset_count").eq("id", id).maybeSingle();
  // Unread is not zero vehicles. Saving again is safe: the update above repeats as is.
  if (afterError) redirect(`/admin/farms/${id}?error=${errorCode(afterError, "app/admin/farms/[id]/actions:updateFarm:asset-count")}`);
  await getBillingAdapter().syncSubscription({
    farmId: id,
    plan,
    billingPeriod,
    assetCount: (after as { asset_count: number } | null)?.asset_count ?? 0,
  });

  revalidatePath(`/admin/farms/${id}`);
  redirect(`/admin/farms/${id}?saved=1`);
}

/** Support mode lasts an hour; a longer stay is a new visit with its own reason. */
const SUPPORT_MODE_SECONDS = 60 * 60;

/**
 * Enter support mode for a farm (Scope §4.9), with a reason.
 *
 * Founder defaults (2026-10-28): a reason (a support case, or a sentence) is required to
 * go in; staff may change things while inside, and every change is attributed to the
 * named admin by the audit trigger; the owner sees the visit, its reason and how long it
 * lasted in Settings ("Rapid Rise support visits"). No per-visit consent prompt.
 *
 * `support_visit_start` (20261028100700) records the visit and writes the existing
 * `impersonate` access row with place and device, with the admin's own session so
 * `auth.uid()` names who went in. The cookie then narrows the UI to that one customer.
 *
 * This is a NARROWING, not a grant: rr_admin already reads every farm through
 * `app.is_rr_admin()` in RLS. The cookie only scopes what the UI asks for.
 */
export async function impersonateFarm(formData: FormData) {
  await requireRole(["rr_admin"]);
  const id = String(formData.get("id") ?? "");
  if (!isUuid(id)) redirect("/admin/farms?error=not-found");
  const reason = String(formData.get("reason") ?? "").trim();
  const rawTicket = String(formData.get("ticket_id") ?? "");
  const ticket = isUuid(rawTicket) ? rawTicket : null;
  const back = ticket ? `/admin/support/${ticket}` : `/admin/farms/${id}`;
  if (!reason && !ticket) redirect(`${back}?error=support-visit-reason`);
  if (reason.length > 300) redirect(`${back}?error=support-visit-reason`);

  const supabase = await createClient();
  const { error } = await supabase.rpc("support_visit_start", {
    p_farm: id,
    p_reason: reason || null,
    p_ticket: ticket,
  });
  if (error) {
    const refusal = supportRefusal(error);
    redirect(`${back}?error=${refusal ?? errorCode(error, "app/admin/farms/[id]/actions:impersonateFarm")}`);
  }

  (await cookies()).set(SUPPORT_FARM_COOKIE, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SUPPORT_MODE_SECONDS,
  });

  revalidatePath("/", "layout");
  redirect("/dashboard");
}

/**
 * Leave support mode: end the visit (which writes the paired `exit` access row) and clear
 * the farm context, so the owner's list and the log show how long the visit lasted.
 */
export async function exitSupportMode() {
  await requireRole(["rr_admin"]);
  const store = await cookies();
  const raw = store.get(SUPPORT_FARM_COOKIE)?.value;
  const id = raw && isUuid(raw) ? raw : null;

  if (id) {
    const supabase = await createClient();
    // Best-effort: the exit must clear the cookie even if the write fails, or an admin
    // could be stuck in a farm by a transient error. Reported, because the visit now
    // shows no end.
    const { error } = await supabase.rpc("support_visit_end", { p_farm: id });
    if (error) captureError(error, { where: "admin-farm:exit-support:visit-end" });
  }

  store.set(SUPPORT_FARM_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  revalidatePath("/", "layout");
  redirect(id ? `/admin/farms/${id}?exited=1` : "/admin");
}
