"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireProfile } from "@/lib/auth";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";

/**
 * Move an asset between the full and the support-equipment profile (20261114090300). The
 * database recomputes the preview under the subscription lock, refuses when the renewal
 * total the person accepted no longer applies (`preview-changed`), when capacity has to be
 * bought first (`capacity-needed`), or when a blocker stands; who may convert and whether the
 * business is paid up are its questions too. Identity and history stay with the asset.
 */
export async function convertAssetProfile(formData: FormData) {
  await requireProfile();
  const id = String(formData.get("id") ?? "");
  const to = String(formData.get("to") ?? "");
  if (!isUuid(id)) redirect("/machines?error=not-found");
  if (to !== "full" && to !== "equipment") redirect(`/machines/${id}?error=forbidden`);
  const accepted = String(formData.get("accepted_renewal_cents") ?? "").trim();
  const acceptedCents = /^\d{1,12}$/.test(accepted) ? Number(accepted) : null;

  const supabase = await createClient();
  const { error } = await supabase.rpc("convert_asset_profile", {
    p_machine: id,
    p_to: to,
    p_accepted_renewal_cents: acceptedCents,
  });
  if (error) redirect(`/machines/${id}?error=${errorCode(error, "machines:convert-profile")}`);
  revalidatePath("/machines");
  revalidatePath(`/machines/${id}`);
  redirect(`/machines/${id}?saved=profile`);
}

/** Ask Rapid Rise to look at how an asset is classified. Never bills or converts anything. */
export async function requestClassificationReview(formData: FormData) {
  await requireProfile();
  const id = String(formData.get("id") ?? "");
  if (!isUuid(id)) redirect("/machines?error=not-found");
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 500);
  const supabase = await createClient();
  const { error } = await supabase.rpc("request_asset_classification_review", { p_machine: id, p_reason: reason });
  if (error) redirect(`/machines/${id}?error=${errorCode(error, "machines:classification-review")}`);
  revalidatePath(`/machines/${id}`);
  redirect(`/machines/${id}?saved=review`);
}
