"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { homePathFor, requireProfile, requireUsableFarm, type Role } from "@/lib/auth";
import {
  farmPermissionState,
  isUserPermission,
  roleHasBaselinePermission,
  USER_PERMISSIONS,
  type UserPermission,
} from "@/lib/permissions";
import { safePath } from "@/lib/safe-path";
import { sendInviteEmail } from "@/lib/email/invite";
import { APP_NAME } from "@/lib/env";
import { runOnce } from "@/lib/request-claim";
import { errorCode } from "@/lib/action-errors";
import { captureError } from "@/lib/observability";
import { soft } from "@/lib/supabase/must";

const FARM_ROLES = ["manager", "mechanic", "operator"];
const ALL_ROLES = ["owner", "manager", "mechanic", "operator", "workshop", "rr_admin"];

/** Owner/manager authority comes from the farm currently selected in the signed cookie. */
async function requireTeamManager() {
  const profile = await requireProfile();
  const state = await farmPermissionState(profile);
  if (!state.farmId || !state.role || !["owner", "manager"].includes(state.role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }
  await requireUsableFarm(state.farmId, profile);
  return { profile, farmId: state.farmId };
}

/** What `public.team_invite_existing` decided. See that migration (20261005120000). */
type InviteDecision = {
  outcome: "none" | "created" | "already" | "switched_off" | "added" | "moved" | "refused";
  user_id?: string;
  name?: string;
  language?: string;
};

/** Supabase's "this address already has a login", by code where it sends one. */
function alreadyRegistered(error: { code?: string; message?: string }): boolean {
  return error.code === "email_exists" || /already (been )?registered|already exists/i.test(error.message ?? "");
}

/**
 * Invite somebody to this farm and email them a button that signs them in.
 *
 * The database decides what the address means (team_invite_existing, 20261005120000):
 * a brand-new person, somebody already here, somebody on another farm who is added, or
 * somebody whose own farm was an unpaid sign-up and who moves here. A brand-new person
 * gets a login first and the question is asked again, so the profile and membership are
 * only ever written in that one function, under its per-address lock.
 *
 * The email is sent last and is allowed to fail: they are on the team either way, the
 * owner is told it did not go, and the sign-in page can always send a link.
 */
export async function inviteUser(formData: FormData) {
  return runOnce(
    formData,
    "team:invite",
    async () => {
      const { profile: inviter, farmId } = await requireTeamManager();
      const email = String(formData.get("email") ?? "").trim().toLowerCase();
      const name = String(formData.get("name") ?? "").trim();
      const role = String(formData.get("role") ?? "operator");
      const language = String(formData.get("language") ?? "en") === "af" ? "af" : "en";
      // `back` comes from a form field, never redirect to it unvalidated.
      const back = safePath(String(formData.get("back") ?? ""), "/team");

      if (!FARM_ROLES.includes(role)) redirect(`${back}?error=You+can+invite+manager/mechanic/operator+only`);
      if (!ALL_ROLES.includes(role) || !email || !name) redirect(`${back}?error=Email,+name+and+role+required`);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) redirect(`${back}?error=need-email`);

      const svc = createServiceClient();
      const decide = async (): Promise<InviteDecision> => {
        const { data, error } = await svc.rpc("team_invite_existing", {
          p_farm: farmId,
          p_actor: inviter.id,
          p_email: email,
          p_role: role,
          p_name: name,
          p_language: language,
        });
        if (error) {
          // The test-account fence (20261014120000) refuses with 42501 as well: that address
          // cannot join this team, which is not the inviter lacking permission.
          const fence = /never mix|cannot join a (real|test) (farm|workshop)/i.test(error.message ?? "");
          redirect(`${back}?error=${fence ? "invite-refused" : error.code === "42501" ? "forbidden" : "invite-failed"}`);
        }
        return data as InviteDecision;
      };

      let decision = await decide();
      if (decision.outcome === "none") {
        const { error } = await svc.auth.admin.createUser({ email, email_confirm: true, user_metadata: { name } });
        // A second invite for the same address can make the login between the two calls.
        // Asking again finds it either way.
        if (error && !alreadyRegistered(error)) {
          redirect(`${back}?error=${error.code === "email_address_invalid" ? "need-email" : "invite-failed"}`);
        }
        decision = await decide();
      }

      if (decision.outcome === "refused") redirect(`${back}?error=invite-refused`);
      if (decision.outcome === "switched_off") redirect(`${back}?error=invite-switched-off`);
      if (decision.outcome === "none") redirect(`${back}?error=invite-failed`);

      // soft: only the email's wording depends on it, and they are on the team already.
      const farm = soft(await svc.from("farms").select("name").eq("id", farmId).maybeSingle(), "team:invite:farm-name");
      const sent = await sendInviteEmail(svc, {
        email,
        name: decision.name ?? name,
        farmId,
        farmName: (farm as { name?: string } | null)?.name ?? APP_NAME,
        inviterName: inviter.name,
        // Their own language when they already have a profile; the form's for a new person.
        locale: decision.language === "af" ? "af" : "en",
      });
      if (!sent.ok) console.error(`[team] invite email not sent: ${sent.reason}${sent.detail ? ` (${sent.detail})` : ""}`);

      revalidatePath(back);
      return `${back}?invited=${!sent.ok ? "noemail" : decision.outcome === "already" ? "again" : "1"}`;
    },
    { whileRunning: `${safePath(String(formData.get("back") ?? ""), "/team")}?error=still-saving` },
  );
}

