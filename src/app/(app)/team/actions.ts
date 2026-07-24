"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";

const FARM_ROLES = ["manager", "mechanic", "operator"];
const ALL_ROLES = ["owner", "manager", "mechanic", "operator", "workshop", "rr_admin"];

/**
 * Invite a user: creates a confirmed auth user (service-role Auth admin) and their
 * profile row. The person signs in via the magic-link on /login. RR admin may invite
 * any role to any farm/workshop; a farm owner/manager may invite farm roles to their
 * own farm.
 */
export async function inviteUser(formData: FormData) {
  const inviter = await requireProfile();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "operator");
  const farmId = String(formData.get("farm_id") ?? "").trim() || null;
  const workshopId = String(formData.get("workshop_id") ?? "").trim() || null;
  const language = String(formData.get("language") ?? "en") === "af" ? "af" : "en";
  const back = String(formData.get("back") ?? "/team");

  const isAdmin = inviter.role === "rr_admin";
  const isFarmBoss =
    (inviter.role === "owner" || inviter.role === "manager") &&
    inviter.farm_id != null &&
    inviter.farm_id === farmId;
  if (!isAdmin && !isFarmBoss) redirect(`${back}?error=Not+allowed`);
  if (!isAdmin && !FARM_ROLES.includes(role)) redirect(`${back}?error=You+can+invite+manager/mechanic/operator+only`);
  if (!ALL_ROLES.includes(role) || !email || !name) redirect(`${back}?error=Email,+name+and+role+required`);

  const profileFarm = role === "rr_admin" || role === "workshop" ? null : farmId;
  const profileWorkshop = role === "workshop" ? workshopId : null;
  if (role !== "rr_admin" && role !== "workshop" && !profileFarm) redirect(`${back}?error=Farm+required`);
  if (role === "workshop" && !profileWorkshop) redirect(`${back}?error=Workshop+required`);

  const svc = createServiceClient();
  const { data: created, error: cErr } = await svc.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { name },
  });
  if (cErr || !created?.user) redirect(`${back}?error=${encodeURIComponent(cErr?.message ?? "Could not create user")}`);

  const { error: pErr } = await svc.from("users").insert({
    id: created.user.id,
    farm_id: profileFarm,
    workshop_id: profileWorkshop,
    role,
    name,
    email,
    language,
    active: true,
  });
  if (pErr) redirect(`${back}?error=${encodeURIComponent(pErr.message)}`);

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
  const actor = await requireProfile();
  const id = String(formData.get("id") ?? "").trim();
  const back = String(formData.get("back") ?? "/team");
  const reason = String(formData.get("reason") ?? "").trim() || "data-subject request";
  if (!id) redirect(`${back}?error=${encodeURIComponent("Missing person")}`);
  if (id === actor.id) redirect(`${back}?error=${encodeURIComponent("You cannot erase your own account.")}`);

  const supabase = await createClient();
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
  await requireProfile();
  const id = String(formData.get("id") ?? "");
  const active = String(formData.get("active") ?? "true") === "true";
  const back = String(formData.get("back") ?? "/team");
  const supabase = await createClient();
  const { error } = await supabase.from("users").update({ active }).eq("id", id);
  if (error) redirect(`${back}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(back);
  redirect(`${back}?saved=1`);
}
