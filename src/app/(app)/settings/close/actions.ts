"use server";

import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireRole } from "@/lib/auth";
import { sendClosureConfirmation } from "@/lib/email/closure";
import { siteUrl } from "@/lib/env";
import { CLOSURE_LINK_HOURS, exportIsFresh, newClosureToken } from "@/lib/farm-closure";
import { captureError } from "@/lib/observability";
import { createServiceClient } from "@/lib/supabase/service";

const HERE = "/settings/close";

/**
 * Ask for the confirmation email. Nothing is deleted here: this only proves the export was
 * taken and sends the one link that can finish the job, to the address on the owner's login.
 */
export async function requestClosure(formData: FormData) {
  const profile = await requireRole(["owner"]);
  const farmId = profile.farm_id;
  if (!farmId || !profile.email) redirect(`${HERE}?error=closure-owner-only`);
  if (String(formData.get("understood") ?? "") !== "on") redirect(`${HERE}?error=closure-understood`);

  const svc = createServiceClient();
  const { data: farm, error: farmError } = await svc
    .from("farms")
    .select("name, last_export_at")
    .eq("id", farmId)
    .maybeSingle();
  if (farmError) redirect(`${HERE}?error=${errorCode(farmError, "app/settings/close:farm")}`);
  if (!farm) redirect(`${HERE}?error=closure-failed`);
  if (!exportIsFresh(farm.last_export_at as string | null)) redirect(`${HERE}?error=closure-export-first`);

  const origin = siteUrl();
  if (!origin) redirect(`${HERE}?error=closure-failed`);

  // Only the newest email works: an older one in the inbox cannot be used by mistake.
  const { error: clearError } = await svc.from("farm_closure_requests").delete().eq("farm_id", farmId);
  if (clearError) redirect(`${HERE}?error=${errorCode(clearError, "app/settings/close:clear")}`);

  const { token, tokenHash } = newClosureToken();
  const { error: insertError } = await svc.from("farm_closure_requests").insert({
    farm_id: farmId,
    requested_by: profile.id,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + CLOSURE_LINK_HOURS * 60 * 60 * 1000).toISOString(),
  });
  if (insertError) redirect(`${HERE}?error=${errorCode(insertError, "app/settings/close:insert")}`);

  const mail = await sendClosureConfirmation({
    email: profile.email,
    businessName: farm.name as string,
    link: `${origin}/close-account/${token}`,
    farmId,
    locale: profile.language,
  });
  if (!mail.ok) {
    captureError(new Error(`closure: confirmation not sent (${mail.reason})`), { where: "closure:mail" });
    redirect(`${HERE}?error=closure-failed`);
  }
  redirect(`${HERE}?sent=1`);
}
