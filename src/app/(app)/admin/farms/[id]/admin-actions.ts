"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { soft } from "@/lib/supabase/must";
import { sendInviteEmail } from "@/lib/email/invite";
import { APP_NAME } from "@/lib/env";
import { isUuid } from "@/lib/ids";
import { runOnce } from "@/lib/request-claim";
import { errorCode } from "@/lib/action-errors";
import { supportRefusal } from "@/lib/support/refusals";

/**
 * Rapid Rise helping a client with their people, from the client page.
 *
 * Founder decision 3 (2026-10-26): staff may help create accounts. The page used to post
 * to the team actions, which require an owner or manager OF THAT FARM, so every button
 * refused Rapid Rise, and an invite could never make anyone an owner.
 *
 * Every action starts with `requireRole(["rr_admin"])`, which the database confirms
 * (two-step this session, never a test account). Then:
 *   * Invite and Resend need the service key: whether an address already has a login
 *     lives in auth.users, and the sign-in link is minted by the admin API. It is used
 *     only behind that gate, and `team_invite_existing` checks the admin's id again
 *     (20261028101200). The test-account fence still applies in the database and in
 *     `sendEmail` (a test farm's mail goes only to a test inbox).
 *   * Deactivate and Activate go through `admin_set_user_active` with the admin's OWN
 *     session, so `auth.uid()` names who did it (20261028101300).
 */

const ROLES = ["owner", "manager", "mechanic", "operator"] as const;

type InviteDecision = {
  outcome: "none" | "created" | "already" | "switched_off" | "added" | "moved" | "refused";
  user_id?: string;
  name?: string;
  language?: string;
};

function alreadyRegistered(error: { code?: string; message?: string }): boolean {
  return error.code === "email_exists" || /already (been )?registered|already exists/i.test(error.message ?? "");
}

function farmOf(formData: FormData): string {
  const farm = String(formData.get("farm_id") ?? "");
  if (!isUuid(farm)) redirect("/admin/farms?error=not-found");
  return farm;
}

/** Invite somebody to a client's farm, an owner included, and email them a sign-in button. */
export async function adminInviteUser(formData: FormData) {
  const farm = farmOf(formData);
  const back = `/admin/farms/${farm}`;
  return runOnce(
    formData,
    "admin:invite",
    async () => {
      const admin = await requireRole(["rr_admin"]);
      const email = String(formData.get("email") ?? "").trim().toLowerCase();
      const name = String(formData.get("name") ?? "").trim();
      const role = String(formData.get("role") ?? "owner");
      const language = String(formData.get("language") ?? "en") === "af" ? "af" : "en";
      if (!(ROLES as readonly string[]).includes(role)) redirect(`${back}?error=admin-invite-role`);
      if (!email || !name) redirect(`${back}?error=admin-invite-fields`);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) redirect(`${back}?error=need-email`);

      const svc = createServiceClient();
      const decide = async (): Promise<InviteDecision> => {
        const { data, error } = await svc.rpc("team_invite_existing", {
          p_farm: farm,
          p_actor: admin.id,
          p_email: email,
          p_role: role,
          p_name: name,
          p_language: language,
        });
        if (error) {
          const fence = /never mix|cannot join a (real|test) (farm|workshop)/i.test(error.message ?? "");
          redirect(`${back}?error=${fence ? "invite-refused" : error.code === "42501" ? "forbidden" : errorCode(error, "admin:invite", "invite-failed")}`);
        }
        return data as InviteDecision;
      };

      let decision = await decide();
      if (decision.outcome === "none") {
        const { error } = await svc.auth.admin.createUser({ email, email_confirm: true, user_metadata: { name } });
        if (error && !alreadyRegistered(error)) {
          redirect(`${back}?error=${error.code === "email_address_invalid" ? "need-email" : "invite-failed"}`);
        }
        decision = await decide();
      }
      if (decision.outcome === "refused") redirect(`${back}?error=invite-refused`);
      if (decision.outcome === "switched_off") redirect(`${back}?error=invite-switched-off`);
      if (decision.outcome === "none") redirect(`${back}?error=invite-failed`);

      // On the farm from here on: the email may fail without undoing it.
      const farmRow = soft(await svc.from("farms").select("name").eq("id", farm).maybeSingle(), "admin:invite:farm-name");
      const sent = await sendInviteEmail(svc, {
        email,
        name: decision.name ?? name,
        farmId: farm,
        farmName: (farmRow as { name?: string } | null)?.name ?? APP_NAME,
        inviterName: null,
        locale: decision.language === "af" ? "af" : language,
      });
      if (!sent.ok) console.error(`[admin] invite email not sent: ${sent.reason}${sent.detail ? ` (${sent.detail})` : ""}`);

      revalidatePath(back);
      return `${back}?invited=${!sent.ok ? "noemail" : decision.outcome === "already" ? "again" : "1"}`;
    },
    { whileRunning: `${back}?error=still-saving` },
  );
}

