// Small, dependency-free CSV parser + machine-row validator, shared by the client
// preview and the server insert action so both agree on what's valid.

import { MACHINE_TYPES, MACHINE_STATUSES, METER_TYPES } from "@/lib/machine-options";

export const IMPORT_COLUMNS = [
  "name",
  "type",
  "make",
  "model",
  "year",
  "serial_no",
  "reg_no",
  "meter_type",
  "current_reading",
  "status",
  "notes",
] as const;

export const MAX_IMPORT_ROWS = 200;

/** Parse CSV text into rows of string cells. Handles quotes, escaped quotes,
 *  commas/newlines inside quotes, CRLF, and a leading BOM. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += c;
    }
  }
  // trailing cell/row (unless file ended exactly on a newline with nothing pending)
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export type MachineInsert = {
  name: string;
  type: string;
  make: string | null;
  model: string | null;
  year: number | null;
  serial_no: string | null;
  reg_no: string | null;
  meter_type: string;
  current_reading: number | null;
  status: string;
  notes: string | null;
};

export type RowResult = {
  line: number; // 1-based data row number (excludes header)
  cells: Record<string, string>;
  errors: string[];
  warnings: string[];
  valid: boolean;
  machine?: MachineInsert;
};

export type ParseResult = {
  headerError: string | null;
  rows: RowResult[];
  validCount: number;
  invalidCount: number;
};

const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, "_");

/** Parse + validate a machines CSV. Returns per-row results for the preview and
 *  the valid MachineInsert objects for the server to persist. */
export function validateCsv(text: string): ParseResult {
  const grid = parseCsv(text);
  if (grid.length === 0) {
    return { headerError: "empty", rows: [], validCount: 0, invalidCount: 0 };
  }
  const header = grid[0].map(norm);
  if (!header.includes("name")) {
    return { headerError: "missing_name_column", rows: [], validCount: 0, invalidCount: 0 };
  }
  const idx = (col: string) => header.indexOf(col);

  const seen = new Map<string, number>();
  const rows: RowResult[] = [];
  for (let r = 1; r < grid.length; r++) {
    const raw = grid[r];
    const get = (col: string) => {
      const i = idx(col);
      return i >= 0 && i < raw.length ? raw[i].trim() : "";
    };
    const cells: Record<string, string> = {};
    for (const c of IMPORT_COLUMNS) cells[c] = get(c);

    const errors: string[] = [];
    const warnings: string[] = [];

    const name = get("name");
    if (!name) errors.push("name_required");

    const type = get("type").toLowerCase();
    if (!type) errors.push("type_required");
    else if (!MACHINE_TYPES.includes(type as (typeof MACHINE_TYPES)[number])) errors.push("type_invalid");

    const meter_type = get("meter_type").toLowerCase() || "hours";
    if (!METER_TYPES.includes(meter_type as (typeof METER_TYPES)[number])) errors.push("meter_invalid");

    const status = get("status").toLowerCase() || "active";
    if (!MACHINE_STATUSES.includes(status as (typeof MACHINE_STATUSES)[number])) errors.push("status_invalid");

    const yearStr = get("year");
    let year: number | null = null;
    if (yearStr) {
      const y = Number.parseInt(yearStr, 10);
      if (!Number.isFinite(y) || y < 1900 || y > 2100) errors.push("year_invalid");
      else year = y;
    }

    const readingStr = get("current_reading");
    let current_reading: number | null = null;
    if (readingStr) {
      const n = Number(readingStr);
      if (!Number.isFinite(n) || n < 0) errors.push("reading_invalid");
      else current_reading = n;
    }

    if (name) {
      const key = name.toLowerCase();
      if (seen.has(key)) warnings.push("duplicate_name");
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    const valid = errors.length === 0;
    rows.push({
      line: r,
      cells,
      errors,
      warnings,
      valid,
      machine: valid
        ? {
            name,
            type,
            make: get("make") || null,
            model: get("model") || null,
            year,
            serial_no: get("serial_no") || null,
            reg_no: get("reg_no") || null,
            meter_type,
            current_reading,
            status,
            notes: get("notes") || null,
          }
        : undefined,
    });
  }

  return {
    headerError: null,
    rows,
    validCount: rows.filter((r) => r.valid).length,
    invalidCount: rows.filter((r) => !r.valid).length,
  };
}

/** The template CSV a user downloads, fills in, and re-uploads. */
export function templateCsv(): string {
  const header = IMPORT_COLUMNS.join(",");
  const example = [
    "Groen John Deere,tractor,John Deere,6155M,2019,1LV6155MABC123,CA123456,hours,4200,active,Main tractor",
    "Rooi Massey,tractor,Massey Ferguson,5710,2016,,,hours,7800,active,",
    "Waterpomp Noord,pump_generator,Honda,WB30,2021,,,none,,standby,Borehole 3",
  ].join("\n");
  return `${header}\n${example}\n`;
}
