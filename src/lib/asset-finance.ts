/**
 * Machinery finance and lease tracking: the arithmetic, the vocabulary and the decisions,
 * in one module the screens, the form preview and the tests share.
 *
 * Pure: no database, no React, no `server-only`, so the agreement form can preview a
 * schedule in the browser with exactly the code the tests check.
 *
 * == The schedule is the database's =========================================
 * `app.finance_schedule` (20261028110300) builds the schedule a farm sees; this file
 * MIRRORS it for the live preview. Both are asserted against the same worked examples
 * (asset-finance.test.ts and supabase/tests/asset_finance.sql), the rule CLAUDE.md sets
 * for a figure computed in SQL and in TypeScript.
 *
 * == Capital is never a cost =================================================
 * A financed machine carries its whole price once, as its 'purchase' cost entry. Repaying
 * the loan pays for the same machine again, so only what the credit costs (interest and
 * the service fee) is booked as a cost, and capital, the deposit and the balloon are not.
 * `instalmentCostCents` states the rule; `app.sync_asset_finance_costs` (20261028110400)
 * applies it to the ledger. The cash-flow view is the other question (money leaving the
 * bank) and counts every rand of an instalment.
 */

import type { Feature } from "@/lib/entitlements";

// == Decisions, as constants =================================================

/**
 * Who may see finance agreements, leases and their documents. Founder default (the
 * question was left open): owners and managers only. The database is the authority
 * (`app.can_view_farm_finance`); this list only decides what the screens offer, and must
 * be changed together with that function.
 */
export const FINANCE_ROLES = ["owner", "manager"] as const;

/**
 * Finance and contract tracking is core, on every plan (founder default). Only the
 * cash-flow export (CSV and workbook) sits behind a plan feature; set this to another
 * feature, or move the screens behind one, if the plan review decides otherwise.
 */
export const FINANCE_EXPORT_FEATURE: Feature = "advanced_reports";

/** Reminder lead days when an agreement or contract is first captured. */
export const DEFAULT_INSTALMENT_LEAD_DAYS = 7;
export const DEFAULT_CONTRACT_LEAD_DAYS = 30;
/** How far back an unpaid instalment still earns one "overdue" reminder (mirrors SQL). */
export const OVERDUE_REMINDER_WINDOW_DAYS = 14;
/** The window of the "coming up" list on the Finance page. */
export const UPCOMING_WINDOW_DAYS = 90;
/** The cash-flow view and its export run this many months ahead. */
export const CASHFLOW_MONTHS = 12;

export function isFinanceRole(role: string | null | undefined): boolean {
  return role === "rr_admin" || (FINANCE_ROLES as readonly string[]).includes(role ?? "");
}

// == Vocabulary (mirrors the check constraints in 20261028110100) =============

export const AGREEMENT_KINDS = ["instalment_sale", "loan", "finance_lease", "other"] as const;
export type AgreementKind = (typeof AGREEMENT_KINDS)[number];

export const AGREEMENT_FREQUENCIES = ["monthly", "quarterly", "biannual", "annual"] as const;
export type AgreementFrequency = (typeof AGREEMENT_FREQUENCIES)[number];

export const AGREEMENT_STATUSES = ["active", "settled", "cancelled"] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

export const INSTALMENT_STATUSES = ["open", "paid", "settled"] as const;
export type InstalmentStatus = (typeof INSTALMENT_STATUSES)[number];

export const CONTRACT_KINDS = [
  "operating_lease",
  "rental",
  "service_contract",
  "maintenance_plan",
  "extended_warranty",
  "insurance",
  "other",
] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

export const CONTRACT_FREQUENCIES = ["monthly", "quarterly", "biannual", "annual", "once"] as const;
export type ContractFrequency = (typeof CONTRACT_FREQUENCIES)[number];

