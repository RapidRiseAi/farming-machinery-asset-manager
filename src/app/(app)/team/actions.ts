"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { homePathFor, requireProfile } from "@/lib/auth";
import { farmPermissionState, isUserPermission } from "@/lib/permissions";
import { safePath } from "@/lib/safe-path";

const FARM_ROLES = ["manager", "mechanic", "operator"];
const ALL_ROLES = ["owner", "manager", "mechanic", "operator", "workshop", "rr_admin"];

/** Owner/manager authority comes from the farm currently selected in the signed cookie. */
async function requireTeamManager() {
  const profile = await requireProfile();
  const state = await farmPermissionState(profile);
  if (!state.farmId || !state.role || !["owner", "manager"].includes(state.role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }
  return { profile, farmId: state.farmId };
}

/**
 * Invite a user: creates a confirmed auth user (service-role Auth admin) and their
 * profile row. The person signs in via the magic-link on /login. RR admin may invite
 * any role to any farm/workshop; a farm owner/manager may invite farm roles to their
 * own farm.
 */
export async function inviteUser(formData: FormData) {
  const { profile: inviter, farmId } = await requireTeamManager();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "operator");
  const language = String(formData.get("language") ?? "en") === "af" ? "af" : "en";
  // `back` comes from a form field — never redirect to it unvalidated.
  const back = safePath(String(formData.get("back") ?? ""), "/team");

  if (!FARM_ROLES.includes(role)) redirect(`${back}?error=You+can+invite+manager/mechanic/operator+only`);
  if (!ALL_ROLES.includes(role) || !email || !name) redirect(`${back}?error=Email,+name+and+role+required`);

  const svc = createServiceClient();
  const { data: created, error: cErr } = await svc.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { name },
  });
  if (cErr || !created?.user) redirect(`${back}?error=${encodeURIComponent(cErr?.message ?? "Could not create user")}`);

  const { error: pErr } = await svc.from("users").insert({
    id: created.user.id,
    farm_id: farmId,
    workshop_id: null,
    role,
    name,
    email,
    language,
    active: true,
  });
  if (pErr) redirect(`${back}?error=${encodeURIComponent(pErr.message)}`);

  // 0340 backfilled memberships once at migration time. New users need their primary
  // membership written here so selected-farm role lookups have the same authoritative row.
  const { error: mErr } = await svc.from("user_farm_memberships").upsert(
    {
      user_id: created.user.id,
      farm_id: farmId,
      role,
      active: true,
      deleted_at: null,
      deleted_by: null,
    },
    { onConflict: "user_id,farm_id" },
  );
  if (mErr) redirect(`${back}?error=${encodeURIComponent(mErr.message)}`);

  revalidatePath(back);
  redirect(`${back}?invited=1`);
}

/**
 * POPIA erasure (right to deletion): anonymise a person's personal data on request.
 * The guarded `erase_personal_data` RPC (owner/manager of the subject's farm, or
 * rr_admin) clears name/email/phone, deactivates + soft-deletes the profile, and nulls
 * free-text name copies — keeping legally-required history de-identified (see
 * docs/POPIA.md). We then scrub + disable the auth identity so the residual email in
 * auth.users is removed and the person cannot sign back in.
 */
