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

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "FarmGear";
