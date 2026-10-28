import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { must, mustAll } from "@/lib/supabase/must";
import { readAll } from "@/lib/supabase/read-all";
import type { Commitment } from "@/lib/asset-finance";

/**
 * Reading finance agreements, their schedules, contracts and their documents for a screen.
 *
 * Every read goes through the caller's own client, so RLS (owners and managers only,
 * `app.can_view_farm_finance`, 20261028110100) decides what comes back. A failed read is
 * the error screen (`must`), never an empty list: "no finance" on a farm that owes the bank
 * R1 000 000 is the most dangerous wrong answer this screen could give.
 */

export type AgreementRow = {
  id: string;
  farm_id: string;
  machine_id: string;
  kind: string;
  lender: string;
  agreement_number: string | null;
  principal_cents: number;
  deposit_cents: number;
  interest_rate_bps: number;
  term_months: number;
  frequency: string;
  instalment_cents: number | null;
  fee_cents: number;
  balloon_cents: number;
  start_date: string;
  first_instalment_date: string;
  end_date: string | null;
  auto_mark_paid: boolean;
  status: string;
  settled_on: string | null;
  settlement_cents: number | null;
  settlement_charge_cents: number | null;
  statement_balance_cents: number | null;
  statement_balance_on: string | null;
  reminder_lead_days: number | null;
  notes: string | null;
  migrated_from_machine: boolean;
};

export type InstalmentRow = {
  id: string;
  agreement_id: string;
  seq: number;
  kind: string;
  due_date: string;
  interest_cents: number;
  capital_cents: number;
  fee_cents: number;
  amount_cents: number;
  balance_after_cents: number;
  status: string;
  paid_cents: number;
  paid_on: string | null;
  payment_reference: string | null;
};

export type SummaryRow = {
  agreement_id: string;
  instalments: number;
  instalments_paid: number;
  paid_cents: number;
  capital_paid_cents: number;
  outstanding_capital_cents: number;
  remaining_cents: number;
  interest_total_cents: number;
  interest_to_date_cents: number;
  overdue_count: number;
  overdue_cents: number;
  next_seq: number | null;
  next_kind: string | null;
  next_due_date: string | null;
  next_due_cents: number | null;
  last_paid_on: string | null;
  balance_cents: number;
  balance_source: "schedule" | "statement" | "closed";
};

export type ContractRow = {
  id: string;
  farm_id: string;
  machine_id: string | null;
  kind: string;
  party: string;
  reference: string | null;
  start_date: string;
  end_date: string | null;
  amount_cents: number;
  vat_rate_bps: number;
  frequency: string;
  first_payment_date: string | null;
  auto_renews: boolean;
  renewal_months: number | null;
  notice_days: number | null;
  notice_date: string | null;
  post_costs: boolean;
  status: string;
  reminder_lead_days: number | null;
  notes: string | null;
};

export type FinanceDoc = {
  id: string;
  parent_type: "finance_agreement" | "asset_contract";
  parent_id: string;
  storage_path: string | null;
  created_at: string;
};

export const AGREEMENT_COLUMNS =
  "id, farm_id, machine_id, kind, lender, agreement_number, principal_cents, deposit_cents, interest_rate_bps, " +
  "term_months, frequency, instalment_cents, fee_cents, balloon_cents, start_date, first_instalment_date, end_date, " +
  "auto_mark_paid, status, settled_on, settlement_cents, settlement_charge_cents, statement_balance_cents, " +
  "statement_balance_on, reminder_lead_days, notes, migrated_from_machine";

const INSTALMENT_COLUMNS =
  "id, agreement_id, seq, kind, due_date, interest_cents, capital_cents, fee_cents, amount_cents, " +
  "balance_after_cents, status, paid_cents, paid_on, payment_reference";

const CONTRACT_COLUMNS =
  "id, farm_id, machine_id, kind, party, reference, start_date, end_date, amount_cents, vat_rate_bps, frequency, " +
  "first_payment_date, auto_renews, renewal_months, notice_days, notice_date, post_costs, status, " +
  "reminder_lead_days, notes";

