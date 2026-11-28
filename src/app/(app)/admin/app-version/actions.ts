"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireRole } from "@/lib/auth";
import { compareAppVersions, isHttpsUrl, parseAppVersion } from "@/lib/native/app-version";
import { createServiceClient } from "@/lib/supabase/service";

const BACK = "/admin/app-version";

/**
 * Sets which Android app phones are asked, or made, to update to (20261128100000). Rapid Rise
 * only: `requireRole(["rr_admin"])` here, and the database checks the person again
 * (`app.service_rr_actor`) and refuses anything that is not two versions and an https link.
 */
export async function setAppVersions(formData: FormData) {
  const admin = await requireRole(["rr_admin"]);
  const latest = String(formData.get("latest") ?? "").trim();
  const minimum = String(formData.get("minimum") ?? "").trim();
  const url = String(formData.get("url") ?? "").trim();
  const l = parseAppVersion(latest);
  const m = parseAppVersion(minimum);
  if (!l || !m || compareAppVersions(m, l) > 0 || !isHttpsUrl(url)) redirect(`${BACK}?error=app-version-invalid`);
  const { error } = await createServiceClient().rpc("native_app_release_set", {
    p_by: admin.id, p_platform: "android", p_latest: latest, p_minimum: minimum, p_url: url,
  });
  if (error) redirect(`${BACK}?error=${errorCode(error, "admin:app-version", "app-version-invalid")}`);
  revalidatePath(BACK);
  redirect(`${BACK}?saved=1`);
}
