"use server";

import { redirect } from "next/navigation";

import { requireProfile } from "@/lib/auth";
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
export async function beginCheckoutAction(): Promise<void> {
  const profile = await requireProfile();
  if (!profile.farm_id) redirect("/home");

  // Only somebody who can commit the farm to a subscription may start the payment. An
  // operator on a pending farm sees this page (they are gated to it like everyone else)
  // and must not be able to put their employer on a paid plan.
  if (profile.role !== "owner" && profile.role !== "manager") {
    redirect("/activate?error=forbidden");
  }

  // Re-checked here and not merely on the page. A server action is an endpoint: the page's
  // own check decides what is rendered, this decides what may happen.
  const rls = await createClient();
  const gate = await farmBillingGate(rls, profile.farm_id);
  if (gate !== "pending") redirect("/home");

  const supabase = createServiceClient();
  const email = await billingContactEmail(supabase, profile.farm_id, profile.email);
  const started = await beginCheckout(supabase, {
    farmId: profile.farm_id,
    email,
    userId: profile.id,
  });
  if (!started.ok) redirect(`/activate?error=${started.code}`);
  redirect(started.url);
}
