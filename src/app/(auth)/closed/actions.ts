"use server";

import { redirect } from "next/navigation";

import { effectiveFarmRole, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { beginCheckout, billingContactEmail, farmBillingGate, farmLifecycle, reopenFarmSubscription } from "@/lib/billing/service";
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

/**
 * An unpaid account whose 90 days of reading have passed (20261115120000): paying what it
 * owes opens it again, exactly as paying during the 90 days does (the restore after payment
 * starts a fresh period from the payment date, so the weeks it was stopped are not billed).
 * The checkout pays the oldest owed invoice; nothing new is raised.
 */
export async function payToReopen(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  const asked = String(formData.get("farm") ?? "");
  const farmId = isUuid(asked) ? asked : profile.farm_id;
  if (!farmId) redirect("/home");
  const which = farmId !== profile.farm_id ? `farm=${farmId}` : "";

  const farmRole = await effectiveFarmRole(farmId, profile);
  if (farmRole !== "owner" && farmRole !== "manager") bounce("forbidden", which);

  const rls = await createClient();
  if ((await farmBillingGate(rls, farmId)) !== "closed") redirect("/home");
  const life = await farmLifecycle(rls, farmId);
  if (life?.reason !== "unpaid") bounce("billing-nothing-due", which);

  const service = createServiceClient();
  const email = await billingContactEmail(service, farmId, profile.email);
  const started = await beginCheckout(service, { farmId, email, userId: profile.id });
  if (!started.ok) bounce(started.code, which);
  redirect(started.url);
}