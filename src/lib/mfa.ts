import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Two-step sign-in (B9). An authenticator app's six-digit code on top of the password, per
 * the founder's decision of 2026-10-13: REQUIRED for Rapid Rise staff, whose account reaches
 * every farm, and offered to everyone else on the account page.
 *
 * Supabase marks a session `aal1` after a password and `aal2` once a code from a verified
 * factor has been given in it. `next` is what the session could reach: `aal2` as soon as the
 * person has a verified factor.
 */
export type Assurance = { current: "aal1" | "aal2" | null; next: "aal1" | "aal2" | null };

/**
 * Where a signed-in person must go before the app: `verify` when they have set up a code and
 * have not given it this session; `setup` when they are Rapid Rise staff and have not set one
 * up yet; null to carry on. Unknown assurance (the read failed) never locks anyone out on its
 * own: the database refuses Rapid Rise's powers without `aal2` regardless.
 */
export function mfaGate(role: string | null | undefined, assurance: Assurance): "verify" | "setup" | null {
  if (assurance.current === "aal2") return null;
  if (assurance.next === "aal2") return "verify";
  if (role === "rr_admin" && assurance.current === "aal1") return "setup";
  return null;
}

/**
 * What the profile loader does with a profile (20261014120000): hand it to the app; withhold
 * it and send the session elsewhere (an active Rapid Rise account this session may not act
 * as); or withhold it quietly (a deactivated one, which has nowhere to be sent). Only a Rapid
 * Rise role is ever held back, and only when the database said no.
 */
export function rapidRiseVerdict(role: string, active: boolean, unlocked: boolean): "allow" | "lock" | "withhold" {
  if (role !== "rr_admin" || unlocked) return "allow";
  return active ? "lock" : "withhold";
}

/**
 * Where a Rapid Rise account goes when the database will not treat this session as Rapid
 * Rise (20261014120000): a test account to the page that says so; anyone else to the code
 * step they still owe. A session that gave its code and was refused all the same means the
 * answer could not be read, so it goes to sign-in with an error, never anywhere it could act.
 * `here` is where to come back to.
 */
export function rapidRiseLockPath(isTest: boolean, assurance: Assurance, here: string): string {
  if (isTest) return "/test-account";
  const step = mfaGate("rr_admin", assurance);
  if (!step) return "/login?error=mfa-required";
  return `/mfa/${step}?next=${encodeURIComponent(here)}`;
}

/** Supabase types the level as an open string; anything but the two known values is unknown. */
function level(value: string | null | undefined): "aal1" | "aal2" | null {
  return value === "aal1" || value === "aal2" ? value : null;
}

/** The session's assurance, read from its own token: no network call. */
export async function readAssurance(supabase: SupabaseClient): Promise<Assurance> {
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return { current: null, next: null };
    return { current: level(data.currentLevel), next: level(data.nextLevel) };
  } catch {
    return { current: null, next: null };
  }
}

/** A six-digit code, spaces and dashes allowed in between, as authenticator apps show it. */
export function cleanCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}
