import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What the fleet is worth now.
 *
 * ── This is a BOOK value, not a tax calculation ──────────────────────────────
 * Said here as well as in the migration and on the screen, because the two are easy to
 * confuse and expensive to confuse. SARS capital allowances for farming assets follow
 * their own rules and apportionments and are the accountant's work. What this reads is the
 * ordinary book value under a policy the farm sets for itself.
 *
 * ── Why there is no arithmetic in this file ──────────────────────────────────
 * Every other money rule in this product is mirrored in TypeScript and pinned to the SQL
 * by a test, because a screen and an engine disagreeing about a figure is this project's
 * most expensive recurring bug. Here the inputs — purchase price, rate, residual — are
 * withheld from `authenticated` at the COLUMN level on purpose, so the browser side cannot
 * hold them and there is nothing to mirror. `public.farm_book_values` does the sum where
 * the inputs live and hands back the answer; duplicating it here would mean shipping the
 * cost columns to the client to feed it, which is the thing 20260903074350 exists to
 * prevent.
 */

export type BookValueRow = {
  machine_id: string;
  name: string;
  reg_no: string | null;
  type: string;
  status: string;
  purchase_date: string | null;
  purchase_price_cents: number | null;
  method: "none" | "straight_line" | "reducing_balance";
  rate_bps: number | null;
  life_months: number | null;
  residual_value_cents: number | null;
  start_date: string | null;
  months_held: number | null;
  book_value_cents: number | null;
  depreciated_cents: number | null;
};

/**
 * The asset register for a farm on a date.
 *
 * Returns `[]` for denial as well as for an empty farm, which is the fail-closed answer
 * for both: the function is caller-scoped in the database and a caller who may not see
 * costs is given no rows rather than an error to interpret.
 */
export async function readBookValues(
  supabase: SupabaseClient,
  farmId: string | null | undefined,
  on?: string,
): Promise<BookValueRow[]> {
  if (!farmId) return [];
  const { data, error } = await supabase.rpc("farm_book_values", {
    p_farm: farmId,
    p_on: on ?? null,
  });
  return error ? [] : ((data as BookValueRow[] | null) ?? []);
}

// `registerTotals` and `policyLabel` live in `./depreciation-view` — they are pure and
// this module is `server-only`, which a test process cannot import. Re-exported here so
// the page has one import and the rules have a test.
export { registerTotals, policyLabel } from "./depreciation-view";
