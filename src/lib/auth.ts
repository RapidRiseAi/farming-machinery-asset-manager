import { cache } from "react";
import { redirect, unstable_rethrow } from "next/navigation";
import { cookies, headers } from "next/headers";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { rapidRiseLockPath, rapidRiseVerdict, readAssurance, type Assurance } from "@/lib/mfa";
import { safePath } from "@/lib/safe-path";
import { must, ReadFailed } from "@/lib/supabase/must";
import { authUnanswered } from "@/lib/auth-unanswered";
import { captureError } from "@/lib/observability";
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
import { isUuid } from "@/lib/ids";

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
  /** The person's language choice on its own, what the EN/AF switch shows as current. */
  language: Locale;
  /** Their wording register on its own, what the tone switch shows as current. */
  tone: Tone;
  /**
   * What to render in: language and tone composed into the single value `t()` takes.
   *
   * Pages read THIS, never `language`, so a page cannot accidentally render one of the
   * two choices and ignore the other, which is exactly how the old bug worked, with
   * `<html lang>` reading the cookie while the body read the profile.
   */
  lang: Lang;
  /** Null until the person chooses a language themselves. See migration 0370. */
  language_set_at: string | null;
  /** Explicit consent for transcript text to use the optional cross-border LLM tier. */
  ai_processing_opt_in: boolean;
  ai_processing_opted_in_at: string | null;
  ai_processing_consent_version: string | null;
  ai_processing_withdrawn_at: string | null;
  /** When the person dismissed the AI notice; AI calls are refused until it is set. */
  ai_notice_seen_at: string | null;
  active: boolean;
  /** A test account: never Rapid Rise, never in a real farm or workshop (20261014120000). */
  is_test: boolean;
};

type ProfileRow = Omit<Profile, "lang"> & { language: Locale; tone: Tone };

const PROFILE_COLUMNS_BEFORE_FENCE =
  "id, farm_id, workshop_id, role, name, email, language, tone, language_set_at, " +
  "ai_processing_opt_in, ai_processing_opted_in_at, ai_processing_consent_version, " +
  "ai_processing_withdrawn_at, ai_notice_seen_at, active";
const PROFILE_COLUMNS = `${PROFILE_COLUMNS_BEFORE_FENCE}, is_test`;

/** The authenticated Supabase auth user, or null. Throws when Auth could not answer. */
export async function getUser(): Promise<User | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (authUnanswered(error)) throw new ReadFailed("auth:get-user", { code: error?.name });
  return data.user ?? null;
}

/**
 * Whether this session may use Rapid Rise's powers, asked of the database itself
 * (public.session_is_rapid_rise: the second factor given in this session, and not a test
 * account). Much of what Rapid Rise does in the app runs with the service key, past the
 * database's own rules, so the app takes no other word for it. Cached per request; a call
 * that fails answers no.
 */
export const rapidRiseUnlocked = cache(async (): Promise<boolean> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("session_is_rapid_rise");
    // Still answers no (the safe direction), but we hear of it rather than only the log.
    if (error) captureError(new ReadFailed("auth:session-is-rapid-rise", error), { where: "auth:session-is-rapid-rise" });
    return !error && data === true;
  } catch {
    return false;
  }
});

/** Where a Rapid Rise account goes when this session cannot act as Rapid Rise. */
async function lockPathFor(supabase: SupabaseClient, user: User, profile: Profile): Promise<string> {
  const here = safePath((await headers()).get("x-fw-path") ?? "", "/home");
  return rapidRiseLockPath(profile.is_test, await readAssurance(supabase, user), here);
}

/**
 * This request's client and the user Auth confirmed for it, asked once per request and
 * shared by the profile loader and the two-step check, so the check reads the confirmed
 * user rather than the cookie's copy, at no extra round trip. Throws when Auth could not
 * answer (lib/auth-unanswered): an outage read as "no user" sent a signed-in person to
 * /login?error=no-profile, which says nothing about why.
 */
const confirmedAuth = cache(async (): Promise<{ supabase: SupabaseClient; user: User | null }> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (authUnanswered(error)) throw new ReadFailed("auth:get-user", { code: error?.name });
  return { supabase, user: data.user ?? null };
});

/** The session's two-step assurance (B9), from the user Auth confirmed in this request. */
export const currentAssurance = cache(async (): Promise<Assurance> => {
  const { supabase, user } = await confirmedAuth();
  return user ? readAssurance(supabase, user) : { current: null, next: null };
});

