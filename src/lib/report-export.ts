import "server-only";

import type { ReportData } from "@/app/(app)/reports/data";
import { centsToR, toCsv } from "@/app/(app)/reports/data";
import { buildXlsx, heading, text, num, moneyCell, type XlsxCell, type XlsxSheet } from "@/lib/xlsx";
import { Pdf } from "@/lib/pdf/doc";

/**
 * Every shape a report leaves the product in — CSV grid, Excel sheet, PDF table — in ONE
 * place (FR-11.5).
 *
 * Extracted from the eight download routes rather than rewritten. Before this, each
 * `*.csv/route.ts` built its own grid inline and `workbook.xlsx/route.ts` built all eight
 * again. That was survivable while a person had to press a button, because whatever they
 * pressed was the thing they got. It stops being survivable the moment a schedule emails
 * a copy every month: a column added to the download would silently not appear in the
 * emailed file, and nobody would find out until an accountant reconciled a year.
 *
 * So the routes and the scheduler now call the same builders, and the FIGURES were
 * already shared — everything here reads `ReportData` from `getReportData`, the same call
 * the screen makes. The screen, the download and the emailed copy are one code path.
 *
 * Header labels stay in English on purpose. They were English before, they are column
 * headers in a file an accountant opens in Excel next to eleven others, and renaming them
 * per locale would break every spreadsheet that already points at them.
 */

export const REPORT_FAMILIES = [
  "cost", "by_type", "problems", "compliance", "fuel", "contractors", "budgets", "utilisation",
] as const;
export type ReportFamily = (typeof REPORT_FAMILIES)[number];
/** What a schedule may ask for: one family, or the lot. */
export type ReportKey = ReportFamily | "all";
export const REPORT_KEYS = ["all", ...REPORT_FAMILIES] as const;

export const REPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export function isReportKey(v: string): v is ReportKey {
  return (REPORT_KEYS as readonly string[]).includes(v);
}
export function isReportFormat(v: string): v is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(v);
}

export type ReportGrid = {
  family: ReportFamily;
  /** Sheet name in a workbook / heading in a PDF. */
  title: string;
  /** Download filename, unchanged from the route that used to own it. */
  filename: string;
  rows: (string | number)[][];
  /** How many data rows the family actually found — what "empty period" is decided on. */
  count: number;
};

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
const meterUnitOf = (t: string) => (t === "km" ? "km" : t === "hours" ? "h" : "");
const meterDp = (t: string) => (t === "km" ? 0 : 1);
const withUnit = (v: number, t: string) => `${v.toFixed(meterDp(t))} ${meterUnitOf(t)}`.trim();

// ── CSV grids, one per family (moved verbatim from the routes) ────────────────

function costGrid(d: ReportData): ReportGrid {
  const rows: (string | number)[][] = [
    ["Machine", "Parts (R)", "Labour (R)", "Other (R)", "Spend in period (R)", "TCO (R)", "Cost per hour (R)", "Cost per km (R)"],
  ];
  for (const r of d.costPerMachine) {
    rows.push([
      r.name, centsToR(r.parts), centsToR(r.labour), centsToR(r.other), centsToR(r.total), centsToR(r.tco),
      r.perHour != null ? centsToR(r.perHour) : "",
      r.perKm != null ? centsToR(r.perKm) : "",
    ]);
  }
  return { family: "cost", title: "Cost per machine", filename: "cost-per-machine.csv", rows, count: d.costPerMachine.length };
}

function byTypeGrid(d: ReportData): ReportGrid {
  const rows: (string | number)[][] = [["Job type", "Total (R)"]];
  for (const r of d.byType) rows.push([r.type.replace(/_/g, " "), centsToR(r.total)]);
  return { family: "by_type", title: "Spend by type", filename: "spend-by-type.csv", rows, count: d.byType.length };
}

