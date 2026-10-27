/**
 * Owner/manager activity inbox (F13), shared helpers so the nav badge and the inbox
 * page agree on what "unread" means. The inbox is farm-scoped; every query below runs
 * under the caller's RLS (no service role), so it only ever sees the caller's own farm.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { soft } from "@/lib/supabase/must";

/** Statuses where the ball is in the OWNER's court (they must accept / approve). */
export const INBOX_ACTION_STATUSES = ["quoted", "invoiced"] as const;

/**
 * Count of the caller's currently-deliverable unread alerts, the number shown on the
 * inbox nav badge. Mirrors the in-app centre's deliverability filter (`deliver_after`
 * null or already passed) so held-back quiet-hours rows don't inflate the badge.
 */
export async function countInboxUnread(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const nowIso = new Date().toISOString();
  const result = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", null)
    .is("deleted_at", null)
    .or(`deliver_after.is.null,deliver_after.lte.${nowIso}`);
  // soft: a badge the shell draws on every page. A failure is reported and shows no badge,
  // rather than taking every screen down; the alerts themselves are on their own page.
  soft(result, "inbox:unread-count");
  return result.count ?? 0;
}
