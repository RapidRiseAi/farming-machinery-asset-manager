"use server";

import { redirect } from "next/navigation";

import { effectiveFarmRole, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { beginCheckout, billingContactEmail, farmBillingGate } from "@/lib/billing/service";
import { isUuid } from "@/lib/ids";

/**
 * Pay what is overdue, from the suspended screen (20261029090100).
 *
 * The same hosted checkout `/activate` uses (`beginCheckout`, proven in production): it
 * pays the oldest open invoice, and the settlement runs app.billing_restore_after_payment,
 * which brings the farm back once nothing overdue is left, with a fresh period from today.
 * No second payment route to drift from the first.
 */
export async function payOverdueAction(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  const asked = String(formData.get("farm") ?? "");
  const farmId = isUuid(asked) ? asked : profile.farm_id;
  if (!farmId) redirect("/home");

  // Only somebody who may commit the farm to paying, on THIS farm (a multi-site member may
  // be an owner on one and an operator on another).
  const role = await effectiveFarmRole(farmId, profile);
  if (role !== "owner" && role !== "manager") redirect("/suspended?error=forbidden");

  // An endpoint re-checks what the page showed.
  const gate = await farmBillingGate(await createClient(), farmId);
  if (gate !== "suspended") redirect("/home");

  const supabase = createServiceClient();
  const email = await billingContactEmail(supabase, farmId, profile.email);
  const started = await beginCheckout(supabase, { farmId, email, userId: profile.id });
  if (!started.ok) redirect(`/suspended?error=${started.code}${farmId !== profile.farm_id ? `&farm=${farmId}` : ""}`);
  redirect(started.url);
}