/** Send the sign-in email again to somebody already on the farm (they never signed in, or lost it). */
export async function adminResendInvite(formData: FormData) {
  const farm = farmOf(formData);
  const back = `/admin/farms/${farm}`;
  return runOnce(
    formData,
    "admin:resend-invite",
    async () => {
      await requireRole(["rr_admin"]);
      const userId = String(formData.get("user_id") ?? "");
      if (!isUuid(userId)) redirect(`${back}?error=admin-user-invalid`);

      // The admin's own session reads the person (Rapid Rise reads every farm in RLS),
      // and they must be on THIS farm: home farm or an active membership.
      const supabase = await createClient();
      const [{ data: person, error: personError }, { data: member, error: memberError }, { data: farmRow, error: farmError }] =
        await Promise.all([
          supabase.from("users").select("id, name, email, language, farm_id, active, role").eq("id", userId).is("deleted_at", null).maybeSingle(),
          supabase.from("user_farm_memberships").select("user_id").eq("user_id", userId).eq("farm_id", farm).eq("active", true).is("deleted_at", null).maybeSingle(),
          supabase.from("farms").select("name").eq("id", farm).maybeSingle(),
        ]);
      const readError = personError ?? memberError ?? farmError;
      if (readError) redirect(`${back}?error=${errorCode(readError, "admin:resend-invite:read")}`);
      const p = person as { id: string; name: string | null; email: string | null; language: string | null; farm_id: string | null; active: boolean; role: string } | null;
      if (!p || !p.email || !p.active || p.role === "rr_admin" || (p.farm_id !== farm && !member)) {
        redirect(`${back}?error=admin-user-invalid`);
      }

      const sent = await sendInviteEmail(createServiceClient(), {
        email: p.email,
        name: p.name,
        farmId: farm,
        farmName: (farmRow as { name?: string } | null)?.name ?? APP_NAME,
        inviterName: null,
        locale: p.language === "af" ? "af" : "en",
      });
      if (!sent.ok) console.error(`[admin] resend invite not sent: ${sent.reason}${sent.detail ? ` (${sent.detail})` : ""}`);
      return `${back}?invited=${sent.ok ? "resent" : "noemail"}`;
    },
    { whileRunning: `${back}?error=still-saving` },
  );
}

/** Switch somebody off on this farm, or on again. Never deletes anything. */
export async function adminSetUserActive(formData: FormData) {
  await requireRole(["rr_admin"]);
  const farm = farmOf(formData);
  const back = `/admin/farms/${farm}`;
  const userId = String(formData.get("user_id") ?? "");
  const active = String(formData.get("active") ?? "") === "true";
  if (!isUuid(userId)) redirect(`${back}?error=admin-user-invalid`);
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_user_active", { p_farm: farm, p_user: userId, p_active: active });
  if (error) {
    const refusal = supportRefusal(error);
    redirect(`${back}?error=${refusal ?? errorCode(error, "admin:set-user-active")}`);
  }
  revalidatePath(back);
  redirect(`${back}?saved=${active ? "activated" : "deactivated"}`);
}
