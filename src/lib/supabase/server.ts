import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseEnv } from "@/lib/env";
import { auditContextHeaders } from "@/lib/audit-context";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/** Server Supabase client (anon key + RLS), bound to the request's cookies. */
export async function createClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = getSupabaseEnv();

  // Where an audited write came from (FR-1.4, migration 0510).
  //
  // The audit trigger is database-side and cannot see an HTTP request. IP and user agent
  // reach Postgres on their own through PostgREST's `request.headers` — Supabase's edge
  // sets `x-forwarded-for` and the browser sends `user-agent`. Geo does not: Vercel's
  // `x-vercel-ip-*` headers are on the request to VERCEL, and stop there. This one header
  // carries them the rest of the way.
  //
  // Empty off Vercel, in local dev and in the tests, so the client is byte-identical to
  // before wherever the edge said nothing. It is client-supplied and trusted for nothing
  // but the location columns: `user_id` still comes from `auth.uid()`, and no policy or
  // helper reads the `fleetwise.*` namespace — G33 asserts both structurally.
  const global = { headers: await auditContextHeaders() };

  return createServerClient(url, anonKey, {
    global,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component — cookies are read-only here.
          // The middleware refreshes the session cookie instead.
        }
      },
    },
  });
}