/**
 * POPIA erasure (right to deletion): anonymise a person's personal data on request.
 * The guarded `erase_personal_data` RPC (owner/manager of the subject's farm, or
 * rr_admin) clears name/email/phone, deactivates + soft-deletes the profile, and nulls
 * free-text name copies, keeping legally-required history de-identified (see
 * docs/POPIA.md). We then scrub + disable the auth identity so the residual email in
 * auth.users is removed and the person cannot sign back in.
 */
export async function erasePerson(formData: FormData) {
  const { profile: actor, farmId } = await requireTeamManager();
  const id = String(formData.get("id") ?? "").trim();
  // `back` comes from a form field, never redirect to it unvalidated.
  const back = safePath(String(formData.get("back") ?? ""), "/team");
  const reason = String(formData.get("reason") ?? "").trim() || "data-subject request";
  if (!id) redirect(`${back}?error=${encodeURIComponent("Missing person")}`);
  if (id === actor.id) redirect(`${back}?error=${encodeURIComponent("You cannot erase your own account.")}`);

  const supabase = await createClient();
  // Erasure deactivates the whole identity, not one membership. It therefore remains a
  // primary-farm action; a manager of only a secondary site must ask the primary farm.
  const { data: subject, error: subjectError } = await supabase
    .from("users")
    .select("id")
    .eq("id", id)
    .eq("farm_id", farmId)
    .maybeSingle();
  // A failed read is ours, not "another primary farm".
  if (subjectError) redirect(`${back}?error=${errorCode(subjectError, "app/team/actions:erasePerson:subject")}`);
  if (!subject) redirect(`${back}?error=${encodeURIComponent("This account belongs to another primary farm.")}`);

  const { error } = await supabase.rpc("erase_personal_data", { p_user: id, p_reason: reason });
  if (error) redirect(`${back}?error=${errorCode(error, "app/team/actions:erasePerson")}`);

  // Belt-and-braces: remove the residual email in auth.users and ban re-login. Soft-fails
  // where Auth admin is unavailable, the DB anonymisation + deactivation already stands.
  // updateUserById answers { error } rather than throwing, so the old try/catch never saw
  // a failure: the email scrub and the login ban could quietly not happen. Still soft (the
  // anonymisation and deactivation stand), but reported now, as an erasure request is a
  // legal duty and somebody must finish it.
  try {
    const svc = createServiceClient();
    const { error: authError } = await svc.auth.admin.updateUserById(id, {
      email: `erased+${id}@fleetwise.invalid`,
      user_metadata: { name: "[erased]" },
      ban_duration: "876000h",
    });
    if (authError) captureError(authError, { where: "team:erase:auth-scrub", extra: { userId: id } });
  } catch (authFailure) {
    captureError(authFailure, { where: "team:erase:auth-scrub", extra: { userId: id } });
  }

  revalidatePath(back);
  redirect(`${back}?erased=1`);
}

/** Activate/deactivate a user. Scoped by RLS (owner/manager over their farm; RR admin all). */
export async function setUserActive(formData: FormData) {
  const { profile, farmId } = await requireTeamManager();
  const id = String(formData.get("id") ?? "");
  const active = String(formData.get("active") ?? "true") === "true";
  // `back` comes from a form field, never redirect to it unvalidated.
  const back = safePath(String(formData.get("back") ?? ""), "/team");
  if (!id || id === profile.id) redirect(`${back}?error=${encodeURIComponent("You cannot change your own account status.")}`);
  const supabase = await createClient();
  // Account activation is global. Scope it to a profile whose PRIMARY farm is the farm
  // being administered; secondary-site membership lifecycle is a separate operation.
  const { data, error } = await supabase
    .from("users")
    .update({ active })
    .eq("id", id)
    .eq("farm_id", farmId)
    .select("id")
    .maybeSingle();
  if (error) redirect(`${back}?error=${errorCode(error, "app/team/actions:setUserActive")}`);
  if (!data) redirect(`${back}?error=${encodeURIComponent("This account belongs to another primary farm.")}`);
  revalidatePath(back);
  // Say which way it went: "Saved" after turning somebody's login off says nothing.
  redirect(`${back}?saved=${active ? "activated" : "deactivated"}`);
}

type ServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * May `userId` be given grants on `farmId` by the caller? Not themselves, and only a
 * person active on this farm. Checked through the caller's RLS session; the table policy
 * and 0507's `app.user_belongs_to_farm` repeat it at the write boundary.
 *
 * Returns their role on THIS farm, worked out the way /team shows it, so the caller can
 * tell which permissions that role already includes.
 */
