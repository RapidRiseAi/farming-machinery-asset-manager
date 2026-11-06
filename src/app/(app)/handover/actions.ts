"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireProfile, requireUsableFarm } from "@/lib/auth";
import { deactivatePaymentMethod } from "@/lib/billing/service";
import { captureError } from "@/lib/observability";
import { createServiceClient } from "@/lib/supabase/service";

/** Only the person named can answer, which the database checks again. */
async function myOffer(id: string) {
  const profile = await requireProfile();
  const svc = createServiceClient();
  const { data, error } = await svc
    .from("farm_ownership_transfers")
    .select("id, farm_id, to_user, status")
    .eq("id", id)
    .maybeSingle();
  if (error) redirect(`/handover?error=${errorCode(error, "app/handover:read")}`);
  if (!data || data.to_user !== profile.id || data.status !== "pending") redirect("/handover?error=handover-ended");
  await requireUsableFarm(data.farm_id as string, profile);
  return { profile, svc, farmId: data.farm_id as string };
}

export async function acceptOwnership(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const { profile, svc, farmId } = await myOffer(id);

  const { error } = await svc.rpc("accept_ownership", { p_transfer: id, p_by: profile.id });
  if (error) redirect(`/handover?error=${errorCode(error, "app/handover:accept", "handover-ended")}`);

  // The next renewal must not charge somebody who no longer runs this business.
  const { data: cards, error: cardsError } = await svc
    .from("billing_payment_methods")
    .select("id")
    .eq("farm_id", farmId)
    .is("deleted_at", null);
  if (cardsError) captureError(cardsError, { where: "handover:cards" });
  for (const card of (cards ?? []) as { id: string }[]) {
    const { error: removeError } = await deactivatePaymentMethod(svc, { paymentMethodId: card.id, farmId });
    if (removeError) captureError(removeError, { where: "handover:card-remove", extra: { farmId } });
  }

  revalidatePath("/", "layout");
  redirect("/billing?handover=1");
}

export async function declineOwnership(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const { svc } = await myOffer(id);
  const { error } = await svc
    .from("farm_ownership_transfers")
    .update({ status: "declined", decided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending");
  if (error) redirect(`/handover?error=${errorCode(error, "app/handover:decline")}`);
  redirect("/home");
}
