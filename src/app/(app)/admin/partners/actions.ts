"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireRole } from "@/lib/auth";
import { isWorkshopPlan } from "@/lib/contractor-plan";
import { errorCode } from "@/lib/action-errors";
import { mintSignIn, sendPartnerApproved } from "@/lib/email/partner-access";
import { isLocale } from "@/lib/locale";
import { captureError } from "@/lib/observability";

/**
 * Setting a partner's product (F14e). RR admin only, both here and in the database: the
 * `workshops_guard_plan` trigger (0380/0382) rejects a plan change from anyone else, so
 * a partner cannot promote themselves even if they reach the row another way.
 *
 * PAYMENTS ARE DEFERRED, this records which product a partner is on. It charges nobody.
 */
export async function setPartnerPlan(formData: FormData) {
  await requireRole(["rr_admin"]);

  const id = String(formData.get("workshop_id") ?? "");
  const plan = String(formData.get("plan") ?? "");
  if (!id || !isWorkshopPlan(plan)) redirect("/admin/partners?error=bad-plan");

  const supabase = await createClient();
  const { error } = await supabase.from("workshops").update({ plan }).eq("id", id);
  if (error) redirect(`/admin/partners?error=${errorCode(error, "app/admin/partners/actions:setPartnerPlan")}`);

  revalidatePath("/admin/partners");
  redirect("/admin/partners?saved=1");
}

// == Partner requests (20261106100000) ========================================
//
// A business asked through /become-a-partner. Nothing exists for them until approval here:
// the talk about terms, pricing and any agreement happens outside the product, and these
// actions keep the notes and record the outcome.

const REVIEW_STATUSES = ["new", "talking", "declined"];

/** Notes and where the conversation stands. Approving is its own step, below. */
export async function reviewApplication(formData: FormData) {
  const profile = await requireRole(["rr_admin"]);
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const notes = String(formData.get("review_notes") ?? "").trim().slice(0, 4000);
  if (!id || !REVIEW_STATUSES.includes(status)) redirect("/admin/partners?error=application-missing");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("partner_applications")
    .update({
      status,
      review_notes: notes || null,
      reviewed_by: profile.id,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .neq("status", "approved")
    .select("id")
    .maybeSingle();
  if (error) redirect(`/admin/partners?error=${errorCode(error, "app/admin/partners/actions:reviewApplication")}`);
  if (!data) redirect("/admin/partners?error=application-missing");

  revalidatePath("/admin/partners");
  redirect("/admin/partners?saved=1");
}

/**
 * Approve a request: their account, on the product agreed with them.
 *
 * Safe to run again after a failure: identity comes first, and every step finds what an
 * earlier run made. An address that is already a farmer's or staff login is refused, because
 * this email is about to open that account as a partner.
 */
export async function approveApplication(formData: FormData) {
  const profile = await requireRole(["rr_admin"]);
  const id = String(formData.get("id") ?? "");
  const plan = String(formData.get("plan") ?? "");
  if (!id || !isWorkshopPlan(plan)) redirect("/admin/partners?error=bad-plan");

  const supabase = await createClient();
  const { data: application, error: readError } = await supabase
    .from("partner_applications")
    .select("id, business_name, kind, contact_name, email, phone, area, status, workshop_id, locale")
    .eq("id", id)
    .maybeSingle();
  if (readError) redirect(`/admin/partners?error=${errorCode(readError, "app/admin/partners/actions:approve:read")}`);
  if (!application || application.status === "approved") redirect("/admin/partners?error=application-missing");

  const email = String(application.email).toLowerCase();
  const name = application.contact_name as string;
  const svc = createServiceClient();

  const created = await svc.auth.admin.createUser({ email, email_confirm: true, user_metadata: { name } });
  const signIn = await mintSignIn(svc, email);
  const userId = created.data?.user?.id ?? signIn.userId;
  if (!userId || !signIn.tokenHash) redirect("/admin/partners?error=application-failed");

  const { data: existing, error: profileError } = await svc
    .from("users")
    .select("id, role, workshop_id")
    .eq("id", userId)
    .maybeSingle();
  if (profileError) redirect(`/admin/partners?error=${errorCode(profileError, "app/admin/partners/actions:approve:profile")}`);
  if (existing && existing.role !== "workshop") redirect("/admin/partners?error=application-email-taken");

  const details = {
    kind: application.kind,
    phone: application.phone,
    email,
    area: application.area,
    contact: application.phone,
  };
  let workshopId = (existing?.workshop_id as string | null | undefined) ?? (application.workshop_id as string | null);
  if (workshopId) {
    const { error } = await svc.from("workshops").update(details).eq("id", workshopId);
    if (error) redirect(`/admin/partners?error=${errorCode(error, "app/admin/partners/actions:approve:workshop-update")}`);
  } else {
    // Real by definition: a test workshop only ever comes from a test farm.
    const { data: workshop, error } = await svc
      .from("workshops")
      .insert({ is_test: false, name: application.business_name, ...details })
      .select("id")
      .single();
    if (error || !workshop) {
      redirect(`/admin/partners?error=${errorCode(error, "app/admin/partners/actions:approve:workshop", "application-failed")}`);
    }
    workshopId = workshop.id as string;
    // Kept at once, so a retry finds this workshop instead of making a second.
    const { error: stampError } = await supabase.from("partner_applications").update({ workshop_id: workshopId }).eq("id", id);
    if (stampError) captureError(stampError, { where: "admin-partners:approve:stamp" });
  }

  if (!existing) {
    const { error } = await svc.from("users").insert({
      id: userId,
      workshop_id: workshopId,
      role: "workshop",
      name,
      email,
      active: true,
    });
    if (error && error.code !== "23505") {
      redirect(`/admin/partners?error=${errorCode(error, "app/admin/partners/actions:approve:user")}`);
    }
  }

  // The admin's own client: `workshops_guard_plan` refuses a plan change from anyone else.
  const { error: planError } = await supabase.from("workshops").update({ plan }).eq("id", workshopId);
  if (planError) redirect(`/admin/partners?error=${errorCode(planError, "app/admin/partners/actions:approve:plan")}`);

  const now = new Date().toISOString();
  const { error: doneError } = await supabase
    .from("partner_applications")
    .update({ status: "approved", workshop_id: workshopId, reviewed_by: profile.id, reviewed_at: now, updated_at: now })
    .eq("id", id);
  if (doneError) redirect(`/admin/partners?error=${errorCode(doneError, "app/admin/partners/actions:approve:done")}`);

  const mail = await sendPartnerApproved({
    email,
    name,
    businessName: application.business_name as string,
    tokenHash: signIn.tokenHash,
    locale: isLocale(application.locale as string) ? (application.locale as "en" | "af") : "en",
  });
  // The account stands; they can ask for a link on the sign-in page. Say so rather than fail.
  if (!mail.ok) captureError(new Error(`partner approved email not sent (${mail.reason})`), { where: "admin-partners:approve:mail" });

  revalidatePath("/admin/partners");
  redirect(mail.ok ? "/admin/partners?approved=1" : "/admin/partners?approved=nomail");
}

/** Remove a decided request. It can name people, so it should not outlive its use. */
export async function deleteApplication(formData: FormData) {
  await requireRole(["rr_admin"]);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/admin/partners?error=application-missing");

  const supabase = await createClient();
  const { error } = await supabase.from("partner_applications").delete().eq("id", id);
  if (error) redirect(`/admin/partners?error=${errorCode(error, "app/admin/partners/actions:deleteApplication")}`);

  revalidatePath("/admin/partners");
  redirect("/admin/partners?removed=1");
}
