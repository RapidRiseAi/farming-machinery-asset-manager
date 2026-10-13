import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deliverPush,
  BATCH as PUSH_BATCH,
  RUN_BUDGET_MS as PUSH_PASS_MS,
  type DeliverResult,
} from "@/lib/push/deliver";
import {
  deliverNotificationEmail,
  BATCH as EMAIL_BATCH,
  RUN_BUDGET_MS as EMAIL_PASS_MS,
  type EmailDeliverResult,
} from "@/lib/notifications/email-deliver";

/**
 * Push and email delivery, batch after batch, until both queues are empty or time is up.
 *
 * Each pass claims at most 25 notifications (a five-minute lease, so a crashed pass is
 * retried). Run once a night, that was the most that left in a day: a busy morning's
 * reminders waited for the next night, 25 at a time. This keeps passing while either
 * channel came back full, and starts a new round only if a whole pass still fits before
 * the deadline, so the function is never cut off with claims in flight. It is what the
 * every-minute scheduler calls (/api/push/send) and what the nightly run calls after
 * enqueueing.
 */

export type DrainResult = {
  ok: boolean;
  rounds: number;
  /** A channel came back full when time ran out: more is probably waiting. */
  more: boolean;
  push: DeliverResult;
  email: EmailDeliverResult;
};

type Deps = {
  push: (supabase: SupabaseClient) => Promise<DeliverResult>;
  email: (supabase: SupabaseClient) => Promise<EmailDeliverResult>;
  now: () => number;
};

const ROUND_MS = Math.max(PUSH_PASS_MS, EMAIL_PASS_MS);

export async function drainNotifications(
  supabase: SupabaseClient,
  budgetMs: number,
  deps: Deps = { push: deliverPush, email: deliverNotificationEmail, now: Date.now },
): Promise<DrainResult> {
  const deadline = deps.now() + budgetMs;
  const push: DeliverResult = { ok: true, scanned: 0, pushed: 0, failed: 0, pruned: 0, deferred: 0 };
  const email: EmailDeliverResult = { ok: true, scanned: 0, sent: 0, failed: 0, skippedRows: 0, deferred: 0 };
  let rounds = 0;
  let pushMore = true;
  let emailMore = true;

  while ((pushMore || emailMore) && (rounds === 0 || deps.now() + ROUND_MS <= deadline)) {
    rounds += 1;
    if (pushMore) {
      // Each channel on its own: one that throws stops only itself, as the separate steps
      // this replaced did, so a push fault never costs the night its email.
      const p = await deps.push(supabase).catch((err: unknown): DeliverResult => ({
        ok: false, error: err instanceof Error ? err.message : "push-threw",
        scanned: 0, pushed: 0, failed: 1, pruned: 0, deferred: 0,
      }));
      push.scanned += p.scanned; push.pushed += p.pushed; push.failed += p.failed;
      push.pruned += p.pruned; push.deferred += p.deferred;
      if (!p.ok) { push.ok = false; push.error ??= p.error; }
      if (p.skipped) push.skipped = p.skipped;
      // Stop on a short batch, a skip (not configured), or a failed claim: hammering a
      // failing claim every few seconds helps nobody.
      pushMore = p.ok && !p.skipped && p.scanned >= PUSH_BATCH;
    }
    if (emailMore) {
      const e = await deps.email(supabase).catch((err: unknown): EmailDeliverResult => ({
        ok: false, error: err instanceof Error ? err.message : "email-threw",
        scanned: 0, sent: 0, failed: 1, skippedRows: 0, deferred: 0,
      }));
      email.scanned += e.scanned; email.sent += e.sent; email.failed += e.failed;
      email.skippedRows += e.skippedRows; email.deferred += e.deferred;
      if (!e.ok) { email.ok = false; email.error ??= e.error; }
      if (e.skipped) email.skipped = e.skipped;
      emailMore = e.ok && !e.skipped && e.scanned >= EMAIL_BATCH;
    }
  }
  return { ok: push.ok && email.ok, rounds, more: pushMore || emailMore, push, email };
}
