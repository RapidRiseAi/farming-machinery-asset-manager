// Small, dependency-free CSV parser + machine-row validator, shared by the client
// preview and the server insert action so both agree on what's valid.

import { MACHINE_TYPES, MACHINE_STATUSES, METER_TYPES, defaultMeterFor as defaultMeterOf } from "@/lib/machine-options";

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
  // The day the reading was taken (20261105). A reading without one is dated today, and
  // the preview says so on that row rather than inventing the date silently.
  "reading_date",
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

type MachineInsert = {
  name: string;
  type: string;
  make: string | null;
  model: string | null;
  year: number | null;
  serial_no: string | null;
  reg_no: string | null;
  meter_type: string;
  current_reading: number | null;
  /** YYYY-MM-DD from the sheet, or null: the server then dates the reading today. */
  current_reading_date: string | null;
  status: string;
  notes: string | null;
};

type RowResult = {
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

/**
 * What is already on the farm, so a re-run of the same sheet does not add the fleet twice.
 * Serial and registration identify a machine; a name does not (two "Bakkie"s are normal),
 * so a matching name only warns.
 */
export type ExistingMachines = { names: string[]; serials: string[]; regs: string[] };

/** Case, spaces and dashes do not make a different serial or registration. */
export const idKey = (v: string) => v.toUpperCase().replace(/[\s-]/g, "");

/** Today as YYYY-MM-DD on the farm's calendar. */
function farmToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/**
 * A reading date as the sheet spells it, to YYYY-MM-DD, or null when it is not a real day.
 * ISO (2026-07-29, 2026/07/29) and South African day-first (29/07/2026, 29-07-2026).
 * Month-first is not accepted: "07/08/2026" means 7 August here, and guessing the other
 * way would quietly date a reading a month out.
 */
export function parseReadingDate(raw: string): string | null {
  const v = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
  if (match) { y = +match[1]; m = +match[2]; d = +match[3]; }
  else if ((match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(v))) { d = +match[1]; m = +match[2]; y = +match[3]; }
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The meter a machine type normally has, the same default the Add machine form uses. */
export function defaultMeterFor(type: string): "hours" | "km" {
  return defaultMeterOf(type) === "km" ? "km" : "hours";
}

/** Parse + validate a machines CSV. Returns per-row results for the preview and
 *  the valid MachineInsert objects for the server to persist. */
export function validateCsv(
  text: string,
  existing: ExistingMachines = { names: [], serials: [], regs: [] },
  today: string = farmToday(),
): ParseResult {
  const onFarm = {
    names: new Set(existing.names.map((n) => n.trim().toLowerCase())),
    serials: new Set(existing.serials.map(idKey)),
    regs: new Set(existing.regs.map(idKey)),
  };
  const seenSerials = new Set<string>();
  const seenRegs = new Set<string>();
  const grid = parseCsv(text);
  if (grid.length === 0) {
    return { headerError: "empty", headerFound: [], rows: [], validCount: 0, invalidCount: 0 };
  }
  const header = grid[0].map(norm);
  // Report the header back in the user's own spelling, the normalised form is ours.
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

    // A blank meter type follows the machine type (a bakkie is in kilometres), and a blank
    // status is active; both are shown on the row so a kilometre truck is not imported as
    // hours without anybody seeing it.
    const meterRaw = get("meter_type").toLowerCase();
    const meter_type = meterRaw || defaultMeterFor(type);
    if (!meterRaw) warnings.push(meter_type === "km" ? "meter_defaulted_km" : "meter_defaulted_hours");
    if (!METER_TYPES.includes(meter_type as (typeof METER_TYPES)[number])) errors.push("meter_invalid");

    const statusRaw = get("status").toLowerCase();
    const status = statusRaw || "active";
    if (!statusRaw) warnings.push("status_defaulted");
    if (!MACHINE_STATUSES.includes(status as (typeof MACHINE_STATUSES)[number])) errors.push("status_invalid");

    const yearStr = get("year");
    let year: number | null = null;
    if (yearStr) {
      // A whole four-digit year only: parseInt read "2019abc" or "20.5" as a year.
      const y = /^\d{4}$/.test(yearStr) ? Number(yearStr) : NaN;
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
    // "none" is a machine without a meter, not an unknown reading.
    if (current_reading !== null && meter_type === "none") errors.push("reading_without_meter");

    const dateStr = get("reading_date");
    let current_reading_date: string | null = null;
    if (dateStr) {
      const parsedDate = parseReadingDate(dateStr);
      if (!parsedDate || parsedDate < "1990-01-01") errors.push("reading_date_invalid");
      else if (parsedDate > today) errors.push("reading_date_future");
      else if (current_reading === null) warnings.push("reading_date_unused");
      else current_reading_date = parsedDate;
    } else if (current_reading !== null) {
      warnings.push("reading_date_today");
    }

    // Already on the farm, or twice in this sheet: refused, so running the same file
    // again adds nothing. Only serial and registration count; names only warn.
    const serial = get("serial_no");
    const reg = get("reg_no");
    if (serial) {
      const k = idKey(serial);
      if (onFarm.serials.has(k)) errors.push("serial_on_farm");
      else if (seenSerials.has(k)) errors.push("serial_twice");
      seenSerials.add(k);
    }
    if (reg) {
      const k = idKey(reg);
      if (onFarm.regs.has(k)) errors.push("reg_on_farm");
      else if (seenRegs.has(k)) errors.push("reg_twice");
      seenRegs.add(k);
    }
    if (name && onFarm.names.has(name.toLowerCase())) warnings.push("name_on_farm");

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
            current_reading_date,
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
    "Groen John Deere,tractor,John Deere,6155M,2019,1LV6155MABC123,CA123456,hours,4200,2026-10-01,active,Main tractor",
    "Rooi Massey,tractor,Massey Ferguson,5710,2016,,,hours,7800,15/09/2026,active,",
    "Waterpomp Noord,pump_generator,Honda,WB30,2021,,,none,,,standby,Borehole 3",
  ].join("\n");
  return `${header}\n${example}\n`;
}

// == Column mapping ===========================================================
//
// Headers used to be validated against a fixed set, so a real farm's spreadsheet -
// Afrikaans headings, columns in a different order, an extra column the office added -
// failed wholesale. Every farm already has a machine list; making them retype it into
// our template is why import did not get used.
//
// Mapping happens entirely in the BROWSER: the user's grid is re-serialised into the
// canonical column order before it is posted, so `importMachines` and `validateCsv`
// still receive exactly the sheet they always did. Nothing server-side changes.

/** "Leave this column out", a real choice, not an absent one. */
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
  reading_date: ["readingdate", "dateread", "readon", "lesingdatum", "datumgelees", "meterdate", "meterdatum"],
  status: ["status", "toestand", "state", "condition"],
  notes: ["notes", "note", "notas", "nota", "opmerkings", "comment", "comments", "kommentaar", "remarks"],
};

/** Strip everything that varies between spellings: case, spaces, punctuation. */
const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Guess which canonical column each of the user's headings means. Returns one entry per
 * header in the file, in file order; `SKIP_COLUMN` means "leave it out". A canonical
 * column is never guessed twice, the first, best match wins and later look-alikes fall
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

/** The header row as the file spells it, what the mapping UI shows on the left. */
export function readHeaders(text: string): string[] {
  const grid = parseCsv(text);
  return grid.length === 0 ? [] : grid[0].map((h) => h.trim());
}

/** How many data rows the file has, for "31 of your 34 rows are ready". */
export function countDataRows(text: string): number {
  return Math.max(0, parseCsv(text).length - 1);
}
