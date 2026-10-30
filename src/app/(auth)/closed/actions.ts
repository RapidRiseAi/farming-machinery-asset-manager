"use server";

import { redirect } from "next/navigation";

import { effectiveFarmRole, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { farmBillingGate, reopenFarmSubscription } from "@/lib/billing/service";
import { isUuid } from "@/lib/ids";

/**
 * Reopening a farm that lapsed.
 *
 * This is `/activate`'s sibling and follows the same rules for the same reasons: the guard
 * is re-checked in the action rather than inferred from what the page rendered, and the
 * write goes through the service client because `authenticated` holds SELECT and nothing
 * else on every `billing_*` table.
 *
 * What it does NOT do is take money. It puts the subscription back to PENDING with an
 * invoice against it, the exact state a fresh sign-up is in, and then sends them to
 * `/activate`, which is the payment path that has actually been driven end to end on
 * production. Writing a second payment route for this case would double the number of
 * things that have to stay correct, for no gain.
 */
/** Back to the closed page with the reason, and with the farm when it is not the home one. */
function bounce(code: string, which = ""): never {
  redirect(`/closed?error=${encodeURIComponent(code)}${which ? `&${which}` : ""}`);
}

export async function reopenFarm(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  const asked = String(formData.get("farm") ?? "");
  const farmId = isUuid(asked) ? asked : profile.farm_id;
  if (!farmId) redirect("/home");
  const which = farmId !== profile.farm_id ? `farm=${farmId}` : "";

  // Only somebody who can commit the farm to a subscription may restart one. An operator
  // on a closed farm sees this screen, they are gated to it like everyone else, and must
  // not be able to put their employer back on a paid plan. `/activate` draws exactly this
  // line for exactly this reason.
  const farmRole = await effectiveFarmRole(farmId, profile);
  if (farmRole !== "owner" && farmRole !== "manager") {
    bounce("forbidden", which);
  }

  // Re-checked here and not merely on the page: a server action is an endpoint, and the
  // page's own check only decides what was rendered.
  const rls = await createClient();
  if ((await farmBillingGate(rls, farmId)) !== "closed") redirect("/home");

  const service = createServiceClient();
  const done = await reopenFarmSubscription(service, farmId, profile.id);
  if (!done.ok) bounce("billing-save-failed", which);

  // The gate now answers 'pending', so /activate is reachable and carries the invoice.
  redirect(`/activate${which ? `?${which}` : ""}`);
}