type LoadedProfile = { profile: Profile | null; lock: string | null };

/**
 * The current user's profile, and where to send them instead when it is a Rapid Rise
 * account this session may not act as (no second factor yet, or a test account). Such a
 * profile is never handed to the app at all, so no role check anywhere, in a page, a
 * server action or a route, can take it for Rapid Rise (20261014120000). Before this,
 * several actions checked only the role and then used the service key, which let a
 * password alone past B9's second factor.
 */
const loadProfile = cache(async (): Promise<LoadedProfile> => {
  const { supabase, user } = await confirmedAuth();
  const uid = user?.id;
  if (!user || !uid) return { profile: null, lock: null };
  const { data, error } = await supabase
    .from("users")
    .select(PROFILE_COLUMNS)
    .eq("id", uid)
    .maybeSingle();
  let row = data as ProfileRow | null;
  if (error) {
    console.error(`[auth] profile read failed: ${error.code ?? ""} ${error.message}`);
    // The column missing (code shipped before its migration) must not sign everyone out:
    // read the rest. A Rapid Rise account still gets nothing, because the database check
    // below cannot answer yes until the migration is there too.
    if (error.code === "42703") {
      const retry = must(
        await supabase.from("users").select(PROFILE_COLUMNS_BEFORE_FENCE).eq("id", uid).maybeSingle(),
        "auth:profile-before-fence",
      );
      row = retry ? ({ ...(retry as object), is_test: false } as ProfileRow) : null;
    } else {
      // A failed read is not "no profile": answering null sent a signed-in person to the
      // sign-in page with "no profile", as if their account had gone.
      throw new ReadFailed("auth:profile", error);
    }
  }
  if (!row) return { profile: null, lock: null };
  const language: Locale = isLocale(row.language) ? row.language : defaultLocale;
  const tone: Tone = isTone(row.tone) ? row.tone : defaultTone;
  const profile: Profile = { ...row, is_test: row.is_test === true, language, tone, lang: langOf(language, tone) };
  // Any Rapid Rise profile the database refuses is withheld, a deactivated one included, so
  // no caller has to remember to check `active` before trusting the role. The database is
  // only asked about Rapid Rise accounts.
  if (profile.role === "rr_admin") {
    const verdict = rapidRiseVerdict(profile.role, profile.active, await rapidRiseUnlocked());
    if (verdict === "lock") return { profile: null, lock: await lockPathFor(supabase, user, profile) };
    if (verdict === "withhold") return { profile: null, lock: null };
  }
  return { profile, lock: null };
});

/** The current user's app profile row (public.users), or null. Null as well for a Rapid
 * Rise account this session may not act as (see loadProfile). */
export async function getProfile(): Promise<Profile | null> {
  return (await loadProfile()).profile;
}

/** Redirect to /login unless authenticated. */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Require an active app profile. A logged-in auth user with no profile row (or a
 * deactivated one) is sent back to /login, profiles are created via invites.
 */
export async function requireProfile(): Promise<Profile> {
  const { profile, lock } = await loadProfile();
  if (lock) redirect(lock);
  if (!profile || !profile.active) redirect("/login?error=no-profile");
  return profile;
}

/**
 * Where a role belongs when it has nowhere more specific to be.
 *
 * `requireRole` used to send EVERY denied user to `/dashboard?error=forbidden`. For an
 * operator that is the owner's money page, the one surface a farm can explicitly switch
 * off for operators via `cost_visible_to_operators`, and `error=forbidden` was never
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
      // The Rapid Rise overview: support, clients and health on one screen (2026-10-28).
      return "/admin";
    default:
      return "/dashboard";
  }
}

/**
 * Require the profile to hold one of `roles`, else send them to their OWN home with a
 * flag the destination renders as a plain sentence.
 */
/**
 * Whether a farm may be used now (20261029090100), asked once per request. Server actions
 * and API routes run before any layout, so the layout's billing gate alone left every one
 * of them working for a farm that was pending, suspended or closed. The role helpers below
 * ask this too, so the actions inherit it; the pages a stopped farm may still use (pay,
 * activate, closed, download records) call requireProfile, not these.
 *
 * Fails OPEN, as the layout's gate does: a database hiccup must not lock a paying farm out.
 */
