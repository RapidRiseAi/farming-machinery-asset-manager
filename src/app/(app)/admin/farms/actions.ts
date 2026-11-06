"use server";

import { isCompanyType } from "@/lib/i18n";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { BILLING_PERIODS, PLAN_PRICING, isPlan } from "@/lib/entitlements";
import { errorCode } from "@/lib/action-errors";
import { createServiceClient } from "@/lib/supabase/service";
import { runOnce } from "@/lib/request-claim";
import { inviteToFarm } from "@/lib/admin-invite";

export async function createFarm(formData: FormData) {
  await requireRole(["rr_admin"]);

  const name = String(formData.get("name") ?? "").trim();
  const planInput = String(formData.get("plan") ?? "essential");
  const plan = isPlan(planInput) ? planInput : "essential";

  if (!name) redirect("/admin/farms?error=Name+is+required");

  const supabase = await createClient();
  // RLS: farms_ins allows this only for rr_admin (with_check is_rr_admin()).
  const { error } = await supabase.from("farms").insert({ name, plan, status: "trial" });
  if (error) redirect(`/admin/farms?error=${errorCode(error, "app/admin/farms/actions:createFarm")}`);

  revalidatePath("/admin/farms");
  redirect("/admin/farms?created=1");
}

/**
 * Set up a quoted customer (20261105100000): the farm, a PENDING subscription with the
 * agreed slots and its first invoice, and the owner's invitation, in one step.
 *
 * No trial, by the founder's decision: the owner signs in from the invitation, the gate
 * takes them to /activate, and they pay by card there or by EFT (the details shown on that
 * page), which Rapid Rise records on the billing console. The subscription is marked as
 * opened by staff, so the nightly sweep of abandoned sign-ups never deletes it.
 *
 * If the subscription cannot be opened the new, empty farm is removed again, so a retry
 * does not leave a duplicate behind. If only the invitation fails, the farm and its invoice
 * stand and the invitation is retried from the farm's page.
 */
export async function adminOnboardCustomer(formData: FormData) {
  return runOnce(
    formData,
    "admin:onboard",
    async () => {
      const admin = await requireRole(["rr_admin"]);
      const name = String(formData.get("name") ?? "").trim();
      const plan = String(formData.get("plan") ?? "");
      const period = String(formData.get("billing_period") ?? "monthly");
      const slots = Number.parseInt(String(formData.get("slots") ?? ""), 10);
      const ownerName = String(formData.get("owner_name") ?? "").trim();
      const ownerEmail = String(formData.get("owner_email") ?? "").trim().toLowerCase();
      const language = String(formData.get("language") ?? "en") === "af" ? "af" : "en";
      const typed = String(formData.get("company_type") ?? "");
      const companyType = isCompanyType(typed) ? typed : "other";

      if (!name) redirect("/admin/farms?error=Name+is+required");
      // Only a plan with a list price: Done-For-You is quoted and set up as an agreement.
      if (!isPlan(plan) || PLAN_PRICING[plan].perVehicleMonthlyCents == null) redirect("/admin/farms?error=billing-bad-plan");
      if (!(BILLING_PERIODS as readonly string[]).includes(period)) redirect("/admin/farms?error=billing-bad-period");
      if (!Number.isInteger(slots) || slots < 1 || slots > 1000) redirect("/admin/farms?error=billing-quota-invalid");
      if (!ownerName || !ownerEmail) redirect("/admin/farms?error=admin-invite-fields");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) redirect("/admin/farms?error=need-email");

      const supabase = await createClient();
      // RLS: farms_ins allows this only for rr_admin.
      const { data: farm, error: farmError } = await supabase
        .from("farms")
        .insert({ name, plan, billing_period: period, status: "active", billing_email: ownerEmail, company_type: companyType })
        .select("id")
        .single();
      if (farmError || !farm) redirect(`/admin/farms?error=${errorCode(farmError ?? {}, "app/admin/farms/actions:onboard-farm")}`);
      const farmId = (farm as { id: string }).id;

      const svc = createServiceClient();
      const { error: subError } = await svc.rpc("billing_admin_open_subscription", {
        p_farm: farmId, p_plan: plan, p_period: period, p_quota: slots, p_by: admin.id,
      });
      if (subError) {
        // Nothing else hangs off the farm yet: take it away so a retry starts clean.
        await svc.from("farms").delete().eq("id", farmId);
        redirect(`/admin/farms?error=${errorCode(subError, "app/admin/farms/actions:onboard-subscription", "billing-save-failed")}`);
      }

      const invited = await inviteToFarm(svc, {
        adminId: admin.id, farmId, email: ownerEmail, name: ownerName, role: "owner", language,
      });
      revalidatePath("/admin/farms");
      if (!invited.ok) return `/admin/farms/${farmId}?onboarded=invite-failed&error=${invited.code}`;
      return `/admin/farms/${farmId}?onboarded=${invited.emailSent ? "1" : "noemail"}`;
    },
    { whileRunning: "/admin/farms?error=still-saving" },
  );
}
