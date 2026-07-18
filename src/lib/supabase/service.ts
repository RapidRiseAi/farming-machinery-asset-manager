import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv, getServiceRoleKey } from "@/lib/env";

/**
 * Service-role Supabase client. BYPASSES RLS — use ONLY in trusted server code:
 * the public QR routes (which validate an unguessable per-machine token before
 * doing anything) and admin operations. NEVER import this into a client component.
 */
export function createServiceClient() {
  const { url } = getSupabaseEnv();
  const key = getServiceRoleKey();
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
