import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { JournalLine } from "@/lib/accounting";
import { readAll, type ReadAllResult } from "@/lib/supabase/read-all";
import { JOURNAL_MAX_LINES } from "@/lib/limits";

/** Lines one journal read may carry before it is refused: more than a year of a very large
 *  farm. Past this the caller asks for a shorter period rather than getting part of it. */
export { JOURNAL_MAX_LINES };

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

export type JournalSummary = {
  totals: { debit: number; credit: number; entries: number; lines: number; unbalanced: string[]; unbalancedCount: number };
  accounts: { key: string; code: string; debit: number; credit: number; net: number }[];
};

/**
 * The totals and the per-account summary of a journal period, summed in the database
 * (20261119140000) rather than by reading every line into the server. The same journal
 * functions underneath, as the caller, so the same permissions decide.
 */
export async function readJournalSummary(
  supabase: SupabaseClient,
  read: JournalRead,
): Promise<{ data: JournalSummary | null; error: unknown }> {
  const args = read.scope === "partner"
    ? { p_workshop: read.workshopId, p_from: read.from, p_to: read.to }
    : { p_farm: read.farmId, p_from: read.from, p_to: read.to };
  const prefix = read.scope === "partner" ? "partner" : "farm";
  const [totals, accounts] = await Promise.all([
    supabase.rpc(`${prefix}_journal_totals`, args).maybeSingle(),
    supabase.rpc(`${prefix}_journal_accounts`, args),
  ]);
  if (totals.error) return { data: null, error: totals.error };
  if (accounts.error) return { data: null, error: accounts.error };
  const t = (totals.data ?? {}) as Partial<{ debit_cents: number; credit_cents: number; entries: number; lines: number; unbalanced_count: number; unbalanced: string[] }>;
  const rows = (accounts.data ?? []) as { account_key: string; account_code: string; debit_cents: number; credit_cents: number }[];
  return {
    data: {
      totals: {
        debit: Number(t.debit_cents ?? 0),
        credit: Number(t.credit_cents ?? 0),
        entries: Number(t.entries ?? 0),
        lines: Number(t.lines ?? 0),
        unbalanced: t.unbalanced ?? [],
        unbalancedCount: Number(t.unbalanced_count ?? 0),
      },
      accounts: rows
        .map((r) => ({ key: r.account_key, code: r.account_code, debit: Number(r.debit_cents), credit: Number(r.credit_cents), net: Number(r.debit_cents) - Number(r.credit_cents) }))
        .sort((a, b) => a.code.localeCompare(b.code) || a.key.localeCompare(b.key)),
    },
    error: null,
  };
}
