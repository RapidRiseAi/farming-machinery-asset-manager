import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  type Plan,
  type Feature,
  isPlan,
  planAllows,
  requiredPlan as minPlanFor,
} from "@/lib/entitlements";
import {
  type WorkshopPlan,
  type WorkshopFeature,
  isWorkshopPlan,
  workshopPlanAllows,
  workshopRequiredPlan,
} from "@/lib/contractor-plan";
import { BRANDING_COLUMNS, type WorkshopBrandingRow } from "@/lib/branding";
import {
  type Locale,
  type Tone,
  type Lang,
  langOf,
  defaultLocale,
  defaultTone,
  isTone,
} from "@/lib/i18n";
import { isLocale } from "@/lib/locale";

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
  /** The person's language choice on its own — what the EN/AF switch shows as current. */
  language: Locale;
  /** Their wording register on its own — what the tone switch shows as current. */
  tone: Tone;
  /**
   * What to render in: language and tone composed into the single value `t()` takes.
   *
   * Pages read THIS, never `language`, so a page cannot accidentally render one of the
   * two choices and ignore the other — which is exactly how the old bug worked, with
   * `<html lang>` reading the cookie while the body read the profile.
   */
  lang: Lang;
  /** Null until the person chooses a language themselves. See migration 0370. */
  language_set_at: string | null;
  active: boolean;
};

type ProfileRow = Omit<Profile, "lang"> & { language: Locale; tone: Tone };

const PROFILE_COLUMNS =
  "id, farm_id, workshop_id, role, name, email, language, tone, language_set_at, active";

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
  const row = data as ProfileRow | null;
  if (!row) return null;
  const language: Locale = isLocale(row.language) ? row.language : defaultLocale;
  const tone: Tone = isTone(row.tone) ? row.tone : defaultTone;
  return { ...row, language, tone, lang: langOf(language, tone) };
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

/**
 * Where a role belongs when it has nowhere more specific to be.
 *
 * `requireRole` used to send EVERY denied user to `/dashboard?error=forbidden`. For an
 * operator that is the owner's money page — the one surface a farm can explicitly switch
 * off for operators via `cost_visible_to_operators` — and `error=forbidden` was never
 * rendered as anything a person could read, so the screen simply changed with no
 * explanation. Each role now has a home, and this is the only place that decides it.
 */
export function homePathFor(role: Role): string {
  switch (role) {
    case "workshop":
      return "/contractor";
    case "operator":
      return "/driver";
    case "rr_admin":
      return "/admin/farms";
    default:
      return "/dashboard";
  }
}

/**
 * Require the profile to hold one of `roles`, else send them to their OWN home with a
 * flag the destination renders as a plain sentence.
 */