const farmUsable = cache(async (farmId: string): Promise<"ok" | "pending" | "suspended" | "closed"> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("farm_billing_gate", { p_farm: farmId });
    if (error) {
      captureError(new ReadFailed("auth:farm-usable", error), { where: "auth:farm-usable", farmId });
      return "ok";
    }
    return data === "pending" || data === "suspended" || data === "closed" ? data : "ok";
  } catch (error) {
    unstable_rethrow(error);
    captureError(error, { where: "auth:farm-usable", farmId });
    return "ok";
  }
});

/**
 * Where a person goes when the farm they act on may not be used, or null when it may. The
 * page is told WHICH farm (?farm=) whenever it is not the home farm: the stopped pages read
 * it, and without it they looked at the home farm, found it fine, and sent the person
 * back, round and round.
 */
async function stoppedFarmPath(farmId: string | null, homeFarmId?: string | null): Promise<string | null> {
  if (!farmId) return null;
  const state = await farmUsable(farmId);
  const which = farmId !== homeFarmId ? `?farm=${farmId}` : "";
  if (state === "suspended") return `/suspended${which}`;
  if (state === "closed") return `/closed${which}`;
  if (state === "pending") return `/activate${which}`;
  return null;
}

/**
 * Whether a farm may be used now, for a route handler that resolves its own farm (the
 * assistant, fault capture, uploads). Fails open like the rest. Rapid Rise is never stopped.
 */
export async function farmIsUsable(farmId: string, profile?: Profile | null): Promise<boolean> {
  if (profile?.role === "rr_admin") return true;
  return (await farmUsable(farmId)) === "ok";
}

export async function requireRole(roles: Role[]): Promise<Profile> {
  const profile = await requireProfile();
  if (profile.role === "rr_admin" || profile.role === "workshop") {
    if (!roles.includes(profile.role)) {
      redirect(`${homePathFor(profile.role)}?denied=1`);
    }
    return profile;
  }

  // Farm-side roles are contextual. `profiles.role` is the compatibility role for the
  // primary farm; a multi-site user can hold a different role on the selected farm.
  // Returning the selected farm/role also keeps older actions that use the returned
  // profile from accidentally writing back to the primary site.
  const farmId = await currentFarmId(profile);
  const role = farmId ? await effectiveFarmRole(farmId, profile) : null;
  if (!role || !roles.includes(role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }
  const stopped = await stoppedFarmPath(farmId, profile.farm_id);
  if (stopped) redirect(stopped);
  return { ...profile, farm_id: farmId, role };
}

/**
 * `requireRole` for a route the browser calls with `fetch`: the same checks, answered as
 * JSON instead of a redirect.
 *
 * A redirect inside a route handler is followed by `fetch`, so an expired session landed
 * on the login PAGE, which answers 200. The caller read that as success: the invoice email
 * dialog said "Sent to <address>" when nothing had been sent. Here a missing session is
 * 401 and a role that may not act is 403, both with a code the screen can explain.
 */
export async function requireApiRole(
  roles: Role[],
): Promise<{ profile: Profile; denied?: undefined } | { profile?: undefined; denied: Response }> {
  const deny = (status: number, error: string) => ({ denied: Response.json({ error }, { status }) });
  const { profile, lock } = await loadProfile();
  if (lock || !profile || !profile.active) return deny(401, "signed-out");
  if (profile.role === "rr_admin" || profile.role === "workshop") {
    return roles.includes(profile.role) ? { profile } : deny(403, "forbidden");
  }
  const farmId = await currentFarmId(profile);
  const role = farmId ? await effectiveFarmRole(farmId, profile) : null;
  if (!role || !roles.includes(role)) return deny(403, "forbidden");
  // 402: the farm must pay (or is closed) before this works; the screen says so.
  if (farmId && (await farmUsable(farmId)) !== "ok") return deny(402, "farm-not-active");
  return { profile: { ...profile, farm_id: farmId, role } };
}

// == Multi-site "current farm" (F7) ===========================================
// One account can now reach MULTIPLE farms (user_farm_memberships, 0340). The app keeps
// a "current farm" the user is acting in, a cookie choice, validated against the farms
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
  // Throws on failure: an empty list quietly put a person back on their primary farm
  // (currentFarmId) while they believed they were acting in the one they chose.
  const data = must(
    await supabase
      .from("farms")
      .select("id, name")
      .is("deleted_at", null)
      .order("name"),
    "auth:accessible-farms",
  );
  return (data as FarmOption[] | null) ?? [];
}

