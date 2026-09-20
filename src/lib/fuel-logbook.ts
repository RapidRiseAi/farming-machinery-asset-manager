/**
 * The SARS diesel-refund logbooks, as rows.
 *
 * `SCOPE.md` §9 sells this module on one promise: the rebate "stands or fall on logbooks",
 * and FleetWise produces the records. What existed was a per-machine CSV whose own comment
 * calls it the logbook *basis* — litres, spend and consumption, which is a management
 * report, not a logbook. A claim is audited against two trails:
 *
 *   * STORAGE — what came into the tank and what went out of it, with a running balance,
 *     so the diesel can be followed from the supplier's invoice to the machine;
 *   * USAGE — every draw, with the machine, the activity it was doing, the meter reading
 *     and who drew it, so eligible use can be told from ineligible use.
 *
 * DRAFT, AND IT SAYS SO
 * ─────────────────────────────────────────────────────────────────────────────
 * These columns are modelled on the published SARS layout; nobody at SARS has confirmed
 * THIS file. Every export therefore carries a first line saying it must be checked by the
 * farmer's accountant before a claim, and the screen says the same before the download.
 * `SCOPE.md` §9 already requires that disclaimer in the product — the records are ours, the
 * claim is theirs.
 *
 * Pure. No I/O, no Supabase client: the routes hand it rows and it hands back a grid, so
 * the download, a future PDF and any test see identical numbers.
 */

import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { activityLabel } from "@/lib/fuel";

export type LogbookDelivery = {
  tank_id: string;
  date: string;
  litres: number | null;
  supplier: string | null;
  invoice_no: string | null;
};

export type LogbookIssue = {
  tank_id: string;
  machine_id: string | null;
  date: string;
  litres: number | null;
  meter_reading: number | null;
  activity: string | null;
  driver: string | null;
};

export type LogbookMachine = {
  id: string;
  name: string;
  reg_no: string | null;
  meter_type: string;
};

/** One tank movement, either in or out, in date order with the balance it leaves behind. */
type Movement = {
  date: string;
  kind: "in" | "out";
  litres: number;
  reference: string;
  detail: string;
};

function sortByDate<T extends { date: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The STORAGE logbook: every litre into and out of one tank, with a running balance.
 *
 * The opening balance is zero at the start of the extract, not a guess at what was in the
 * tank before FleetWise: an invented opening figure is the fastest way to make a whole
 * logbook indefensible. The disclaimer line says so.
 */
export function storageLogbookRows(
  tankName: string,
  deliveries: LogbookDelivery[],
  issues: LogbookIssue[],
  machines: Map<string, LogbookMachine>,
  locale: Lang,
): (string | number)[][] {
  const movements: Movement[] = [
    ...deliveries.map((d) => ({
      date: d.date,
      kind: "in" as const,
      litres: d.litres ?? 0,
      reference: d.invoice_no ?? "",
      detail: d.supplier ?? "",
    })),
    ...issues.map((i) => ({
      date: i.date,
      kind: "out" as const,
      litres: i.litres ?? 0,
      reference: "",
      detail: i.machine_id ? (machines.get(i.machine_id)?.name ?? "") : t("logbook.farmUse", locale),
    })),
  ];

  const rows: (string | number)[][] = [
    [t("logbook.draftNotice", locale)],
    [t("logbook.storageTitle", locale).replace("{tank}", tankName)],
    [
      t("logbook.colDate", locale),
      t("logbook.colOpening", locale),
      t("logbook.colIn", locale),
      t("logbook.colOut", locale),
      t("logbook.colClosing", locale),
      t("logbook.colReference", locale),
      t("logbook.colDetail", locale),
    ],
  ];

  let balance = 0;
  for (const m of sortByDate(movements)) {
    const opening = balance;
    balance = m.kind === "in" ? balance + m.litres : balance - m.litres;
    rows.push([
      m.date,
      opening.toFixed(1),
      m.kind === "in" ? m.litres.toFixed(1) : "",
      m.kind === "out" ? m.litres.toFixed(1) : "",
      balance.toFixed(1),
      m.reference,
      m.detail,
    ]);
  }
  return rows;
}

/**
 * The USAGE logbook: one line per draw, with what the machine was doing.
 *
 * A draw with NO activity recorded is still listed, with the activity column empty. Leaving
 * it out would make the usage total disagree with the storage logbook's "out" column, and
 * two of our own trails that disagree is exactly what an audit looks for. An empty cell is
 * a gap the farmer can fill; a missing row is one nobody can see.
 */
export function usageLogbookRows(
  issues: LogbookIssue[],
  machines: Map<string, LogbookMachine>,
  tankNames: Map<string, string>,
  locale: Lang,
): (string | number)[][] {
  const rows: (string | number)[][] = [
    [t("logbook.draftNotice", locale)],
    [t("logbook.usageTitle", locale)],
    [
      t("logbook.colDate", locale),
      t("logbook.colMachine", locale),
      t("logbook.colReg", locale),
      t("logbook.colActivity", locale),
      t("logbook.colLitres", locale),
      t("logbook.colMeter", locale),
      t("logbook.colMeterType", locale),
      t("logbook.colDriver", locale),
      t("logbook.colTank", locale),
    ],
  ];

  for (const i of sortByDate(issues)) {
    const machine = i.machine_id ? machines.get(i.machine_id) : undefined;
    rows.push([
      i.date,
      machine?.name ?? t("logbook.farmUse", locale),
      machine?.reg_no ?? "",
      i.activity ? activityLabel(i.activity, locale) : "",
      (i.litres ?? 0).toFixed(1),
      i.meter_reading == null ? "" : i.meter_reading.toFixed(1),
      machine && machine.meter_type !== "none" ? t(`meterType.${machine.meter_type}`, locale) : "",
      i.driver ?? "",
      tankNames.get(i.tank_id) ?? "",
    ]);
  }
  return rows;
}
