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
