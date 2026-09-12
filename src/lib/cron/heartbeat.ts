import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Recording that a scheduled route ran.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Measured on production before it was written. The NIGHTLY pass is provably firing on
 * Vercel's schedule — 90 `notifications` rows in the 03:00–03:59 UTC window across 14
 * distinct days — but only because those engines happen to WRITE something. The BILLING
 * pass, the one that moves money, writes nothing at all when nothing is due: no invoice,
 * no claim, no receipt, no reminder. Its entire output is a JSON body returned to
 * Vercel's scheduler, which is read by nobody.
 *
 * So a billing cron that has fired every night for six weeks and one that has never fired
 * once produce identical evidence. Every invoice on production was raised by hand, at
 * 11:35, 15:37, 19:39, 21:31 and 21:39 UTC; so was every charge attempt. Nothing
 * unattended has ever been observed from that route.
 *
 * ── The one rule ─────────────────────────────────────────────────────────────
 * THIS MUST NEVER BREAK A PASS. Both calls swallow their errors and return, because
 * telemetry that can stop the thing it watches is worse than no telemetry: a billing run
 * that refused to charge a customer because the heartbeat table was locked would be a
 * self-inflicted outage of the most expensive kind. A missing row is a question mark; a
 * missed charge is money.
 *
 * ── Reachability ─────────────────────────────────────────────────────────────
 * Both names go through `public.*` wrappers, because PostgREST exposes `public` only and
 * an `app.*` function is unreachable over REST no matter how it is granted. That is not a
 * theory: it is what silently broke the entire charging path (suite section (m)), and it
 * is why suite section (z) asserts these two names and their parameter names too.
 */

/** The wrapper names, in one place, so the suite can assert exactly what is called. */
export const CRON_RPC = {
  start: "cron_run_start",
  finish: "cron_run_finish",
  health: "cron_health",
} as const;

/** How the run was triggered. "it works when I run it by hand" is the answer that hides the fault. */
export type CronTrigger = "schedule" | "manual";

/**
 * Open a run row. Returns its id, or null if the ledger could not be written — in which
 * case the pass carries on unrecorded rather than not at all.
 */
export async function startCronRun(
  supabase: SupabaseClient,
  route: string,
  trigger: CronTrigger = "schedule",
): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc(CRON_RPC.start, {
      p_route: route,
      p_trigger: trigger,
    });
    if (error) return null;
    return typeof data === "string" ? data : null;
  } catch {
    return null;
  }
}

/**
 * Close it. A no-op when the row was never opened, so every caller can finish
 * unconditionally without asking whether the start worked.
 */
export async function finishCronRun(
  supabase: SupabaseClient,
  runId: string | null,
  ok: boolean,
  steps: Record<string, string>,
): Promise<void> {
  if (!runId) return;
  try {
    await supabase.rpc(CRON_RPC.finish, { p_run: runId, p_ok: ok, p_steps: steps });
  } catch {
    // Deliberately silent. The pass has already done its work by the time this runs;
    // raising here would turn a successful billing run into a 500 that Vercel retries.
  }
}