function problemsGrid(d: ReportData): ReportGrid {
  const p = d.problems;
  const rows: (string | number)[][] = [["Machine (breaks most often)", "Count"]];
  for (const b of p.breaksMostOften) rows.push([b.name, b.count]);
  rows.push(["", ""], ["Most-replaced part", "Count"]);
  for (const x of p.topParts) rows.push([x.name, x.count]);
  rows.push(["", ""], ["Top fault category", "Count"]);
  for (const f of p.topFaults) rows.push([f.name, f.count]);
  return {
    family: "problems", title: "Recurring problems", filename: "recurring-problems.csv", rows,
    count: p.breaksMostOften.length + p.topParts.length + p.topFaults.length,
  };
}

function complianceGrid(d: ReportData): ReportGrid {
  const c = d.compliance;
  const rows: (string | number)[][] = [
    ["Metric", "Value"],
    ["OK", c.ok],
    ["Due soon", c.dueSoon],
    ["Overdue", c.overdue],
    ["", ""],
    ["Overdue machine", "Task"],
  ];
  for (const o of c.overdueList) rows.push([o.name, o.task]);
  return {
    family: "compliance", title: "Service compliance", filename: "service-compliance.csv", rows,
    count: c.ok + c.dueSoon + c.overdue,
  };
}

function fuelGrid(d: ReportData): ReportGrid {
  const rows: (string | number)[][] = [["Machine", "Litres", "Fuel spend (R)", "Consumption", "Unit"]];
  for (const r of d.fuel.perMachine) {
    rows.push([
      r.name, r.litres, centsToR(r.spend),
      r.consumption != null ? r.consumption.toFixed(2) : "",
      r.consumption != null ? (r.meterType === "km" ? "L/100km" : "L/hr") : "",
    ]);
  }
  rows.push([]);
  rows.push(["Purchased (deliveries) litres", d.fuel.purchasedLitres, "spend (R)", centsToR(d.fuel.purchasedSpend)]);
  rows.push(["Used by machines (draws) litres", d.fuel.totalLitres, "spend (R)", centsToR(d.fuel.totalSpend)]);
  return { family: "fuel", title: "Fuel", filename: "fuel.csv", rows, count: d.fuel.perMachine.length };
}

function contractorsGrid(d: ReportData): ReportGrid {
  const c = d.contractors;
  const rows: (string | number)[][] = [];
  rows.push(["Metric", "Count", "Value (R)"]);
  rows.push(["Outstanding quotes", c.outstandingQuotes.count, centsToR(c.outstandingQuotes.value)]);
  rows.push(["Outstanding invoices", c.outstandingInvoices.count, centsToR(c.outstandingInvoices.value)]);
  rows.push(["Spend via contractors", "", centsToR(c.spendViaContractors)]);
  rows.push([]);
  rows.push(["Responsiveness (avg hours)", "requested→viewed", c.responsiveness.requestedToViewedHrs ?? ""]);
  rows.push(["", "viewed→quoted", c.responsiveness.viewedToQuotedHrs ?? ""]);
  rows.push(["", "sample (requests)", c.responsiveness.sample]);
  rows.push([]);
  rows.push(["Work requests by status", "", ""]);
  for (const s of c.byStatus) rows.push([s.status, s.count, ""]);
  rows.push([]);
  rows.push(["Contractor", "Requests", "Invoiced", "Spend (R)"]);
  for (const p of c.perContractor) rows.push([p.name, p.requests, p.invoiced, centsToR(p.spend)]);
  return {
    family: "contractors", title: "Contractors", filename: "contractors.csv", rows,
    count: c.byStatus.length + c.perContractor.length,
  };
}

function budgetStatusWord(s: string): string {
  return s === "over" ? "Over budget" : s === "warning" ? "Near limit" : "Under budget";
}

function budgetsGrid(d: ReportData): ReportGrid {
  const rows: (string | number)[][] = [
    ["Scope", "Category", "Period", "From", "To", "Budget (R)", "Actual (R)", "Variance (R)", "Used %", "Status"],
  ];
  for (const b of d.budgets) {
    rows.push([
      b.machineId ? b.scope : "Whole farm",
      b.category ?? "All categories",
      b.periodType, b.periodStart, b.periodEnd,
      centsToR(b.amount), centsToR(b.actual), centsToR(b.variance),
      b.pct != null ? b.pct.toFixed(0) : "",
      budgetStatusWord(b.status),
    ]);
  }
  return { family: "budgets", title: "Budgets", filename: "budget-vs-actual.csv", rows, count: d.budgets.length };
}

