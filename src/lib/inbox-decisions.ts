/**
 * The inbox NAV badge: how many decisions are waiting on the owner (a quote to accept,
 * an invoice to approve), not how many alerts are unread.
 *
 * The badge used to be `countInboxUnread`, every unread alert, which on a real farm sat at
 * 77 on the Inbox row and on the phone's "More" button on every screen while the inbox
 * itself asked for 3 decisions. A number that never goes down teaches people to ignore
 * badges. Unread alerts now show on the header bell, which is where they are read.
 *
 * Same filter as the inbox page's "Needs your action" card (`INBOX_ACTION_STATUSES`, not
 * soft-deleted, the caller's own farm), as a head-only count under the caller's RLS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { INBOX_ACTION_STATUSES } from "@/lib/inbox";

export async function countInboxDecisions(
  supabase: SupabaseClient,
  farmId: string | null,
): Promise<number> {
  if (!farmId) return 0;
  const { count } = await supabase
    .from("work_requests_visible")
    .select("id", { count: "exact", head: true })
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .in("status", [...INBOX_ACTION_STATUSES]);
  return count ?? 0;
}
