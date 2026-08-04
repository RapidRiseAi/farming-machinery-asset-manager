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
  /** The header cells we actually read, so a failure can name them back to the user. */
  headerFound: string[];
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
    return { headerError: "empty", headerFound: [], rows: [], validCount: 0, invalidCount: 0 };
  }
  const header = grid[0].map(norm);
  // Report the header back in the user's own spelling — the normalised form is ours.
  const headerFound = grid[0].map((h) => h.trim()).filter((h) => h !== "");
  if (!header.includes("name")) {
    return {
      headerError: "missing_name_column",
      headerFound,
      rows: [],
      validCount: 0,
      invalidCount: 0,
    };
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
    headerFound,
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

// ── Column mapping ───────────────────────────────────────────────────────────
//
// Headers used to be validated against a fixed set, so a real farm's spreadsheet —
// Afrikaans headings, columns in a different order, an extra column the office added —
// failed wholesale. Every farm already has a machine list; making them retype it into
// our template is why import did not get used.
//
// Mapping happens entirely in the BROWSER: the user's grid is re-serialised into the
// canonical column order before it is posted, so `importMachines` and `validateCsv`
// still receive exactly the sheet they always did. Nothing server-side changes.

/** "Leave this column out" — a real choice, not an absent one. */
export const SKIP_COLUMN = "";

/**
 * What a farm is likely to call each of our columns. Afrikaans first-class, because
 * invites default to `af` and these sheets are usually written by the farm office.
 */
const ALIASES: Record<(typeof IMPORT_COLUMNS)[number], string[]> = {
  name: ["name", "naam", "machine", "masjien", "voertuig", "vehicle", "asset", "bate", "beskrywing", "description", "item"],
  type: ["type", "tipe", "soort", "kind", "category", "kategorie", "klas", "class"],
  make: ["make", "merk", "brand", "handelsmerk", "manufacturer", "vervaardiger"],
  model: ["model", "modelnommer", "modelno", "variant"],
  year: ["year", "jaar", "modelyear", "jaarmodel", "yearmodel"],
  serial_no: ["serialno", "serial", "serialnumber", "serienommer", "serienr", "vin", "chassis", "chassisno", "engineno"],
  reg_no: ["regno", "reg", "registration", "registrasie", "registrasienommer", "numberplate", "nommerplaat", "licenceplate", "licenseplate", "plate"],
  meter_type: ["metertype", "meter", "metertipe", "unit", "eenheid", "measure"],
  current_reading: ["currentreading", "reading", "lesing", "hours", "ure", "uur", "hourmeter", "uurmeter", "km", "kilometers", "kilometres", "odometer", "odo", "mileage"],
  status: ["status", "toestand", "state", "condition"],
  notes: ["notes", "note", "notas", "nota", "opmerkings", "comment", "comments", "kommentaar", "remarks"],
};

/** Strip everything that varies between spellings: case, spaces, punctuation. */
const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Guess which canonical column each of the user's headings means. Returns one entry per
 * header in the file, in file order; `SKIP_COLUMN` means "leave it out". A canonical
 * column is never guessed twice — the first, best match wins and later look-alikes fall
 * through to skip, so the user resolves the ambiguity rather than us silently picking.
 */
export function guessMapping(headers: string[]): string[] {
  const taken = new Set<string>();
  const exact: string[] = headers.map(() => SKIP_COLUMN);

  // Pass 1: exact alias hits, which are the confident ones.
  headers.forEach((h, i) => {
    const k = key(h);
    for (const col of IMPORT_COLUMNS) {
      if (taken.has(col)) continue;
      if (ALIASES[col].some((a) => key(a) === k)) {
        exact[i] = col;
        taken.add(col);
        return;
      }
    }
  });

  // Pass 2: substring hits for the ones still unclaimed ("hours worked", "reg nr").
  headers.forEach((h, i) => {
    if (exact[i] !== SKIP_COLUMN) return;
    const k = key(h);
    if (!k) return;
    for (const col of IMPORT_COLUMNS) {
      if (taken.has(col)) continue;
      if (ALIASES[col].some((a) => k.includes(key(a)) || key(a).includes(k))) {
        exact[i] = col;
        taken.add(col);
        return;
      }
    }
  });

  return exact;
}

/**
 * Re-serialise the user's sheet into our canonical column order using `mapping`
 * (one entry per source column). The result is an ordinary CSV that `validateCsv` and
 * `importMachines` read exactly as if the farm had used our template.
 */
export function applyMapping(text: string, mapping: string[]): string {
  const grid = parseCsv(text);
  if (grid.length === 0) return "";

  const sourceFor = new Map<string, number>();
  mapping.forEach((col, i) => {
    if (col && !sourceFor.has(col)) sourceFor.set(col, i);
  });

  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const out: string[] = [IMPORT_COLUMNS.join(",")];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    out.push(
      IMPORT_COLUMNS.map((col) => {
        const i = sourceFor.get(col);
        return i == null ? "" : esc((row[i] ?? "").trim());
      }).join(","),
    );
  }
  return out.join("\n") + "\n";
}

/** The header row as the file spells it — what the mapping UI shows on the left. */
export function readHeaders(text: string): string[] {
  const grid = parseCsv(text);
  return grid.length === 0 ? [] : grid[0].map((h) => h.trim());
}

/** How many data rows the file has, for "31 of your 34 rows are ready". */
export function countDataRows(text: string): number {
  return Math.max(0, parseCsv(text).length - 1);
}