function utilisationGrid(d: ReportData): ReportGrid {
  const w = d.utilisation.window;
  const rows: (string | number)[][] = [
    [`Utilisation & downtime — ${w.from} to ${w.to}`],
    ["Machine", "Meter", "Used", "Utilisation %", "Idle", "Downtime (days)"],
  ];
  for (const r of d.utilisation.perMachine) {
    rows.push([
      r.name, r.meterType,
      r.used != null ? withUnit(r.used, r.meterType) : "",
      r.pct != null ? r.pct.toFixed(0) : "",
      r.idle != null ? withUnit(r.idle, r.meterType) : "",
      r.downtimeDays.toFixed(1),
    ]);
  }
  return {
    family: "utilisation", title: "Utilisation", filename: "utilisation-downtime.csv", rows,
    count: d.utilisation.perMachine.length,
  };
}

const BUILDERS: Record<ReportFamily, (d: ReportData) => ReportGrid> = {
  cost: costGrid,
  by_type: byTypeGrid,
  problems: problemsGrid,
  compliance: complianceGrid,
  fuel: fuelGrid,
  contractors: contractorsGrid,
  budgets: budgetsGrid,
  utilisation: utilisationGrid,
};

/** One family's grid. */
export function reportGrid(data: ReportData, family: ReportFamily): ReportGrid {
  return BUILDERS[family](data);
}

/** Every family a `ReportKey` asks for, in the order the screen shows them. */
export function reportGrids(data: ReportData, key: ReportKey): ReportGrid[] {
  const families: readonly ReportFamily[] = key === "all" ? REPORT_FAMILIES : [key];
  return families.map((f) => BUILDERS[f](data));
}

/** Did the period actually contain anything? See 0506, judgement 3: an empty report is
 *  still sent — this only decides what the covering email says. */
export function gridsAreEmpty(grids: readonly ReportGrid[]): boolean {
  return grids.every((g) => g.count === 0);
}

export function csvBytes(grid: ReportGrid): Uint8Array {
  // Same BOM the download route writes, so Excel opens the emailed file the same way.
  return new TextEncoder().encode("﻿" + toCsv(grid.rows));
}

// ── The Excel workbook (moved verbatim from workbook.xlsx/route.ts) ───────────
//
// Same header labels and the same row data as the CSVs above, with money as REAL NUMBERS
// in Rands rather than text — which is the whole reason the workbook exists.

