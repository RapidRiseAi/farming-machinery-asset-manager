// Import staging (task B5, 20261121110000): what a readings sheet becomes before anything is
// written. Shared by the upload action and its tests. The database names every problem
// (public.import_rows_stage); this file only reads the sheet into rows, never decides a value.

import { parseCsv } from "@/app/(app)/machines/import/csv";
import { READINGS_IMPORT_MAX_ROWS } from "@/lib/limits";

/** Every issue the database can name on a staged row, in the order a person should read them. */
export const IMPORT_ISSUES = [
  "asset_unknown",
  "asset_ambiguous",
  "uncertain_asset",
  "date_invalid",
  "date_future",
  "date_conflict",
  "uncertain_date",
  "reading_invalid",
  "unit_mismatch",
  "reading_backwards",
  "uncertain_reading",
  "duplicate_existing",
  "duplicate_in_batch",
] as const;
export type ImportIssue = (typeof IMPORT_ISSUES)[number];

/** The field a person must fill in to accept a row with this issue (mirrors import_row_decide). */
export function issueField(issue: string): "machine" | "date" | "reading" | null {
  if (["asset_unknown", "asset_ambiguous", "uncertain_asset"].includes(issue)) return "machine";
  if (["date_invalid", "date_future", "date_conflict", "uncertain_date"].includes(issue)) return "date";
  if (["reading_invalid", "reading_backwards", "unit_mismatch", "uncertain_reading"].includes(issue)) return "reading";
  return null;
}

/** Issues sorted into reading order; unknown codes (a newer database) keep their place at the end. */
export function sortIssues(issues: readonly string[]): string[] {
  const rank = (i: string) => {
    const n = (IMPORT_ISSUES as readonly string[]).indexOf(i);
    return n < 0 ? IMPORT_ISSUES.length : n;
  };
  return [...issues].sort((a, b) => rank(a) - rank(b));
}

/** A row as the database's staging function takes it. */
export type SheetRow = {
  row_no: number;
  asset: string;
  date: string;
  reading: string;
  unit?: string;
  source_text: string;
};

export type SheetResult =
  | { ok: true; rows: SheetRow[] }
  | { ok: false; error: "import-empty" | "import-header" | "import-too-many" };

const HEADERS: Record<"asset" | "date" | "reading" | "unit", readonly string[]> = {
  asset: ["asset", "machine", "vehicle", "name", "equipment", "serial", "serial_no", "reg", "reg_no", "registration", "bate", "masjien", "voertuig", "naam"],
  date: ["date", "reading_date", "day", "datum"],
  reading: ["reading", "meter", "hours", "km", "odometer", "hour_meter", "lesing", "ure", "meterlesing"],
  unit: ["unit", "units", "eenheid"],
};
const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Which column holds each field, by header name (English or Afrikaans); -1 when absent. */
export function sheetColumns(headers: readonly string[]): Record<keyof typeof HEADERS, number> {
  const names = headers.map(norm);
  const find = (aliases: readonly string[]) => names.findIndex((h) => aliases.includes(h));
  return { asset: find(HEADERS.asset), date: find(HEADERS.date), reading: find(HEADERS.reading), unit: find(HEADERS.unit) };
}

/**
 * A date's separators only: 2026/11/10 and 2026.11.10 become ISO, 10-11-2026 and 10.11.2026 become
 * day-first. The order of day and month is never guessed or swapped; anything else goes through as
 * typed and the database names it date_invalid for a person to fix.
 */
export function normaliseDate(raw: string): string {
  const v = raw.trim();
  if (/^\d{4}[/.]\d{1,2}[/.]\d{1,2}$/.test(v)) return v.replace(/[/.]/g, "-");
  if (/^\d{1,2}[-.]\d{1,2}[-.]\d{4}$/.test(v)) return v.replace(/[-.]/g, "/");
  return v;
}

/**
 * A readings sheet (CSV with a header row) into rows for staging. Row numbers are the sheet's own
 * (the header is row 1), so the review screen and the spreadsheet agree; blank lines are skipped
 * but keep their number. Cells are passed as typed: nothing is filled in or corrected here.
 */
export function readingsSheet(text: string): SheetResult {
  const table = parseCsv(text, { keepBlank: true });
  const blank = (cells: string[]) => cells.every((c) => !c.trim());
  const h = table.findIndex((cells) => !blank(cells));
  if (h < 0) return { ok: false, error: "import-empty" };
  const cols = sheetColumns(table[h]);
  if (cols.asset < 0 || cols.date < 0 || cols.reading < 0) return { ok: false, error: "import-header" };
  const rows: SheetRow[] = [];
  for (let i = h + 1; i < table.length; i++) {
    const cells = table[i];
    if (blank(cells)) continue;
    // The database numbers rows 1 to 10000; a sheet padded with blank lines past that is refused here.
    if (rows.length >= READINGS_IMPORT_MAX_ROWS || i + 1 > 10000) return { ok: false, error: "import-too-many" };
    const cell = (n: number) => (n >= 0 ? (cells[n] ?? "").trim() : "");
    const row: SheetRow = {
      row_no: i + 1,
      asset: cell(cols.asset).slice(0, 120),
      date: normaliseDate(cell(cols.date)).slice(0, 40),
      reading: cell(cols.reading).slice(0, 40),
      source_text: cells.join(", ").slice(0, 500),
    };
    const unit = cell(cols.unit);
    if (unit) row.unit = unit.slice(0, 20);
    rows.push(row);
  }
  return rows.length === 0 ? { ok: false, error: "import-empty" } : { ok: true, rows };
}

/** The template a person can download and fill in. */
export function readingsTemplate(): string {
  return "asset,date,reading,unit\nTractor 1,2026-11-10,1234.5,hours\nBakkie,10/11/2026,85400,km\n";
}