/**
 * May the caller see finance on this farm? The database's answer (`can_view_farm_finance`),
 * never a role read some other way. Fails CLOSED: a failed check hides the section, it never
 * shows it to somebody it should not.
 */
export async function canViewFarmFinance(
  supabase: SupabaseClient,
  farmId: string | null | undefined,
): Promise<boolean> {
  if (!farmId) return false;
  const { data, error } = await supabase.rpc("can_view_farm_finance", { p_farm: farmId });
  return !error && data === true;
}

export type FinanceBook = {
  agreements: AgreementRow[];
  instalments: InstalmentRow[];
  summaries: Map<string, SummaryRow>;
  contracts: ContractRow[];
  docs: FinanceDoc[];
};

/**
 * One farm's finance book, or one machine's part of it (`machineId`). Farm-wide contracts
 * (no machine) are included on the farm page only. `today` is the farm's date, passed so
 * the summaries' "overdue" agrees with the rest of the page.
 */
export async function readFinanceBook(
  supabase: SupabaseClient,
  farmId: string,
  today: string,
  machineId?: string,
): Promise<FinanceBook> {
  let agreementQuery = supabase
    .from("finance_agreements")
    .select(AGREEMENT_COLUMNS)
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .order("start_date", { ascending: false });
  let contractQuery = supabase
    .from("asset_contracts")
    .select(CONTRACT_COLUMNS)
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .order("start_date", { ascending: false });
  if (machineId) {
    agreementQuery = agreementQuery.eq("machine_id", machineId);
    contractQuery = contractQuery.eq("machine_id", machineId);
  }

  const results = await Promise.all([
    agreementQuery,
    contractQuery,
    supabase.rpc("finance_agreement_summaries", { p_farm: farmId, p_today: today }),
  ]);
  mustAll(results, "finance:book");
  const agreements = (results[0].data as unknown as AgreementRow[] | null) ?? [];
  const contracts = (results[1].data as unknown as ContractRow[] | null) ?? [];
  const summaryRows = (results[2].data as SummaryRow[] | null) ?? [];

  const agreementIds = agreements.map((a) => a.id);
  // Every row of every schedule: a balance summed from part of a schedule is wrong.
  const instalments = agreementIds.length
    ? ((must(
        await readAll(() =>
          supabase
            .from("finance_instalments")
            .select(INSTALMENT_COLUMNS)
            .in("agreement_id", agreementIds)
            .is("deleted_at", null)
            .order("agreement_id")
            .order("seq"),
        ),
        "finance:instalments",
      ) as unknown as InstalmentRow[] | null) ?? [])
    : [];

  const parentIds = [...agreementIds, ...contracts.map((c) => c.id)];
  const docs = parentIds.length
    ? ((must(
        await readAll(() =>
          supabase
            .from("attachments")
            .select("id, parent_type, parent_id, storage_path, created_at")
            .eq("farm_id", farmId)
            .in("parent_type", ["finance_agreement", "asset_contract"])
            .in("parent_id", parentIds)
            .is("deleted_at", null)
            .order("created_at", { ascending: false }),
        ),
        "finance:documents",
      ) as unknown as FinanceDoc[] | null) ?? [])
    : [];

  return {
    agreements,
    instalments,
    summaries: new Map(summaryRows.map((s) => [s.agreement_id, s])),
    contracts,
    docs,
  };
}

/** What the farm has committed to pay between two days (cash, not cost). */
export async function readCommitments(
  supabase: SupabaseClient,
  farmId: string,
  from: string,
  to: string,
): Promise<Commitment[]> {
  const data = must(
    await supabase.rpc("farm_finance_commitments", { p_farm: farmId, p_from: from, p_to: to }),
    "finance:commitments",
  );
  return (data as Commitment[] | null) ?? [];
}
