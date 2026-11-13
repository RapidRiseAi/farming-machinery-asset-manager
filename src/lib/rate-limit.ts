import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { captureError } from "@/lib/observability";

/**
 * One request against the signed-in person's limit for a scope, counted in the database
 * (20261014090000) so every server instance shares the count. Each route keeps its
 * in-memory check in front of this: that one is free and stops a runaway loop on the spot;
 * this one is what a loop spread over several instances cannot get around.
 *
 * `supabase` must carry the person's own session: the database builds the key from it, so
 * nobody can spend another person's limit. A database fault lets the request through and is
 * reported: the limit is a guard, and dictation must not stop because a counter could not
 * be written.
 */
export async function takeSharedRateLimit(
  supabase: SupabaseClient,
  scope: string,
  windowSeconds: number,
  max: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  return take(supabase, "rate_limit_take", scope, {
    p_scope: scope,
    p_window_seconds: windowSeconds,
    p_max: max,
  });
}

/**
 * The same count for somebody with no session yet (signing in), keyed by `subject`, a
 * SHA-256 hex digest the server computes (20261113090000; the database refuses anything
 * else, so no address or IP is ever stored). `supabase` is the SERVICE client: only the
 * server may choose a key. Fails open like the one above.
 */
export async function takeKeyedRateLimit(
  supabase: Pick<SupabaseClient, "rpc">,
  scope: string,
  subject: string,
  windowSeconds: number,
  max: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  return take(supabase, "rate_limit_take_key", scope, {
    p_scope: scope,
    p_subject: subject,
    p_window_seconds: windowSeconds,
    p_max: max,
  });
}

async function take(
  supabase: Pick<SupabaseClient, "rpc">,
  fn: string,
  scope: string,
  args: Record<string, string | number>,
): Promise<{ allowed: boolean; retryAfter: number }> {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean; retry_after?: number } | null;
    return { allowed: row?.allowed !== false, retryAfter: Math.max(0, Number(row?.retry_after ?? 0) || 0) };
  } catch (err) {
    captureError(err, { where: `rate_limit:${scope}`, level: "warning" });
    return { allowed: true, retryAfter: 0 };
  }
}