// == RR support mode (S10) ====================================================
// "Act into farm" used to write an audit row and nothing else: no farm context was set
// and no session state changed, so staff believed they were inside a customer account
// when they were not, and there was no banner or exit because there was no mode to exit.
//
// Support mode is a NARROWING, never a grant. rr_admin already reads every farm through
// `app.is_rr_admin()` in RLS; pinning a farm only scopes what the UI queries, so the
// cookie cannot widen access even if forged, the worst a tampered value can do is show
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
  // must: without the banner an admin still scoped to a customer's farm cannot tell, and
  // the shell grants API tokens from this value.
  const data = must(await supabase.from("farms").select("id, name").eq("id", id).maybeSingle(), "auth:support-farm");
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
    // Only honour a cookie that names a farm this user can genuinely access, never a
    // guessable bypass (RLS would deny the data regardless, but keep the UI honest).
    const farms = await accessibleFarms(p);
    if (farms.some((f) => f.id === chosen)) return chosen;
  }
  return p.farm_id;
}

/**
 * The role this person holds in one specific farm. Multi-site memberships are
 * authoritative for that site; the profile role is only a compatibility fallback for
 * an older primary-farm row that predates the membership backfill.
 */
export async function effectiveFarmRole(
  farmId: string,
  profile?: Profile,
): Promise<Role | null> {
  const p = profile ?? (await requireProfile());
  if (!p.active) return null;
  if (p.role === "rr_admin") return "rr_admin";
  if (p.role === "workshop") return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_farm_memberships")
    .select("role")
    .eq("user_id", p.id)
    .eq("farm_id", farmId)
    .eq("active", true)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error("Farm permissions are temporarily unavailable.");
  const role = (data as { role?: string } | null)?.role;
  if (role && ["owner", "manager", "mechanic", "operator"].includes(role)) {
    return role as Role;
  }

  return farmId === p.farm_id && ["owner", "manager", "mechanic", "operator"].includes(p.role)
    ? p.role
    : null;
}

export type FarmRoleContext = {
  profile: Profile;
  farmId: string;
  role: Role;
};

/**
 * Require one of `roles` on the farm being mutated.
 *
 * `profiles.role` describes the primary farm only. A person can be an owner on that
 * farm and an operator on another one, so action guards must never authorize a row in
 * farm B with the role from farm A. This helper is the single app-side guard for that
 * rule. Database policies remain the final boundary.
 *
 * Workshops do not have `user_farm_memberships`; their access is an active
 * `workshop_link`. When a workshop role is explicitly allowed, the RLS-backed farm read
 * proves that link before the helper returns.
 */
export async function requireFarmRole(
  farmId: string,
  roles: readonly Role[],
  deniedPath?: string,
  existingProfile?: Profile,
): Promise<FarmRoleContext> {
  const profile = existingProfile ?? (await requireProfile());
  let role: Role | null = null;
  // A farm id that is not a uuid (a hand-edited `?farm=`) is no farm of theirs: denied, as
  // before, rather than the error screen Postgres's refusal of it would now raise.
  if (!isUuid(farmId)) redirect(deniedPath ?? `${homePathFor(profile.role)}?denied=1`);

  if (profile.role === "workshop" && roles.includes("workshop")) {
    const supabase = await createClient();
    // A failed read is not "no link": it would have told the partner they were denied.
    const data = must(
      await supabase
        .from("farms")
        .select("id")
        .eq("id", farmId)
        .is("deleted_at", null)
        .maybeSingle(),
      "auth:workshop-farm-link",
    );
    if (data) role = "workshop";
  } else {
    role = await effectiveFarmRole(farmId, profile);
  }

  if (!role || !roles.includes(role)) {
    redirect(deniedPath ?? `${homePathFor(profile.role)}?denied=1`);
  }
  // A contractor too: a suspended or closed farm takes no work from anybody until it pays.
  if (profile.role !== "rr_admin") {
    const stopped = await stoppedFarmPath(farmId, profile.farm_id);
    if (stopped) redirect(profile.role === "workshop" ? `${homePathFor("workshop")}?error=farm-not-active` : stopped);
  }
  return { profile, farmId, role };
}

/** Require a role on the validated farm selected in the current session. */
export async function requireCurrentFarmRole(
  roles: readonly Role[],
  deniedPath?: string,
): Promise<FarmRoleContext> {
  const profile = await requireProfile();
  const farmId = await currentFarmId(profile);
  if (!farmId) redirect(deniedPath ?? `${homePathFor(profile.role)}?denied=1`);
  return requireFarmRole(farmId, roles, deniedPath, profile);
}

