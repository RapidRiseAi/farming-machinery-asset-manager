import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  type Plan,
  type Feature,
  isPlan,
  planAllows,
  requiredPlan as minPlanFor,
} from "@/lib/entitlements";

export type Role =
  | "rr_admin"
  | "owner"
  | "manager"
  | "mechanic"
  | "workshop"
  | "operator";

export type Profile = {
  id: string;
  farm_id: string | null;
  workshop_id: string | null;
  role: Role;
  name: string;
  email: string | null;
  language: "en" | "af";
  active: boolean;
};

const PROFILE_COLUMNS =
  "id, farm_id, workshop_id, role, name, email, language, active";

/** The authenticated Supabase auth user, or null. */
export async function getUser(): Promise<User | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}

/** The current user's app profile row (public.users), or null. */
export async function getProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;
  const { data } = await supabase
    .from("users")
    .select(PROFILE_COLUMNS)
    .eq("id", uid)
    .maybeSingle();
  return (data as Profile | null) ?? null;
}

/** Redirect to /login unless authenticated. */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Require an active app profile. A logged-in auth user with no profile row (or a
 * deactivated one) is sent back to /login — profiles are created via invites.
 */
export async function requireProfile(): Promise<Profile> {
  const profile = await getProfile();
  if (!profile || !profile.active) redirect("/login?error=no-profile");
  return profile;
}

/** Require the profile to hold one of `roles`, else bounce to the dashboard. */
export async function requireRole(roles: Role[]): Promise<Profile> {
  const profile = await requireProfile();
  if (!roles.includes(profile.role)) redirect("/dashboard?error=forbidden");
  return profile;
}

// ── Entitlement gating (F5) ──────────────────────────────────────────────────
// Feature access is governed by the FARM's subscription plan (src/lib/entitlements.ts,
// mirrored by app.has_entitlement in SQL). Two roles BYPASS plan gates entirely:
//   * rr_admin — FleetWise platform staff (cross-tenant; not the billing subject);
//   * workshop — external contractors who only ever reach a linked farm's data through
//     RLS, and whose entitlement is that farm's concern, not their own.
// Everyone else is gated by their own farm's plan.

export type EntitlementCheck = {
  profile: Profile;
  /** The governing farm plan, or null when the role bypasses gating (rr_admin/workshop). */
  plan: Plan | null;
  feature: Feature;
  requiredPlan: Plan;
  allowed: boolean;
};

/** Read a farm's plan (defaults to the entry plan if somehow unset/unreadable). */
export async function getFarmPlan(farmId: string): Promise<Plan> {
  const supabase = await createClient();
  const { data } = await supabase.from("farms").select("plan").eq("id", farmId).maybeSingle();
  const p = (data as { plan: string } | null)?.plan;
  return p && isPlan(p) ? p : "essential";
}

/** The current user's governing plan, or null if the role bypasses gating. */
export async function currentPlan(
  profile?: Profile
): Promise<{ profile: Profile; plan: Plan | null }> {
  const p = profile ?? (await requireProfile());
  if (p.role === "rr_admin" || p.role === "workshop" || !p.farm_id) {
    return { profile: p, plan: null };
  }
  return { profile: p, plan: await getFarmPlan(p.farm_id) };
}

/** Evaluate an entitlement without redirecting — for pages/nav/inline sections. */
export async function checkEntitlement(
  feature: Feature,
  profile?: Profile
): Promise<EntitlementCheck> {
  const { profile: p, plan } = await currentPlan(profile);
  const allowed = plan == null ? true : planAllows(plan, feature);
  return { profile: p, plan, feature, requiredPlan: minPlanFor(feature), allowed };
}

/**
 * Enforce an entitlement server-side in a route/action. If the farm's plan does not
 * unlock `feature`, redirect to `redirectTo` (the relevant surface, which renders the
 * upgrade prompt) — a real server-side denial, not merely hidden UI. Returns the profile
 * when allowed.
 */
export async function requireEntitlement(
  feature: Feature,
  redirectTo = "/machines"
): Promise<Profile> {
  const { profile, allowed } = await checkEntitlement(feature);
  if (!allowed) redirect(`${redirectTo}?error=upgrade_required`);
  return profile;
}