export async function requireRole(roles: Role[]): Promise<Profile> {
  const profile = await requireProfile();
  if (!roles.includes(profile.role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }
  return profile;
}

// ── Multi-site "current farm" (F7) ───────────────────────────────────────────
// One account can now reach MULTIPLE farms (user_farm_memberships, 0340). The app keeps
// a "current farm" the user is acting in — a cookie choice, validated against the farms
// they may actually access, defaulting to their PRIMARY farm (users.farm_id). Per-site
// surfaces (dashboard/reports/machines) filter by this id; single-farm users are
// unaffected (it is always their one farm). rr_admin/workshop have no single acting farm.

export const CURRENT_FARM_COOKIE = "fw_farm";

export type FarmOption = { id: string; name: string };

/** Farms the current user may act in (primary + active memberships), name-sorted.
 *  RLS-scoped via `farms_sel` (== app.accessible_farm_ids). Empty for rr_admin/workshop,
 *  which use their own shells rather than a per-site switcher. */
export async function accessibleFarms(profile?: Profile): Promise<FarmOption[]> {
  const p = profile ?? (await requireProfile());
  if (p.role === "rr_admin" || p.role === "workshop") return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("farms")
    .select("id, name")
    .is("deleted_at", null)
    .order("name");
  return (data as FarmOption[] | null) ?? [];
}

// ── RR support mode (S10) ────────────────────────────────────────────────────
// "Act into farm" used to write an audit row and nothing else: no farm context was set
// and no session state changed, so staff believed they were inside a customer account
// when they were not, and there was no banner or exit because there was no mode to exit.
//
// Support mode is a NARROWING, never a grant. rr_admin already reads every farm through
// `app.is_rr_admin()` in RLS; pinning a farm only scopes what the UI queries, so the
// cookie cannot widen access even if forged — the worst a tampered value can do is show
// an admin an empty screen. The value is validated against a real farm row regardless.

export const SUPPORT_FARM_COOKIE = "fw_support_farm";

/** The farm an RR admin is currently supporting, or null. rr_admin only. */
export async function supportFarmId(profile?: Profile): Promise<string | null> {
  const p = profile ?? (await requireProfile());
  if (p.role !== "rr_admin") return null;
  const chosen = (await cookies()).get(SUPPORT_FARM_COOKIE)?.value;
  return chosen && /^[0-9a-f-]{36}$/i.test(chosen) ? chosen : null;
}

/** The supported farm's name, for the banner. Null when not in support mode. */
export async function supportFarm(profile?: Profile): Promise<FarmOption | null> {
  const id = await supportFarmId(profile);
  if (!id) return null;
  const supabase = await createClient();
  const { data } = await supabase.from("farms").select("id, name").eq("id", id).maybeSingle();
  return (data as FarmOption | null) ?? null;
}

/** The farm the user is currently acting in: the validated cookie choice, else their
 *  primary farm. Returns null for roles with no single farm (workshop), and the
 *  supported farm for an rr_admin in support mode. */
export async function currentFarmId(profile?: Profile): Promise<string | null> {
  const p = profile ?? (await requireProfile());
  if (p.role === "rr_admin") return await supportFarmId(p);
  if (!p.farm_id) return null;
  const store = await cookies();
  const chosen = store.get(CURRENT_FARM_COOKIE)?.value;
  if (chosen && chosen !== p.farm_id) {
    // Only honour a cookie that names a farm this user can genuinely access — never a
    // guessable bypass (RLS would deny the data regardless, but keep the UI honest).
    const farms = await accessibleFarms(p);
    if (farms.some((f) => f.id === chosen)) return chosen;
  }
  return p.farm_id;
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

// ── Partner-plan gating (F12c, reshaped in F14e) ─────────────────────────────
// The two-sided twin of the farm entitlement above: this governs the PARTNER's portal
// by the product they bought (`workshops.plan`, 0382 — portal | managed), NOT tenancy —
// isolation stays with RLS + workshop_links. Map lives in src/lib/contractor-plan.ts.

export type WorkshopEntitlementCheck = {
  profile: Profile;
  /** The workshop's plan, or null when the user is not a workshop (no contractor portal). */
  plan: WorkshopPlan | null;
  feature: WorkshopFeature;
  requiredPlan: WorkshopPlan;
  allowed: boolean;
};

/**
 * The current partner user's product, or null when the user is not a workshop.
 * Falls back to `portal` if the row is somehow unreadable — the safe direction, since
 * `portal` is the one every partner is entitled to. Reads the real `workshops.plan`
 * column; the map in contractor-plan.ts is the entitlement authority.
 */
export async function workshopPlan(
  profile?: Profile
): Promise<{ profile: Profile; plan: WorkshopPlan | null }> {
  const p = profile ?? (await requireProfile());
  if (p.role !== "workshop" || !p.workshop_id) return { profile: p, plan: null };
  const supabase = await createClient();
  const { data } = await supabase
    .from("workshops")
    .select("plan")
    .eq("id", p.workshop_id)
    .maybeSingle();
  const plan = (data as { plan: string } | null)?.plan;
  return { profile: p, plan: plan && isWorkshopPlan(plan) ? plan : "portal" };
}

/**
 * The current partner's full account row — letterhead, business details, document
 * defaults and product — in one read. Returns null for anyone who is not a workshop
 * user. Used by the partner's settings screen, the document builder and the PDF route,
 * all of which need the same row and must not each invent their own column list.
 */
export async function currentWorkshop(
  profile?: Profile
): Promise<{ profile: Profile; workshop: WorkshopBrandingRow | null; plan: WorkshopPlan | null }> {
  const p = profile ?? (await requireProfile());
  if (p.role !== "workshop" || !p.workshop_id) return { profile: p, workshop: null, plan: null };
  const supabase = await createClient();
  const { data } = await supabase
    .from("workshops")
    .select(`${BRANDING_COLUMNS}, kind, area, plan`)
    .eq("id", p.workshop_id)
    .maybeSingle();
  const row = data as (WorkshopBrandingRow & { plan?: string }) | null;
  const plan = row?.plan;
  return { profile: p, workshop: row, plan: plan && isWorkshopPlan(plan) ? plan : "portal" };
}

/** Evaluate a contractor-plan entitlement without redirecting (for inline panels/nav). */
export async function checkWorkshopEntitlement(
  feature: WorkshopFeature,
  profile?: Profile
): Promise<WorkshopEntitlementCheck> {
  const { profile: p, plan } = await workshopPlan(profile);
  // A non-workshop has no contractor portal → the feature is not applicable (denied).
  const allowed = plan == null ? false : workshopPlanAllows(plan, feature);
  return { profile: p, plan, feature, requiredPlan: workshopRequiredPlan(feature), allowed };
}
