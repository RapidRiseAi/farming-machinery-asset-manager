import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssistantMachine } from "./types";
import { THREAD_COLUMNS, THREAD_LIMIT, toThreadEntry, type ThreadEntry, type ThreadRow } from "./thread";

/**
 * The signed-in person's recent assistant exchanges on one farm, oldest first.
 *
 * MUST be given the request-scoped client. `ai_interactions_sel` limits rows to
 * `user_id = auth.uid()` on a farm the caller may access, and that policy is the
 * access control for this read. `store.ts` uses the service client because it
 * WRITES; reusing that here would bypass the one rule that makes history safe,
 * and nothing at the call site would show it.
 *
 * The `farm_id` and `user_id` filters are not the security boundary — RLS is —
 * but they scope the thread to the farm the shell is showing (RLS alone would
 * return every accessible farm) and keep an rr_admin's own history their own.
 *
 * Erased rows never arrive: the POPIA erasure sets `deleted_at`, and both the
 * policy and this query exclude it.
 *
 * A failure returns an empty thread. History is a convenience; the assistant
 * must still open when this read cannot be served.
 */
export async function loadAssistantThread(
  supabase: SupabaseClient,
  farmId: string,
  userId: string,
  machines: AssistantMachine[],
  limit = THREAD_LIMIT,
): Promise<ThreadEntry[]> {
  const { data, error } = await supabase
    .from("ai_interactions")
    .select(THREAD_COLUMNS)
    .eq("farm_id", farmId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];

  const now = new Date();
  return (data as unknown as ThreadRow[]).map((row) => toThreadEntry(row, machines, now)).reverse();
}
