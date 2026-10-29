"use server";

import { redirect } from "next/navigation";

import { effectiveFarmRole, requireProfile } from "@/lib/auth";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { beginCheckout, billingContactEmail, farmBillingGate } from "@/lib/billing/service";

/**
 * Send a farm that has signed up and not paid to the hosted checkout.
 *
 * This is `startCheckout` from `/billing`'s actions with a different guard, and the guard
 * is the whole difference: `requireBillingAdmin` refuses anybody whose farm is not already
 * running, which is every farm this page exists for.
 *
 * It deliberately does NOT re-implement the payment sequence. `beginCheckout` mints and
 * PERSISTS the attempt reference before contacting Paystack, which is what makes a lost
 * HTTP response recoverable rather than a mystery, and raises this period's invoice if one
 * is not already open. Both of those are proven in production and neither is worth a
 * second copy that can drift.
 */
export async function beginCheckoutAction(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  const asked = String(formData.get("farm") ?? "");
  const farmId = isUuid(asked) ? asked : profile.farm_id;
  if (!farmId) redirect("/home");
  const which = farmId !== profile.farm_id ? `&farm=${farmId}` : "";

  // Only somebody who can commit the farm to a subscription may start the payment. An
  // operator on a pending farm sees this page (they are gated to it like everyone else)
  // and must not be able to put their employer on a paid plan.
  const farmRole = await effectiveFarmRole(farmId, profile);
  if (farmRole !== "owner" && farmRole !== "manager") {
    redirect(`/activate?error=forbidden${which}`);
  }

  // Re-checked here and not merely on the page. A server action is an endpoint: the page's
  // own check decides what is rendered, this decides what may happen.
  const rls = await createClient();
  const gate = await farmBillingGate(rls, farmId);
  if (gate !== "pending") redirect("/home");

  const supabase = createServiceClient();
  const email = await billingContactEmail(supabase, farmId, profile.email);
  const started = await beginCheckout(supabase, {
    farmId: farmId,
    email,
    userId: profile.id,
  });
  if (!started.ok) redirect(`/activate?error=${started.code}${which}`);
  redirect(started.url);
}