export const CONTRACT_STATUSES = ["active", "ended", "cancelled"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export function isAgreementKind(v: string): v is AgreementKind {
  return (AGREEMENT_KINDS as readonly string[]).includes(v);
}
export function isAgreementFrequency(v: string): v is AgreementFrequency {
  return (AGREEMENT_FREQUENCIES as readonly string[]).includes(v);
}
export function isContractKind(v: string): v is ContractKind {
  return (CONTRACT_KINDS as readonly string[]).includes(v);
}
export function isContractFrequency(v: string): v is ContractFrequency {
  return (CONTRACT_FREQUENCIES as readonly string[]).includes(v);
}

// == Dates, in strings (never `Date`, which carries the server's timezone) ====

/** Months between payments; null for a once-off payment or an unknown frequency. */
export function stepMonths(frequency: string): number | null {
  switch (frequency) {
    case "monthly":
      return 1;
    case "quarterly":
      return 3;
    case "biannual":
      return 6;
    case "annual":
      return 12;
    default:
      return null;
  }
}

function daysIn(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * `YYYY-MM-DD` plus some months, clamped to the month's last day: Postgres's own rule for
 * `date + interval 'n months'`, which the SQL schedule uses. Always count from the FIRST
 * date (31 Jan + 2 months is 31 Mar, not 28 Mar).
 */
export function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(d, daysIn(year, month));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` minus days, without a Date. */
export function minusDays(ymd: string, days: number): string {
  let [y, m, d] = ymd.split("-").map(Number);
  d -= days;
  while (d < 1) {
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    d += daysIn(y, m);
  }
  while (d > daysIn(y, m)) {
    d -= daysIn(y, m);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The last day to give notice: the end date less the notice days (the generated column). */
export function noticeDate(endDate: string | null, noticeDays: number | null): string | null {
  return endDate && noticeDays != null ? minusDays(endDate, noticeDays) : null;
}

// == Money arithmetic (integer cents, half up, as the SQL does) ===============

/** round(n / d) half up, exactly, for non-negative integers. */
function divHalfUp(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

/** The interest one period charges on `balance`: round(balance x rate x months / 120000). */
export function periodInterest(balanceCents: number, rateBps: number, step: number): number {
  if (balanceCents <= 0 || rateBps <= 0) return 0;
  return Number(divHalfUp(BigInt(balanceCents) * BigInt(rateBps) * BigInt(step), 120000n));
}

/**
 * The instalment (interest plus capital, no fee) that repays `principal` less a balloon.
 * Mirrors `app.finance_annuity_payment`. At 0% the capital is spread evenly.
 */
export function annuityPayment(
  principalCents: number,
  rateBps: number,
  count: number,
  step: number,
  balloonCents = 0,
): number {
  if (count < 1) return 0;
  if (rateBps === 0) return Number(divHalfUp(BigInt(principalCents - balloonCents), BigInt(count)));
  const i = (rateBps * step) / 120000;
  const v = Math.pow(1 + i, -count);
  return Math.round(((principalCents - balloonCents * v) * i) / (1 - v));
}

/**
 * The whole basis point whose annuity is closest to a lender's instalment (fee excluded),
 * or null when no rate from 0% to 100% gives it. Mirrors `app.finance_implied_rate_bps`.
 */
export function impliedRateBps(
  principalCents: number,
  paymentCents: number,
  count: number,
  step: number,
  balloonCents = 0,
): number | null {
  if (paymentCents <= 0) return null;
  const pay = (bps: number) => annuityPayment(principalCents, bps, count, step, balloonCents);
  if (paymentCents < pay(0) || paymentCents > pay(10000)) return null;
  let lo = 0;
  let hi = 10000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (pay(mid) < paymentCents) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(pay(lo - 1) - paymentCents) <= Math.abs(pay(lo) - paymentCents)) return lo - 1;
  return lo;
}

export type ScheduleRow = {
  seq: number;
  kind: "instalment" | "balloon";
  dueDate: string;
  interestCents: number;
  capitalCents: number;
  feeCents: number;
  amountCents: number;
  balanceAfterCents: number;
};

/** Why a schedule cannot be built: the same slugs the SQL raises (and errors.ts maps). */
export type ScheduleError =
  | "finance-schedule-invalid"
  | "finance-term-frequency"
  | "finance-balloon-too-large"
  | "finance-rate-or-instalment"
  | "finance-instalment-too-low"
  | "finance-instalment-too-high"
  | "finance-instalment-mismatch";

export type ScheduleInput = {
  principalCents: number;
  /** Null: implied from `instalmentCents`. */
  rateBps: number | null;
  termMonths: number;
  frequency: string;
  firstDate: string;
  balloonCents?: number;
  /** The lender's own instalment, service fee included. */
  instalmentCents?: number | null;
  feeCents?: number;
};

export type ScheduleResult =
  | { ok: true; rows: ScheduleRow[]; rateBps: number; paymentCents: number }
  | { ok: false; error: ScheduleError };

/**
 * The schedule `app.finance_schedule` would build for a new agreement (first row seq 1).
 * The last instalment absorbs every rounding cent, so capital adds up to the principal
 * exactly; a balloon is its own row on the last instalment's date.
 */
export function buildSchedule(input: ScheduleInput): ScheduleResult {
  const principal = input.principalCents;
  const balloon = input.balloonCents ?? 0;
  const fee = input.feeCents ?? 0;
  const step = stepMonths(input.frequency);
  if (!Number.isInteger(principal) || principal <= 0 || step == null || !Number.isInteger(input.termMonths)
      || input.termMonths < 1 || input.termMonths > 360 || fee < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(input.firstDate)) {
    return { ok: false, error: "finance-schedule-invalid" };
  }
  if (input.termMonths % step !== 0) return { ok: false, error: "finance-term-frequency" };
  if (balloon < 0 || balloon >= principal) return { ok: false, error: "finance-balloon-too-large" };
  const count = input.termMonths / step;
  const instalment = input.instalmentCents ?? null;

  let rate = input.rateBps;
  if (rate == null) {
    if (instalment == null) return { ok: false, error: "finance-rate-or-instalment" };
    rate = impliedRateBps(principal, instalment - fee, count, step, balloon);
    if (rate == null) {
      return {
        ok: false,
        error: instalment - fee < annuityPayment(principal, 0, count, step, balloon)
          ? "finance-instalment-too-low"
          : "finance-instalment-too-high",
      };
    }
  }
  if (rate < 0 || rate > 10000) return { ok: false, error: "finance-schedule-invalid" };

  let pay: number;
  if (instalment != null) {
    pay = instalment - fee;
    if (pay <= 0) return { ok: false, error: "finance-instalment-too-low" };
  } else {
    pay = annuityPayment(principal, rate, count, step, balloon);
  }

  const rows: ScheduleRow[] = [];
  let balance = principal;
  for (let k = 1; k <= count; k += 1) {
    const interest = periodInterest(balance, rate, step);
    let capital: number;
    if (k < count) {
      capital = pay - interest;
      if (capital <= 0) return { ok: false, error: "finance-instalment-too-low" };
      if (balance - capital < balloon) return { ok: false, error: "finance-instalment-too-high" };
    } else {
      capital = balance - balloon;
      if (instalment != null && count > 1 && interest + capital > 2 * pay) {
        return { ok: false, error: "finance-instalment-mismatch" };
      }
    }
    balance -= capital;
    rows.push({
      seq: k,
      kind: "instalment",
      dueDate: addMonths(input.firstDate, (k - 1) * step),
      interestCents: interest,
      capitalCents: capital,
      feeCents: fee,
      amountCents: interest + capital + fee,
      balanceAfterCents: balance,
    });
  }
  if (balloon > 0) {
    rows.push({
      seq: count + 1,
      kind: "balloon",
      dueDate: addMonths(input.firstDate, (count - 1) * step),
      interestCents: 0,
      capitalCents: balloon,
      feeCents: 0,
      amountCents: balloon,
      balanceAfterCents: 0,
    });
  }
  return { ok: true, rows, rateBps: rate, paymentCents: pay + fee };
}

/** Totals of a schedule: what it costs on top of the principal, and the whole repayment. */
export function scheduleTotals(rows: readonly ScheduleRow[]): {
  interestCents: number;
  feeCents: number;
  capitalCents: number;
  totalCents: number;
} {
  let interestCents = 0;
  let feeCents = 0;
  let capitalCents = 0;
  for (const r of rows) {
    interestCents += r.interestCents;
    feeCents += r.feeCents;
    capitalCents += r.capitalCents;
  }
  return { interestCents, feeCents, capitalCents, totalCents: interestCents + feeCents + capitalCents };
}

// == What was paid, and what is still owed ====================================

export type InstalmentState = {
  kind: string;
  status: string;
  dueDate: string;
  interestCents: number;
  capitalCents: number;
  feeCents: number;
  paidCents: number;
  paidOn: string | null;
};

/**
 * The capital a payment on this row has covered. A lender takes the interest first, then
 * the fee, then capital, so a part payment reduces the balance only once those are met.
 */
export function capitalPaid(row: InstalmentState): number {
  return Math.min(Math.max(row.paidCents - row.interestCents - row.feeCents, 0), row.capitalCents);
}

/**
 * What an instalment adds to the cost ledger: interest and the service fee, never capital
 * (the machine's price is already its purchase cost). Mirrors (1) in
 * `app.sync_asset_finance_costs`: nothing before the due date, nothing for a row an early
 * settlement closed.
 */
export function instalmentCostCents(row: InstalmentState, today: string): number {
  if (row.status === "settled" || row.dueDate > today) return 0;
  return row.interestCents + row.feeCents;
}

export type AgreementBalance = {
  outstandingCapitalCents: number;
  remainingCents: number;
  paidCents: number;
  interestToDateCents: number;
  overdueCount: number;
  overdueCents: number;
  balanceCents: number;
  balanceSource: "schedule" | "statement" | "closed";
};

/**
 * The balance of one agreement, as `public.finance_agreement_summaries` computes it: the
 * principal less the capital the payments covered, unless the lender's statement is at
 * least as new as the last payment, which then wins. A closed agreement owes nothing.
 */
export function agreementBalance(
  agreement: {
    status: string;
    principalCents: number;
    statementBalanceCents: number | null;
    statementBalanceOn: string | null;
  },
  rows: readonly InstalmentState[],
  today: string,
): AgreementBalance {
  let paid = 0;
  let covered = 0;
  let remaining = 0;
  let interestToDate = 0;
  let overdueCount = 0;
  let overdueCents = 0;
  let lastPaid: string | null = null;
  for (const r of rows) {
    paid += r.paidCents;
    covered += capitalPaid(r);
    if (r.status === "open") {
      remaining += r.interestCents + r.capitalCents + r.feeCents - r.paidCents;
      if (r.dueDate < today) {
        overdueCount += 1;
        overdueCents += r.interestCents + r.capitalCents + r.feeCents - r.paidCents;
      }
    }
    if (r.status !== "settled" && r.dueDate <= today) interestToDate += r.interestCents;
    if (r.paidOn && (lastPaid == null || r.paidOn > lastPaid)) lastPaid = r.paidOn;
  }
  if (agreement.status !== "active") {
    return {
      outstandingCapitalCents: 0, remainingCents: 0, paidCents: paid, interestToDateCents: interestToDate,
      overdueCount: 0, overdueCents: 0, balanceCents: 0, balanceSource: "closed",
    };
  }
  const outstanding = Math.max(agreement.principalCents - covered, 0);
  const statementWins = agreement.statementBalanceOn != null && agreement.statementBalanceCents != null
    && (lastPaid == null || agreement.statementBalanceOn >= lastPaid);
  return {
    outstandingCapitalCents: outstanding,
    remainingCents: remaining,
    paidCents: paid,
    interestToDateCents: interestToDate,
    overdueCount,
    overdueCents,
    balanceCents: statementWins ? (agreement.statementBalanceCents as number) : outstanding,
    balanceSource: statementWins ? "statement" : "schedule",
  };
}

/** Settling now: the capital still owed, and what a settlement figure costs above it. */
export function settlementCharge(outstandingCapitalCents: number, settlementCents: number): number {
  return Math.max(settlementCents - outstandingCapitalCents, 0);
}

// == Contracts ================================================================

/**
 * The days a contract falls due between two dates (both inclusive): the anchor and every
 * step after it, or the anchor alone for a once-off payment. Mirrors
 * `app.asset_contract_dates`.
 */
export function contractPaymentDates(
  anchor: string,
  frequency: string,
  from: string | null,
  to: string,
): string[] {
  const start = from ?? anchor;
  if (to < start) return [];
  if (frequency === "once") return anchor >= start && anchor <= to ? [anchor] : [];
  const step = stepMonths(frequency);
  if (step == null) return [];
  const out: string[] = [];
  let k = 0;
  if (start > anchor) {
    const [ay, am] = anchor.split("-").map(Number);
    const [sy, sm] = start.split("-").map(Number);
    k = Math.max(Math.trunc(((sy - ay) * 12 + (sm - am)) / step) - 1, 0);
  }
  for (; k <= 12000; k += 1) {
    const d = addMonths(anchor, k * step);
    if (d > to) break;
    if (d >= start) out.push(d);
  }
  return out;
}

/** The cost type a contract's payments are booked under (mirrors (3) in the cost sync). */
export function contractCostType(kind: string): "lease" | "other" {
  return kind === "operating_lease" || kind === "rental" ? "lease" : "other";
}

/** VAT on an ex-VAT amount, rounded half up to the cent (the SQL's round(numeric)). */
export function vatCents(exVatCents: number, rateBps: number): number {
  if (exVatCents <= 0 || rateBps <= 0) return 0;
  return Number(divHalfUp(BigInt(exVatCents) * BigInt(rateBps), 10000n));
}

// == Cash flow ================================================================

export type Commitment = {
  kind: string;
  source_id: string;
  item_id: string | null;
  machine_id: string | null;
  machine_name: string | null;
  party: string | null;
  reference: string | null;
  on_date: string;
  amount_cents: number | null;
  vat_cents: number | null;
};

export type CashflowMonth = {
  month: string;
  financeCents: number;
  contractCents: number;
  totalCents: number;
};

/** Gross cents a commitment takes out of the bank (instalments carry no VAT). */
export function commitmentGross(c: Commitment): number {
  return (c.amount_cents ?? 0) + (c.vat_cents ?? 0);
}

/**
 * Commitments into months, every month of the window present even when empty, so a
 * quiet month reads as R0 rather than as missing. Dates and notice rows carry no money.
 */
export function monthlyCashflow(commitments: readonly Commitment[], fromMonth: string, months: number): CashflowMonth[] {
  const out: CashflowMonth[] = [];
  const index = new Map<string, CashflowMonth>();
  for (let k = 0; k < months; k += 1) {
    const month = addMonths(`${fromMonth}-01`, k).slice(0, 7);
    const row = { month, financeCents: 0, contractCents: 0, totalCents: 0 };
    out.push(row);
    index.set(month, row);
  }
  for (const c of commitments) {
    const row = index.get(c.on_date.slice(0, 7));
    if (!row || c.amount_cents == null) continue;
    const gross = commitmentGross(c);
    if (c.kind === "contract_payment") row.contractCents += gross;
    else row.financeCents += gross;
    row.totalCents += gross;
  }
  return out;
}

/** Commitments that carry money, soonest first: the "coming up" list. */
export function upcomingPayments(commitments: readonly Commitment[]): Commitment[] {
  return commitments
    .filter((c) => c.amount_cents != null)
    .slice()
    .sort((a, b) => a.on_date.localeCompare(b.on_date) || a.kind.localeCompare(b.kind));
}

/**
 * The lender as the screen shows it. Agreements moved from the old machine fields with no
 * provider recorded were saved with '-' (20261028110700); the screen says so in words.
 */
export function lenderKnown(lender: string | null | undefined): boolean {
  return Boolean(lender && lender.trim() !== "" && lender.trim() !== "-");
}

// == Reading what a person typed ================================================

/**
 * A rate typed in percent, as a bank quotes it ("11,75" or "11.75"), to whole basis
 * points (1175). Blank is null (no rate: the lender's instalment implies one); anything
 * that is not a rate from 0 to 100 percent is `false`, so the caller can say so instead
 * of saving nonsense.
 */
export function percentToBps(raw: string | null | undefined): number | null | false {
  const v = String(raw ?? "").trim().replace(/%$/, "").trim();
  if (v === "") return null;
  if (!/^\d{1,3}([.,]\d{1,4})?$/.test(v)) return false;
  const pct = Number(v.replace(",", "."));
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return false;
  return Math.round(pct * 100);
}

/** Basis points as the form shows them again: 1175 is "11.75". */
export function bpsToPercentInput(bps: number | null | undefined): string {
  if (bps == null) return "";
  const whole = Math.trunc(bps / 100);
  const frac = String(Math.abs(bps % 100)).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** Cents as an amount input shows them: 1105916 is "11059.16". */
export function centsToInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** A whole number of days or months in a range, or null for blank, or false when wrong. */
export function wholeNumberIn(raw: string | null | undefined, min: number, max: number): number | null | false {
  const v = String(raw ?? "").trim();
  if (v === "") return null;
  if (!/^\d+$/.test(v)) return false;
  const n = Number(v);
  return n >= min && n <= max ? n : false;
}

// == How a row reads on the screen ==============================================

export type Tone = "neutral" | "brand" | "ok" | "warning" | "danger" | "info";

/** An agreement's status in a badge: what it is, and how loud. */
export function agreementTone(status: string, overdueCount: number): Tone {
  if (status === "settled") return "ok";
  if (status === "cancelled") return "neutral";
  return overdueCount > 0 ? "danger" : "brand";
}

/** A contract's status in a badge. Ending inside its reminder lead is a warning. */
export function contractTone(
  contract: { status: string; end_date: string | null; notice_date: string | null; reminder_lead_days: number | null },
  today: string,
): Tone {
  if (contract.status !== "active") return "neutral";
  const lead = contract.reminder_lead_days ?? DEFAULT_CONTRACT_LEAD_DAYS;
  const soon = addDays(today, lead);
  if (contract.notice_date && contract.notice_date >= today && contract.notice_date <= soon) return "warning";
  if (contract.end_date && contract.end_date <= soon) return "warning";
  return "ok";
}

/** `YYYY-MM-DD` plus days (negative goes back), without a Date. */
export function addDays(ymd: string, days: number): string {
  return days >= 0 ? plusDays(ymd, days) : minusDays(ymd, -days);
}

function plusDays(ymd: string, days: number): string {
  let [y, m, d] = ymd.split("-").map(Number);
  d += days;
  while (d > daysIn(y, m)) {
    d -= daysIn(y, m);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** What one contract payment takes out of the bank, VAT included. */
export function contractGrossCents(amountCents: number, vatRateBps: number): number {
  return amountCents + vatCents(amountCents, vatRateBps);
}

/**
 * Where a person is sent back to after a finance action: the Finance page, or the Costs
 * tab of the machine the form was on. Anything else (a tampered field) is the Finance
 * page, never an arbitrary address.
 */
export function financeReturnPath(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim();
  if (/^\/machines\/[0-9a-f-]{36}$/i.test(v)) return `${v}?tab=costs`;
  return "/finance";
}

/** The path with a result added: `?saved=` or `?error=`, keeping a `?tab=` already there. */
export function withResult(path: string, key: "saved" | "error", value: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${value}`;
}

/** The success sentence's key for a `?saved=` code a finance action sent, on either screen. */
export const FINANCE_SAVED_KEYS: Readonly<Record<string, string>> = {
  "finance-agreement": "assetFinance.savedAgreement",
  "finance-statement": "assetFinance.savedStatement",
  "finance-payment": "assetFinance.savedPayment",
  "finance-payment-cleared": "assetFinance.savedPaymentCleared",
  "finance-schedule": "assetFinance.savedSchedule",
  "finance-settled": "assetFinance.savedSettled",
  "finance-removed": "assetFinance.savedRemoved",
  "finance-contract": "assetFinance.savedContract",
  "finance-contract-ended": "assetFinance.savedContractEnded",
  "finance-contract-renewed": "assetFinance.savedContractRenewed",
  "finance-document": "assetFinance.savedDocument",
  "finance-document-removed": "assetFinance.savedDocumentRemoved",
};

export function financeSavedKey(code: string | null | undefined): string | undefined {
  return code ? FINANCE_SAVED_KEYS[code] : undefined;
}
