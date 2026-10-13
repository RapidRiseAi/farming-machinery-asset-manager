import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { readAll, type ReadAllResult } from "@/lib/supabase/read-all";

/**
 * Statements of account, every line, page after page in the statement's own order
 * (20261013100000): the balance brought forward, then each day's charges, then its
 * settlements. One read stopped at the API's thousandth line, and the balance summed from a
 * statement that ended part-way disagreed with the outstanding total beside it.
 */

export function readPartnerStatement<T>(
  supabase: SupabaseClient,
  args: { p_workshop: string; p_farm: string | null; p_client: string | null; p_from: string; p_to: string },
): Promise<ReadAllResult<T>> {
  return readAll<T>(
    () => supabase.rpc("partner_statement", args).order("entry_date").order("sort_rank").order("kind"),
    { key: "entry_id" },
  );
}

export function readSupplierStatement<T>(
  supabase: SupabaseClient,
  args: { p_workshop: string; p_supplier: string; p_from: string; p_to: string },
): Promise<ReadAllResult<T>> {
  return readAll<T>(
    () =>
      supabase
        .rpc("supplier_statement", args)
        .order("entry_date")
        .order("sort_rank")
        .order("reference", { ascending: true, nullsFirst: false }),
    { key: "expense_id" },
  );
}