// == Entitlement gating (F5) ==================================================
// Feature access is governed by the FARM's subscription plan (src/lib/entitlements.ts,
// mirrored by app.has_entitlement in SQL). Two roles BYPASS plan gates entirely:
//   * rr_admin, FleetWise platform staff (cross-tenant; not the billing subject);
//   * workshop, external contractors who only ever reach a linked farm's data through
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
  // A failed read throws (must): falling back to the cheapest plan showed a paying farm
  // upgrade prompts and refused its downloads with "Upgrade required".
  const data = must(await supabase.from("farms").select("plan").eq("id", farmId).maybeSingle(), "auth:farm-plan");
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
  const farmId = await currentFarmId(p);
  return { profile: p, plan: farmId ? await getFarmPlan(farmId) : null };
}

/** Evaluate an entitlement without redirecting, for pages/nav/inline sections. */
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
 * upgrade prompt), a real server-side denial, not merely hidden UI. Returns the profile
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

// == Partner-plan gating (F12c, reshaped in F14e) =============================
// The two-sided twin of the farm entitlement above: this governs the PARTNER's portal
// by the product they bought (`workshops.plan`, 0382, portal | managed), NOT tenancy -
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
 * Falls back to `portal` if the row is somehow unreadable, the safe direction, since
 * `portal` is the one every partner is entitled to. Reads the real `workshops.plan`
 * column; the map in contractor-plan.ts is the entitlement authority.
 */
export async function workshopPlan(
  profile?: Profile
): Promise<{ profile: Profile; plan: WorkshopPlan | null }> {
  const p = profile ?? (await requireProfile());
  if (p.role !== "workshop" || !p.workshop_id) return { profile: p, plan: null };
  const supabase = await createClient();
  const data = must(
    await supabase.from("workshops").select("plan").eq("id", p.workshop_id).maybeSingle(),
    "auth:workshop-plan",
  );
  const plan = (data as { plan: string } | null)?.plan;
  return { profile: p, plan: plan && isWorkshopPlan(plan) ? plan : "portal" };
}

/**
 * The current partner's full account row, letterhead, business details, document
 * defaults and product, in one read. Returns null for anyone who is not a workshop
 * user. Used by the partner's settings screen, the document builder and the PDF route,
 * all of which need the same row and must not each invent their own column list.
 */
export async function currentWorkshop(
  profile?: Profile
): Promise<{ profile: Profile; workshop: WorkshopBrandingRow | null; plan: WorkshopPlan | null }> {
  const p = profile ?? (await requireProfile());
  if (p.role !== "workshop" || !p.workshop_id) return { profile: p, workshop: null, plan: null };
  const supabase = await createClient();
  const data = must(
    await supabase.from("workshops").select(`${BRANDING_COLUMNS}, kind, area, plan`).eq("id", p.workshop_id).maybeSingle(),
    "auth:current-workshop",
  );
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

/**
 * Enforce a partner entitlement in a SERVER ACTION. The twin of `requireEntitlement` for
 * the farm side, and the reason it exists is the same one F5 recorded: a page that renders
 * an upgrade notice has hidden the screen, not closed the door, the action behind it is
 * still a POST endpoint anybody with the form can reach. `redirectTo` is the surface
 * itself, which renders the notice, so a denied submit lands somewhere that explains
 * itself rather than on a blank error.
 */
export async function requireWorkshopEntitlement(
  feature: WorkshopFeature,
  redirectTo: string,
  profile?: Profile
): Promise<Profile> {
  const { profile: p, allowed } = await checkWorkshopEntitlement(feature, profile);
  if (!allowed) redirect(`${redirectTo}?error=upgrade_required`);
  return p;
}

/**
 * The same rule for an API route, which must answer with a status rather than a
 * redirect, a CSV or PDF endpoint that 302s to an HTML page hands the caller a file
 * full of markup. 403 matches how F5 denied the farm-side report exports.
 */
export async function workshopEntitlementOr403(
  feature: WorkshopFeature,
  profile?: Profile
): Promise<Response | null> {
  const { allowed } = await checkWorkshopEntitlement(feature, profile);
  return allowed ? null : new Response("Forbidden", { status: 403 });
}
