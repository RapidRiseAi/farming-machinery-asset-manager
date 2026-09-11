/**
 * Environment access. Getters throw only when *called* (at request time), never at
 * import/build time — so `next build` succeeds without a configured .env, and a
 * missing variable fails loudly where it is actually needed.
 */

export function getSupabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (see .env.example)."
    );
  }
  return { url, anonKey };
}

/** Server-only. Never import this into a client component. */
export function getServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY (server-only; see .env.example).");
  }
  return key;
}

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "FleetWise";

/**
 * Our own origin, from CONFIGURATION ONLY — never from a request header.
 *
 * Several places in the app build a redirect from `headers().get("origin")` with
 * `NEXT_PUBLIC_SITE_URL` as a fallback, and for a redirect back to the page you came from
 * that is fine. For a link we put in an EMAIL it is not: `Origin` is supplied by the
 * caller, so a request made with a forged one would have us send the victim a link to
 * somebody else's domain, over our name, from our verified sending address. That is a
 * phishing email we wrote ourselves.
 *
 * Returns null rather than guessing when it is unset or not a real http(s) URL, so a caller
 * has to decide what to do about it instead of emailing "undefined/verify/…".
 */
export function siteUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}
