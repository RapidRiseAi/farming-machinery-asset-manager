import "server-only";

import { t, type Lang } from "@/lib/i18n";
import { buildXlsx, heading, moneyCell, text, type XlsxCell } from "@/lib/xlsx";
import { getProfile, checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { todayLocal } from "@/lib/format";
import {
  CASHFLOW_MONTHS,
  FINANCE_EXPORT_FEATURE,
  addDays,
  addMonths,
  commitmentGross,
  monthlyCashflow,
  type Commitment,
} from "@/lib/asset-finance";
import { canViewFarmFinance, readCommitments } from "@/lib/asset-finance-read";
import { commitmentKindLabel } from "@/components/asset-finance/labels";

/**
 * The cash-flow export (CSV and workbook): the farm's finance and contract commitments for
 * the next twelve months, by month and line by line.
 *
 * Gated twice, like every farm-side export (F5): the plan feature `FINANCE_EXPORT_FEATURE`
 * (founder default: the existing `advanced_reports`), and the finance check, so a mechanic
 * on a Professional farm gets a 403 rather than a file. Every denial is a STATUS, never a
 * redirect to an HTML page saved as a "CSV".
 *
 * Amounts are GROSS (what leaves the bank) and include capital: this is cash, not cost.
 */

export type CashflowExport =
  | { ok: true; locale: Lang; today: string; commitments: Commitment[] }
  | { ok: false; response: Response };

export async function loadCashflowExport(): Promise<CashflowExport> {
  const profile = await getProfile();
  if (!profile || !profile.active) return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  if (!(await checkEntitlement(FINANCE_EXPORT_FEATURE, profile)).allowed) {
    return { ok: false, response: new Response("Upgrade required", { status: 403 }) };
  }
  const farmId = await currentFarmId(profile);
  const supabase = await createClient();
  if (!farmId || !(await canViewFarmFinance(supabase, farmId))) {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }
  const today = todayLocal();
  const commitments = await readCommitments(supabase, farmId, today, addDays(addMonths(today, CASHFLOW_MONTHS), -1));
  return { ok: true, locale: profile.lang, today, commitments };
}

const randText = (cents: number | null) => (cents == null ? "" : (cents / 100).toFixed(2));

/** The month table, then the lines, as text rows for a CSV. */
export function cashflowCsvRows(commitments: readonly Commitment[], today: string, locale: Lang): string[][] {
  const L = (key: string) => t(`assetFinance.${key}`, locale);
  const rows: string[][] = [[L("exportMonth"), L("exportFinance"), L("exportContracts"), L("exportTotal")]];
  for (const m of monthlyCashflow(commitments, today.slice(0, 7), CASHFLOW_MONTHS)) {
    rows.push([m.month, randText(m.financeCents), randText(m.contractCents), randText(m.totalCents)]);
  }
  rows.push([]);
  rows.push([L("exportDate"), L("exportKind"), L("exportParty"), L("exportReference"), L("exportMachine"), L("exportExVat"), L("exportVat"), L("exportGross")]);
  for (const c of commitments) {
    rows.push([
      c.on_date,
      commitmentKindLabel(c.kind, locale),
      c.party ?? "",
      c.reference ?? "",
      c.machine_name ?? L("wholeFarm"),
      randText(c.amount_cents),
      randText(c.amount_cents == null ? null : c.vat_cents ?? 0),
      randText(c.amount_cents == null ? null : commitmentGross(c)),
    ]);
  }
  return rows;
}

/** The same two tables as a workbook, money as real numbers in Rands. */
export function cashflowWorkbook(commitments: readonly Commitment[], today: string, locale: Lang): Uint8Array {
  const L = (key: string) => t(`assetFinance.${key}`, locale);
  const months: XlsxCell[][] = [[L("exportMonth"), L("exportFinance"), L("exportContracts"), L("exportTotal")].map(heading)];
  for (const m of monthlyCashflow(commitments, today.slice(0, 7), CASHFLOW_MONTHS)) {
    months.push([text(m.month), moneyCell(m.financeCents), moneyCell(m.contractCents), moneyCell(m.totalCents)]);
  }
  const lines: XlsxCell[][] = [
    [L("exportDate"), L("exportKind"), L("exportParty"), L("exportReference"), L("exportMachine"), L("exportExVat"), L("exportVat"), L("exportGross")].map(heading),
  ];
  for (const c of commitments) {
    lines.push([
      text(c.on_date),
      text(commitmentKindLabel(c.kind, locale)),
      text(c.party ?? ""),
      text(c.reference ?? ""),
      text(c.machine_name ?? L("wholeFarm")),
      moneyCell(c.amount_cents),
      moneyCell(c.amount_cents == null ? null : c.vat_cents ?? 0),
      moneyCell(c.amount_cents == null ? null : commitmentGross(c)),
    ]);
  }
  return new Uint8Array(buildXlsx([
    { name: L("exportSheetMonths"), rows: months },
    { name: L("exportSheetLines"), rows: lines },
  ]));
}
