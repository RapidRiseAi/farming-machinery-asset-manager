/**
 * Budgets & budget-vs-actual — feature G1 (FR-10.4). Shared by the machine-detail and
 * reports surfaces so both compute the same "actual". All money is integer cents, ex-VAT.
 *
 * A budget is a target (`amount_cents`) for a period (`period_start`..`period_end`),
 * optionally narrowed to one machine and/or one cost category. The "actual" is never
 * stored: it is summed live from the same `cost_entries` ledger (F1) that drives TCO, so
 * a budget and its actual can never drift. The SQL mirror is the `budgets` table (0360) —
 * the period bounds are stored, so this file only has to sum, never re-derive them.
 */
import type { Locale, Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import type { CostType } from "@/lib/cost";

export const BUDGET_PERIODS = ["month", "quarter", "year"] as const;
export type BudgetPeriodType = (typeof BUDGET_PERIODS)[number];

export type Budget = {
  id: string;
  machine_id: string | null;
  category: CostType | null;
  period_type: BudgetPeriodType;
  period_start: string; // YYYY-MM-DD
  period_end: string;   // YYYY-MM-DD
  amount_cents: number;
  note: string | null;
};

/** A `cost_entries` row, projected to the columns budget-vs-actual needs. */
export type BudgetCostRow = {
  machine_id: string | null;
  type: string;
  amount_cents: number | null;
  occurred_on: string | null; // YYYY-MM-DD
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Derive [period_start, period_end] (inclusive, YYYY-MM-DD) from a period type and an
 * anchor date that falls somewhere inside the desired period. Month → that calendar
 * month; quarter → the calendar quarter containing the anchor; year → that calendar year.
 * Pure integer/UTC math — no timezone drift.
 */
export function computePeriodBounds(
  periodType: BudgetPeriodType,
  anchorYmd: string,
): { start: string; end: string } {
  const [y, m] = anchorYmd.split("-").map(Number);
  const year = Number.isFinite(y) ? y : new Date().getUTCFullYear();
  const month = Number.isFinite(m) && m >= 1 && m <= 12 ? m : 1;

  if (periodType === "year") {
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }
  let startMonth: number;
  let endMonth: number;
  if (periodType === "quarter") {
    const q = Math.floor((month - 1) / 3);
    startMonth = q * 3 + 1;
    endMonth = startMonth + 2;
  } else {
    startMonth = month;
    endMonth = month;
  }
  // Day 0 of the (0-based) endMonth = the last day of the (1-based) endMonth.
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  return { start: `${year}-${pad(startMonth)}-01`, end: `${year}-${pad(endMonth)}-${pad(lastDay)}` };
}

/**
 * Sum the actual spend against a budget: every non-deleted cost entry whose
 * occurred_on falls in the budget's period AND that matches its machine scope (null =
 * any machine, incl. farm-level entries) AND its category scope (null = all types).
 */
export function budgetActualCents(rows: BudgetCostRow[], b: Budget): number {
  let actual = 0;
  for (const r of rows) {
    const day = r.occurred_on?.slice(0, 10);
    if (!day || day < b.period_start || day > b.period_end) continue;
    if (b.machine_id != null && r.machine_id !== b.machine_id) continue;
    if (b.category != null && r.type !== b.category) continue;
    actual += r.amount_cents ?? 0;
  }
  return actual;
}

export type BudgetStatus = "ok" | "warning" | "over";

export type BudgetProgress = {
  budget: Budget;
  actual: number;
  /** actual − budget (positive = over budget). */
  variance: number;
  /** budget − actual (positive = headroom left), floored at 0 for display. */
  remaining: number;
  /** actual ÷ budget as a percentage (null when budget is 0). */
  pct: number | null;
  status: BudgetStatus;
};

/** Compute the over/under picture for one budget from the cost ledger. */
export function budgetProgress(rows: BudgetCostRow[], b: Budget): BudgetProgress {
  const actual = budgetActualCents(rows, b);
  const variance = actual - b.amount_cents;
  const pct = b.amount_cents > 0 ? (actual / b.amount_cents) * 100 : null;
  const status: BudgetStatus =
    variance > 0 ? "over" : pct != null && pct >= 90 ? "warning" : "ok";
  return { budget: b, actual, variance, remaining: Math.max(0, -variance), pct, status };
}

/** Badge/bar tone for a budget status (maps to the traffic-light kit colours). */
export function budgetTone(s: BudgetStatus): "ok" | "warning" | "danger" {
  return s === "over" ? "danger" : s === "warning" ? "warning" : "ok";
}

// ── Localised labels ──────────────────────────────────────────────────────────
export function budgetPeriodLabel(type: string, locale: Lang): string {
  return t(`budgetPeriod.${type}`, locale);
}

export function budgetCategoryLabel(category: string | null, locale: Lang): string {
  return category ? t(`costType.${category}`, locale) : t("budget.allCategories", locale);
}

export function budgetScopeLabel(
  b: Pick<Budget, "machine_id">,
  machineName: string | null,
  locale: Lang,
): string {
  return b.machine_id ? machineName ?? t("budget.thisMachine", locale) : t("budget.wholeFarm", locale);
}
