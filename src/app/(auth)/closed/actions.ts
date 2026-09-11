"use server";

import { redirect } from "next/navigation";

import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { farmBillingGate, reopenFarmSubscription } from "@/lib/billing/service";

/**
 * Reopening a farm that lapsed.
 *
 * This is `/activate`'s sibling and follows the same rules for the same reasons: the guard
 * is re-checked in the action rather than inferred from what the page rendered, and the
 * write goes through the service client because `authenticated` holds SELECT and nothing
 * else on every `billing_*` table.
 *
 * What it does NOT do is take money. It puts the subscription back to PENDING with an
 * invoice against it — the exact state a fresh sign-up is in — and then sends them to
 * `/activate`, which is the payment path that has actually been driven end to end on
 * production. Writing a second payment route for this case would double the number of
 * things that have to stay correct, for no gain.
 */
function bounce(code: string): never {
  redirect(`/closed?error=${encodeURIComponent(code)}`);
}

export async function reopenFarm(): Promise<void> {
  const profile = await requireProfile();
  if (!profile.farm_id) redirect("/home");

  // Only somebody who can commit the farm to a subscription may restart one. An operator
  // on a closed farm sees this screen — they are gated to it like everyone else — and must
  // not be able to put their employer back on a paid plan. `/activate` draws exactly this
  // line for exactly this reason.
  if (profile.role !== "owner" && profile.role !== "manager") {
    bounce("forbidden");
  }

  // Re-checked here and not merely on the page: a server action is an endpoint, and the
  // page's own check only decides what was rendered.
  const rls = await createClient();
  if ((await farmBillingGate(rls, profile.farm_id)) !== "closed") redirect("/home");

  const service = createServiceClient();
  const done = await reopenFarmSubscription(service, profile.farm_id, profile.id);
  if (!done.ok) bounce("billing-save-failed");

  // The gate now answers 'pending', so /activate is reachable and carries the invoice.
  redirect("/activate");
}