export async function erasePerson(formData: FormData) {
  const { profile: actor, farmId } = await requireTeamManager();
  const id = String(formData.get("id") ?? "").trim();
  // `back` comes from a form field — never redirect to it unvalidated.
  const back = safePath(String(formData.get("back") ?? ""), "/team");
  const reason = String(formData.get("reason") ?? "").trim() || "data-subject request";
  if (!id) redirect(`${back}?error=${encodeURIComponent("Missing person")}`);
  if (id === actor.id) redirect(`${back}?error=${encodeURIComponent("You cannot erase your own account.")}`);

  const supabase = await createClient();
  // Erasure deactivates the whole identity, not one membership. It therefore remains a
  // primary-farm action; a manager of only a secondary site must ask the primary farm.
  const { data: subject } = await supabase
    .from("users")
    .select("id")
    .eq("id", id)
    .eq("farm_id", farmId)
    .maybeSingle();
  if (!subject) redirect(`${back}?error=${encodeURIComponent("This account belongs to another primary farm.")}`);

  const { error } = await supabase.rpc("erase_personal_data", { p_user: id, p_reason: reason });
  if (error) redirect(`${back}?error=${encodeURIComponent(error.message)}`);

  // Belt-and-braces: remove the residual email in auth.users and ban re-login. Soft-fails
  // where Auth admin is unavailable — the DB anonymisation + deactivation already stands.
  try {
    const svc = createServiceClient();
    await svc.auth.admin.updateUserById(id, {
      email: `erased+${id}@fleetwise.invalid`,
      user_metadata: { name: "[erased]" },
      ban_duration: "876000h",
    });
  } catch {
    // ignore — the person's app access is already revoked
  }

  revalidatePath(back);
  redirect(`${back}?erased=1`);
}

/** Activate/deactivate a user. Scoped by RLS (owner/manager over their farm; RR admin all). */
export async function setUserActive(formData: FormData) {
  const { profile, farmId } = await requireTeamManager();
  const id = String(formData.get("id") ?? "");
  const active = String(formData.get("active") ?? "true") === "true";
  // `back` comes from a form field — never redirect to it unvalidated.
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
  if (error) redirect(`${back}?error=${encodeURIComponent(error.message)}`);
  if (!data) redirect(`${back}?error=${encodeURIComponent("This account belongs to another primary farm.")}`);
  revalidatePath(back);
  redirect(`${back}?saved=1`);
}

/** Add or revoke one 0507 grant for another person on the selected farm. */
export async function setUserPermission(formData: FormData) {
  const { profile, farmId } = await requireTeamManager();
  const back = safePath(String(formData.get("back") ?? ""), "/team");
  const userId = String(formData.get("user_id") ?? "").trim();
  const rawPermission = String(formData.get("permission") ?? "").trim();
  const enabled = String(formData.get("enabled") ?? "false") === "true";

  if (!userId || userId === profile.id) {
    redirect(`${back}?error=${encodeURIComponent("You cannot grant permissions to yourself.")}`);
  }
  if (!isUserPermission(rawPermission)) {
    redirect(`${back}?error=${encodeURIComponent("Unknown permission.")}`);
  }

  const supabase = await createClient();
  // Check membership through the caller's RLS session. The table policy and 0507's
  // `app.user_belongs_to_farm` repeat this at the write boundary.
  const [{ data: primary }, { data: membership }] = await Promise.all([
    supabase
      .from("users")
      .select("id, active")
      .eq("id", userId)
      .eq("farm_id", farmId)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("user_farm_memberships")
      .select("id, active")
      .eq("user_id", userId)
      .eq("farm_id", farmId)
      .is("deleted_at", null)
      .maybeSingle(),
  ]);
  const belongs = Boolean(
    (primary as { active?: boolean } | null)?.active ||
      (membership as { active?: boolean } | null)?.active,
  );
  if (!belongs) redirect(`${back}?error=${encodeURIComponent("That person is not active on this farm.")}`);

  // Managers are allowed to see revoked rows so the unique row can be reopened. The
  // post-0507 selected-farm policy intentionally keeps tombstones hidden from grantees.
  const { data: existing, error: findError } = await supabase
    .from("user_permission_grants")
    .select("id, deleted_at")
    .eq("user_id", userId)
    .eq("farm_id", farmId)
    .eq("permission", rawPermission)
    .maybeSingle();
  if (findError) redirect(`${back}?error=${encodeURIComponent(findError.message)}`);

  if (existing) {
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
    if (error) redirect(`${back}?error=${encodeURIComponent(error.message)}`);
    if (!data) redirect(`${back}?error=${encodeURIComponent("Permission was not changed.")}`);
  } else if (enabled) {
    const { error } = await supabase.from("user_permission_grants").insert({
      user_id: userId,
      farm_id: farmId,
      permission: rawPermission,
    });
    if (error) redirect(`${back}?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath(back);
  redirect(`${back}?permissionSaved=1`);
}