export function reportSheets(data: ReportData, key: ReportKey = "all"): XlsxSheet[] {
  const want = (f: ReportFamily) => key === "all" || key === f;
  const sheets: XlsxSheet[] = [];

  if (want("cost")) {
    const rows: XlsxCell[][] = [
      ["Machine", "Parts (R)", "Labour (R)", "Other (R)", "Spend in period (R)", "TCO (R)", "Cost per hour (R)", "Cost per km (R)"].map(heading),
    ];
    for (const r of data.costPerMachine) {
      rows.push([
        text(r.name),
        moneyCell(r.parts), moneyCell(r.labour), moneyCell(r.other), moneyCell(r.total), moneyCell(r.tco),
        moneyCell(r.perHour), moneyCell(r.perKm),
      ]);
    }
    sheets.push({ name: "Cost per machine", rows });
  }

  if (want("by_type")) {
    const rows: XlsxCell[][] = [["Job type", "Total (R)"].map(heading)];
    for (const r of data.byType) rows.push([text(r.type.replace(/_/g, " ")), moneyCell(r.total)]);
    sheets.push({ name: "Spend by type", rows });
  }

  if (want("problems")) {
    const rows: XlsxCell[][] = [["Machine (breaks most often)", "Count"].map(heading)];
    for (const b of data.problems.breaksMostOften) rows.push([text(b.name), num(b.count)]);
    rows.push([], ["Most-replaced part", "Count"].map(heading));
    for (const p of data.problems.topParts) rows.push([text(p.name), num(p.count)]);
    rows.push([], ["Top fault category", "Count"].map(heading));
    for (const ft of data.problems.topFaults) rows.push([text(ft.name), num(ft.count)]);
    sheets.push({ name: "Recurring problems", rows });
  }

  if (want("compliance")) {
    const rows: XlsxCell[][] = [
      ["Metric", "Value"].map(heading),
      [text("OK"), num(data.compliance.ok)],
      [text("Due soon"), num(data.compliance.dueSoon)],
      [text("Overdue"), num(data.compliance.overdue)],
      [],
      ["Overdue machine", "Task"].map(heading),
    ];
    for (const o of data.compliance.overdueList) rows.push([text(o.name), text(o.task)]);
    sheets.push({ name: "Service compliance", rows });
  }

  if (want("fuel")) {
    const rows: XlsxCell[][] = [["Machine", "Litres", "Fuel spend (R)", "Consumption", "Unit"].map(heading)];
    for (const r of data.fuel.perMachine) {
      rows.push([
        text(r.name),
        num(r.litres),
        moneyCell(r.spend),
        r.consumption != null ? num(round(r.consumption, 2)) : null,
        r.consumption != null ? text(r.meterType === "km" ? "L/100km" : "L/hr") : null,
      ]);
    }
    rows.push(
      [],
      [text("Purchased (deliveries) litres"), num(data.fuel.purchasedLitres), text("spend (R)"), moneyCell(data.fuel.purchasedSpend)],
      [text("Used by machines (draws) litres"), num(data.fuel.totalLitres), text("spend (R)"), moneyCell(data.fuel.totalSpend)],
    );
    sheets.push({ name: "Fuel", rows });
  }

  if (want("contractors")) {
    const c = data.contractors;
    const rows: XlsxCell[][] = [
      ["Metric", "Count", "Value (R)"].map(heading),
      [text("Outstanding quotes"), num(c.outstandingQuotes.count), moneyCell(c.outstandingQuotes.value)],
      [text("Outstanding invoices"), num(c.outstandingInvoices.count), moneyCell(c.outstandingInvoices.value)],
      [text("Spend via contractors"), null, moneyCell(c.spendViaContractors)],
      [],
      [heading("Responsiveness (avg hours)"), text("requested→viewed"), num(c.responsiveness.requestedToViewedHrs)],
      [null, text("viewed→quoted"), num(c.responsiveness.viewedToQuotedHrs)],
      [null, text("sample (requests)"), num(c.responsiveness.sample)],
      [],
      [heading("Work requests by status")],
    ];
    for (const s of c.byStatus) rows.push([text(s.status), num(s.count)]);
    rows.push([], ["Contractor", "Requests", "Invoiced", "Spend (R)"].map(heading));
    for (const p of c.perContractor) rows.push([text(p.name), num(p.requests), num(p.invoiced), moneyCell(p.spend)]);
    sheets.push({ name: "Contractors", rows });
  }

  if (want("budgets")) {
    const rows: XlsxCell[][] = [
      ["Scope", "Category", "Period", "From", "To", "Budget (R)", "Actual (R)", "Variance (R)", "Used %", "Status"].map(heading),
    ];
    for (const b of data.budgets) {
      rows.push([
        text(b.machineId ? b.scope : "Whole farm"),
        text(b.category ?? "All categories"),
        text(b.periodType),
        text(b.periodStart),
        text(b.periodEnd),
        moneyCell(b.amount),
        moneyCell(b.actual),
        moneyCell(b.variance),
        b.pct != null ? num(Math.round(b.pct)) : null,
        text(budgetStatusWord(b.status)),
      ]);
    }
    sheets.push({ name: "Budgets", rows });
  }

  if (want("utilisation")) {
    const w = data.utilisation.window;
    const rows: XlsxCell[][] = [
      [heading(`Utilisation & downtime — ${w.from} to ${w.to}`)],
      ["Machine", "Meter", "Used", "Utilisation %", "Idle", "Downtime (days)"].map(heading),
    ];
    for (const r of data.utilisation.perMachine) {
      rows.push([
        text(r.name),
        text(r.meterType),
        r.used != null ? text(withUnit(r.used, r.meterType)) : null,
        r.pct != null ? num(Math.round(r.pct)) : null,
        r.idle != null ? text(withUnit(r.idle, r.meterType)) : null,
        num(round(r.downtimeDays, 1)),
      ]);
    }
    sheets.push({ name: "Utilisation", rows });
  }

  return sheets;
}

