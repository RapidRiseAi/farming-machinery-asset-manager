import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { JournalLine } from "@/lib/accounting";
import { readAll, type ReadAllResult } from "@/lib/supabase/read-all";

/** Lines one journal read may carry before it is refused: more than a year of a very large
 *  farm. Past this the caller asks for a shorter period rather than getting part of it. */
export const JOURNAL_MAX_LINES = 100_000;

export type JournalRead =
  | { scope: "partner"; workshopId: string; from: string; to: string }
  | { scope: "farm"; farmId: string; from: string; to: string };

/**
 * Every line of a general journal (0510), page after page in the journal's own order: date,
 * transaction, line. The functions return two to four lines for every transaction and a
 * cost entry for every fuel draw, so a month of a busy farm is thousands of lines. One read
 * stopped at the API's thousandth, possibly between a debit and its contra, and the export
 * an accountant imported then did not balance, with nothing to say so.
 */
export function readJournal(supabase: SupabaseClient, read: JournalRead): Promise<ReadAllResult<JournalLine>> {
  return readAll<JournalLine>(
    () =>
      (read.scope === "partner"
        ? supabase.rpc("partner_journal", { p_workshop: read.workshopId, p_from: read.from, p_to: read.to })
        : supabase.rpc("farm_journal", { p_farm: read.farmId, p_from: read.from, p_to: read.to })
      )
        .order("entry_date")
        .order("entry_key"),
    { key: "line_no", maxRows: JOURNAL_MAX_LINES },
  );
}
