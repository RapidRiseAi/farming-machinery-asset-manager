"use server";

import { redirect } from "next/navigation";

import { effectiveFarmRole, requireProfile } from "@/lib/auth";
import { sendClosureDone } from "@/lib/email/closure";
import {
  CLOSURE_TOKEN,
  hashClosureToken,
  removeFiles,
  sameBusinessName,
  type StoredFile,
} from "@/lib/farm-closure";
import { captureError } from "@/lib/observability";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

function bounce(token: string, code: string): never {
  redirect(`/close-account/${token}?error=${code}`);
}

/**
 * The last step, and the only one that deletes. Every check is made again here, because a
 * server action is an endpoint: the signed-in owner who asked, a live link, and the business's
 * name typed by hand. The database does the deleting in one transaction, so it either happens
 * or it does not; only files and logins come after, and those are finished by the nightly job.
 */
export async function confirmClosure(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!CLOSURE_TOKEN.test(token)) redirect("/login");

  const profile = await requireProfile();
  const svc = createServiceClient();

  const { data: closure, error: readError } = await svc
    .from("farm_closure_requests")
    .select("id, farm_id, requested_by, expires_at")
    .eq("token_hash", hashClosureToken(token))
    .maybeSingle();
  if (readError) bounce(token, "closure-failed");
  if (!closure || new Date(closure.expires_at as string) <= new Date()) bounce(token, "closure-link-dead");

  const farmId = closure.farm_id as string;
  if (closure.requested_by !== profile.id || (await effectiveFarmRole(farmId, profile)) !== "owner") {
    bounce(token, "closure-owner-only");
  }

  const { data: farm, error: farmError } = await svc.from("farms").select("name").eq("id", farmId).maybeSingle();
  if (farmError || !farm) bounce(token, "closure-failed");
  const businessName = farm.name as string;
  if (!sameBusinessName(String(formData.get("name") ?? ""), businessName)) bounce(token, "closure-name");

  const { data, error } = await svc.rpc("close_farm_permanently", { p_farm: farmId, p_by: profile.id });
  if (error) {
    captureError(error, { where: "closure:close" });
    bounce(token, "closure-failed");
  }
  const result = data as { closure: string; logins: string[]; files: StoredFile[] };

  // It has happened. Nothing below may send them back to a page for an account that is gone.
  const left = await removeFiles(svc, result.files);
  const { error: saveError } = await svc.from("farm_closures").update({ pending_files: left }).eq("id", result.closure);
  if (saveError) captureError(saveError, { where: "closure:pending-files" });

  const email = profile.email;
  await (await createClient()).auth.signOut().catch(() => undefined);
  for (const id of result.logins) {
    const { error: deleteError } = await svc.auth.admin.deleteUser(id);
    if (deleteError) captureError(deleteError, { where: "closure:login" });
  }

  if (email) {
    const mail = await sendClosureDone({ email, businessName, locale: profile.language });
    if (!mail.ok) captureError(new Error(`closure: done email not sent (${mail.reason})`), { where: "closure:done-mail" });
  }
  redirect("/account-closed");
}