export function buildReportWorkbook(data: ReportData, key: ReportKey = "all"): Uint8Array {
  return buildXlsx(reportSheets(data, key));
}

// ── PDF ──────────────────────────────────────────────────────────────────────
//
// The reports SCREEN prints through CSS, which a cron job cannot drive, so a scheduled
// PDF is drawn server-side on the shared engine (the same one the job card, machine file
// and audit pack use). It renders the SAME grids as the CSV — first row as the table
// head, the rest as body — so a farm choosing PDF over CSV gets a different sheet of
// paper, never a different number.

/** A4 content width in points (595.28 − 2×48). Columns must sum to no more than this. */
const PDF_CONTENT_W = 499.28;

/** Right-align the columns that carry money or a count, per family. */
const RIGHT_ALIGNED: Record<ReportFamily, (i: number, cols: number) => boolean> = {
  cost: (i) => i > 0,
  by_type: (i) => i > 0,
  problems: (i) => i > 0,
  compliance: (i) => i === 1,
  fuel: (i) => i === 1 || i === 2,
  contractors: (i) => i > 0,
  budgets: (i) => i >= 5,
  utilisation: (i) => i > 0,
};

function columnWidths(cols: number): number[] {
  if (cols <= 1) return [PDF_CONTENT_W];
  // The first column is a name and needs the room; the rest share what is left evenly.
  const first = Math.max(110, Math.min(220, PDF_CONTENT_W - (cols - 1) * 52));
  const rest = (PDF_CONTENT_W - first) / (cols - 1);
  return [first, ...Array.from({ length: cols - 1 }, () => rest)];
}

export type ReportPdfMeta = {
  farmName: string;
  scheduleName?: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  site?: string | null;
  includeInactive?: boolean;
};

export async function buildReportPdf(
  data: ReportData,
  key: ReportKey,
  meta: ReportPdfMeta,
): Promise<Uint8Array> {
  const grids = reportGrids(data, key);
  const pdf = await Pdf.create(`FleetWise report${meta.farmName ? ` — ${meta.farmName}` : ""}`);
  pdf.header(meta.scheduleName || "Fleet report");

  pdf.kv("Period", meta.periodFrom && meta.periodTo ? `${meta.periodFrom} to ${meta.periodTo}` : "All time");
  if (meta.site) pdf.kv("Site / group", meta.site);
  // Said out loud because it changes every figure below it: retired and sold machines are
  // excluded from every count unless the schedule asked for them (Scope §4.1 / C8).
  pdf.kv("Retired / sold machines", meta.includeInactive ? "Included" : "Excluded");
  pdf.gap(6);

  for (const g of grids) {
    pdf.heading(g.title);
    const body = g.rows.map((r) => r.map((c) => (c === "" || c == null ? "" : String(c))));
    if (body.length === 0) {
      pdf.text("Nothing in this period.");
      pdf.gap(6);
      continue;
    }
    // Some grids carry a full-width caption row (utilisation) before the real head.
    let head = body.shift() as string[];
    if (head.length === 1 && body.length > 0) {
      pdf.text(head[0]);
      head = body.shift() as string[];
    }
    const widths = columnWidths(head.length);
    const align = head.map((_, i) => RIGHT_ALIGNED[g.family](i, head.length));
    pdf.table(head, body.map((r) => {
      const row = [...r];
      while (row.length < head.length) row.push("");
      return row.slice(0, head.length);
    }), widths, align);
    pdf.gap(10);
  }

  return pdf.save();
}