async function requireGrantee(
  supabase: ServerClient,
  { actorId, userId, farmId, back }: { actorId: string; userId: string; farmId: string; back: string },
): Promise<Role | null> {
  if (!userId || userId === actorId) {
    redirect(`${back}?error=${encodeURIComponent("You cannot grant permissions to yourself.")}`);
  }
  const [{ data: primaryData, error: primaryError }, { data: membershipData, error: membershipError }] = await Promise.all([
    supabase
      .from("users")
      .select("id, active, role")
      .eq("id", userId)
      .eq("farm_id", farmId)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("user_farm_memberships")
      .select("id, active, role")
      .eq("user_id", userId)
      .eq("farm_id", farmId)
      .is("deleted_at", null)
      .maybeSingle(),
  ]);
  // Unread is not "not active here", and the role read decides which boxes are skipped.
  const readError = primaryError ?? membershipError;
  if (readError) redirect(`${back}?error=${errorCode(readError, "app/team/actions:requireGrantee")}`);
  const primary = primaryData as { active?: boolean; role?: Role } | null;
  const membership = membershipData as { active?: boolean; role?: Role } | null;
  if (!primary?.active && !membership?.active) {
    redirect(`${back}?error=${encodeURIComponent("That person is not active on this farm.")}`);
  }
  return (membership?.active ? membership.role : primary ? primary.role : membership?.role) ?? null;
}

/**
 * Open, reopen or revoke one 0507 grant row. Returns the `?error=` value, already
 * URL-encoded, or null. A database failure goes through errorCode, so it is reported and
 * its raw message never reaches the URL.
 */
async function writeGrant(
  supabase: ServerClient,
  { userId, farmId, permission, enabled }: { userId: string; farmId: string; permission: UserPermission; enabled: boolean },
): Promise<string | null> {
  // Managers are allowed to see revoked rows so the unique row can be reopened. The
  // post-0507 selected-farm policy intentionally keeps tombstones hidden from grantees.
  const { data: existing, error: findError } = await supabase
    .from("user_permission_grants")
    .select("id, deleted_at")
    .eq("user_id", userId)
    .eq("farm_id", farmId)
    .eq("permission", permission)
    .maybeSingle();
  if (findError) return errorCode(findError, "app/team/actions:writeGrant:find");

  if (existing) {
    // Already the way it was asked for: nothing to write. The dialog posts every box,
    // and rewriting the unchanged ones would fill audit_log with non-events.
    const isOn = (existing as { deleted_at: string | null }).deleted_at == null;
    if (isOn === enabled) return null;
    const { data, error } = await supabase
      .from("user_permission_grants")
      .update(
        enabled
          ? { deleted_at: null, deleted_by: null }
          : { deleted_at: new Date().toISOString() },
      )
      .eq("id", existing.id)
      .select("id")
      .maybeSingle();
    if (error) return errorCode(error, "app/team/actions:writeGrant:update");
    if (!data) return encodeURIComponent("Permission was not changed.");
  } else if (enabled) {
    const { error } = await supabase.from("user_permission_grants").insert({
      user_id: userId,
      farm_id: farmId,
      permission,
    });
    if (error) return errorCode(error, "app/team/actions:writeGrant:insert");
  }
  return null;
}

/** Add or revoke one 0507 grant for another person on the selected farm. */
export async function setUserPermission(formData: FormData) {
  const { profile, farmId } = await requireTeamManager();
  const back = safePath(String(formData.get("back") ?? ""), "/team");
  const userId = String(formData.get("user_id") ?? "").trim();
  const rawPermission = String(formData.get("permission") ?? "").trim();
  const enabled = String(formData.get("enabled") ?? "false") === "true";

  if (!isUserPermission(rawPermission)) {
    redirect(`${back}?error=${encodeURIComponent("Unknown permission.")}`);
  }

  const supabase = await createClient();
  await requireGrantee(supabase, { actorId: profile.id, userId, farmId, back });
  const failed = await writeGrant(supabase, { userId, farmId, permission: rawPermission, enabled });
  if (failed) redirect(`${back}?error=${failed}`);

  revalidatePath(back);
  redirect(`${back}?permissionSaved=1`);
}

/**
 * "What they can do": every extra permission for one person, from one dialog of
 * checkboxes. A ticked box is on and an absent one is off, so this applies the whole set
 * the dialog showed. A permission the person's role already includes is skipped: the
 * dialog shows it ticked and disabled, a disabled box posts nothing, and reading that as
 * "off" would write a revocation nobody asked for.
 */
export async function setUserPermissions(formData: FormData) {
  const { profile, farmId } = await requireTeamManager();
  const back = safePath(String(formData.get("back") ?? ""), "/team");
  const userId = String(formData.get("user_id") ?? "").trim();

  const supabase = await createClient();
  const role = await requireGrantee(supabase, { actorId: profile.id, userId, farmId, back });

  for (const permission of USER_PERMISSIONS) {
    if (roleHasBaselinePermission(role, permission)) continue;
    const failed = await writeGrant(supabase, {
      userId,
      farmId,
      permission,
      enabled: formData.get(permission) === "on",
    });
    if (failed) redirect(`${back}?error=${failed}`);
  }

  revalidatePath(back);
  redirect(`${back}?permissionSaved=1`);
}
