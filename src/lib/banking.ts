/**
 * Bank statement import + reconciliation (G15) — the parsing and the matching, in one
 * place so the browser preview and the server insert can never disagree about what a file
 * says. Same reason `src/lib/fuel.ts` mirrors the SQL consumption engine: a preview that
 * shows one thing and an import that stores another is worse than no preview.
 *
 * Nothing in here touches the database. It turns a bank's CSV into candidate rows, and it
 * RANKS possible settlements — it never decides one. The deciding is a person pressing a
 * button, because a wrong automatic match writes money into the ledger and then hides the
 * evidence by removing the line from the list that would have shown it.
 */

import { parseRandsToCents } from "@/lib/money";

// ── CSV ──────────────────────────────────────────────────────────────────────
//
// Written out again rather than imported from the machines importer. That parser lives
// under `src/app/(app)/machines/import/`, which is a route folder: importing app-route
// code into `src/lib` inverts the dependency direction the rest of the codebase uses, and
// this file is imported by both a server action and a client component. Sixty lines of a
// well-understood grammar is the cheaper of the two prices.

/** Parse CSV text into rows of string cells. Handles quotes, escaped quotes, commas and
 *  newlines inside quotes, CRLF, and a leading BOM. */
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
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

// ── Column mapping ───────────────────────────────────────────────────────────
//
// Every South African bank exports a different sheet, and none of them export ours. FNB
// gives Date/Description/Amount/Balance; Standard Bank and ABSA commonly split the money
// into two columns; Nedbank puts the reference in its own column; a partner's bookkeeper
// hands over something re-ordered with three extra columns in it. So the same answer the
// machines import arrived at applies here: guess, show the guess with a real value from
// the file next to it, and let the person correct it.
//
// `money_in` / `money_out` exist because the split-column shape is not exotic — it is what
// two of the four big banks produce. Without it the feature simply does not work for them,
// and "export it differently first" is not an instruction a farmer's mechanic will follow.

export const BANK_COLUMNS = ["date", "description", "reference", "amount", "money_in", "money_out"] as const;
export type BankColumn = (typeof BANK_COLUMNS)[number];

/** "Leave this column out" — a real choice, not an absent one. */
export const SKIP_COLUMN = "";

export const MAX_STATEMENT_ROWS = 2000;

/**
 * What a bank is likely to call each of our columns. Afrikaans is first-class for the same
 * reason it is in the machines importer: plenty of these files are produced or renamed by
 * an Afrikaans-speaking office before anyone uploads them.
 */
const ALIASES: Record<BankColumn, string[]> = {
  date: ["date", "datum", "transactiondate", "transaksiedatum", "postingdate", "valuedate", "effectivedate", "processdate", "boekdatum", "dat"],
  description: ["description", "beskrywing", "narrative", "details", "detail", "transactiondescription", "particulars", "memo", "payee", "narration", "besonderhede", "transaksie"],
  reference: ["reference", "verwysing", "ref", "yourreference", "theirreference", "customerreference", "statementreference", "chequenumber", "trnref", "refno", "verw"],
  amount: ["amount", "bedrag", "value", "transactionamount", "amountzar", "waarde", "nett", "net"],
  money_in: ["moneyin", "credit", "credits", "creditamount", "deposit", "deposits", "in", "received", "krediet", "inbetaling", "ontvang"],
  money_out: ["moneyout", "debit", "debits", "debitamount", "withdrawal", "withdrawals", "out", "paid", "payment", "debiet", "uitbetaling", "onttrekking"],
};

/** Strip everything that varies between spellings: case, spaces, punctuation. */
const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Guess which of our columns each of the file's headings means. One entry per header, in
 * file order; `SKIP_COLUMN` means "leave it out". A column is never guessed twice — the
 * first, best match wins and later look-alikes fall through to skip, so an ambiguity is
 * resolved by the person who can see the file rather than silently by us.
 */
export function guessBankMapping(headers: string[]): string[] {
  const taken = new Set<string>();
  const out: string[] = headers.map(() => SKIP_COLUMN);

  // Pass 1: exact alias hits, which are the confident ones. "Balance" matches nothing here
  // on purpose — a running balance is not a transaction and importing it as one would put
  // the whole account into the ledger as a single receipt.
  headers.forEach((h, i) => {
    const k = key(h);
    for (const col of BANK_COLUMNS) {
      if (taken.has(col)) continue;
      if (ALIASES[col].some((a) => key(a) === k)) {
        out[i] = col;
        taken.add(col);
        return;
      }
    }
  });

  // Pass 2: substring hits for what is still unclaimed ("transaction date", "debit (ZAR)").
  headers.forEach((h, i) => {
    if (out[i] !== SKIP_COLUMN) return;
    const k = key(h);
    if (!k) return;
    for (const col of BANK_COLUMNS) {
      if (taken.has(col)) continue;
      if (ALIASES[col].some((a) => k.includes(key(a)) || key(a).includes(k))) {
        out[i] = col;
        taken.add(col);
        return;
      }
    }
  });

  return out;
}

/**
 * Re-serialise the user's sheet into our canonical column order. The result is an ordinary
 * CSV that `parseStatement` reads without knowing anything about which bank produced it —
 * which is what lets the mapping happen in the BROWSER and the server receive one shape.
 */
export function applyBankMapping(text: string, mapping: string[]): string {
  const grid = parseCsv(text);
  if (grid.length === 0) return "";

  const sourceFor = new Map<string, number>();
  mapping.forEach((col, i) => {
    if (col && !sourceFor.has(col)) sourceFor.set(col, i);
  });

  const out: string[] = [BANK_COLUMNS.join(",")];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    out.push(
      BANK_COLUMNS.map((col) => {
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

/** The first data row, so each mapping choice can be shown next to a real value. */
export function readSampleRow(text: string): string[] {
  const grid = parseCsv(text);
  return grid[1] ?? [];
}

// ── Money ────────────────────────────────────────────────────────────────────

/**
 * Parse an amount as a BANK writes it, to signed integer cents, with no float arithmetic.
 *
 * The shapes seen in real exports, all of which mean the same number:
 *
 *     1234.56    1 234,56    1,234.56    R1 234,56    -1234.56
 *     (1234.56)  1234.56-    1 234,56 Dr    1234.56 CR    −1234.56   [U+2212]
 *
 * Parentheses and a trailing `Dr` both mean money OUT — accounting notation that survives
 * in bank exports and in anything that has passed through Excel. A trailing minus is what
 * some mainframe-era statements produce. All of them end up as a negative integer.
 *
 * The separator question is the one that can silently corrupt a figure: is `1,234` one
 * thousand two hundred and thirty four, or one rand twenty-three? The rule used here is the
 * one that is right for both South African and imported-from-Excel files: whichever
 * separator appears LAST is the decimal point, and only if exactly one or two digits follow
 * it. `1,234` therefore reads as 1 234 (three digits after, so it is a group separator) and
 * `1,23` as R1,23. Anything that does not reduce to digits and at most one decimal point is
 * refused outright rather than guessed at, because a wrong amount here becomes a wrong
 * payment against a real invoice.
 */
export function parseBankAmountToCents(input: string | null | undefined): number | null {
  if (input == null) return null;
  let s = String(input)
    // Every flavour of space a spreadsheet or a bank emits, including the non-breaking and
    // narrow non-breaking spaces SA statements use as the thousands separator.
    .replace(/[\s   ]/g, "")
    .trim();
  if (s === "") return null;

  let negative = false;

  // Accounting parentheses wrap the whole thing, so they are peeled first.
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  // The real minus sign, which anything that has passed through Excel is apt to emit.
  s = s.replace(/[−]/g, "-");
  // Split into the number and whatever decorates it, and read the decoration as a whole.
  // That is what makes "-R1234.56", "1234.56-" and "1 234,56 Dr" all resolvable without a
  // cascade of leading/trailing special cases, each of which has to be got right on its own.
  const shape = s.match(/^([^\d]*)([\d.,]+)([^\d]*)$/);
  if (!shape) return null;
  const deco = `${shape[1]}${shape[3]}`.toLowerCase();
  s = shape[2];

  if (deco.includes("-")) negative = !negative;
  if (deco.includes("dr") || deco.includes("debit")) negative = true;

  // Anything left over after the decorations we know about is not an amount — a
  // "Balance b/f" row, a footnote marker, a currency this product does not deal in.
  // Refused rather than guessed at.
  if (deco.replace(/zar|credit|debit|cr|dr|[r+-]/g, "") !== "") return null;

  // Which separator is the decimal point: whichever appears LAST, and only when one or two
  // digits follow it. Everything else is a group separator and goes.
  const lastSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  if (lastSep >= 0) {
    const tail = s.slice(lastSep + 1);
    s = /^\d{1,2}$/.test(tail)
      ? `${s.slice(0, lastSep).replace(/[.,]/g, "")}.${tail}`
      : s.replace(/[.,]/g, "");
  }

  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;

  // Handed to the shared parser so a bank amount and a typed amount round identically.
  const cents = parseRandsToCents(s);
  if (cents == null) return null;
  return negative ? -cents : cents;
}

// ── Dates ────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  // The four Afrikaans abbreviations that differ from the English ones. A statement
  // downloaded from a bank's Afrikaans interface uses them, and there is no reason a farm's
  // mechanic should have to notice why the import failed.
  mrt: 3, mei: 5, okt: 10, des: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

/** A real calendar date, rejecting 31 February and friends without constructing anything
 *  the caller has to trust a timezone about. */
function iso(y: number, m: number, d: number): string | null {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < 1970 || y > 2999) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const fullYear = (y: number) => (y >= 100 ? y : y >= 70 ? 1900 + y : 2000 + y);

/**
 * Parse a date as a bank writes it, to `YYYY-MM-DD`.
 *
 * Day-first when the two are ambiguous, because this is a South African product and
 * `03/04/2026` on a local statement is the third of April. Where the file removes the
 * ambiguity — a first number above 12, or an ISO-shaped string — that wins over the
 * convention. There is no way to be right about `03/04` in every file in the world; there
 * is a way to be right about the ones this product actually receives, and to be predictable
 * about the rest.
 */
export function parseBankDate(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (s === "") return null;

  // ISO, with any of the three separators.
  const isoish = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoish) return iso(Number(isoish[1]), Number(isoish[2]), Number(isoish[3]));

  // Compact YYYYMMDD, which several bank exports use.
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return iso(Number(compact[1]), Number(compact[2]), Number(compact[3]));

  // Named month: 13 Aug 2026 / 13-Aug-26 / Aug 13 2026.
  const named = s.match(/^(\d{1,2})[\s\-/]*([A-Za-z]{3,})[\s\-/]*(\d{2,4})$/);
  if (named) {
    const m = MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (m) return iso(fullYear(Number(named[3])), m, Number(named[1]));
  }
  const namedFirst = s.match(/^([A-Za-z]{3,})[\s\-/]*(\d{1,2}),?[\s\-/]*(\d{2,4})$/);
  if (namedFirst) {
    const m = MONTHS[namedFirst[1].slice(0, 3).toLowerCase()];
    if (m) return iso(fullYear(Number(namedFirst[3])), m, Number(namedFirst[2]));
  }

  // Numeric, ambiguous order.
  const parts = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (parts) {
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    const y = fullYear(Number(parts[3]));
    // A value above 12 can only be a day, whichever side it is on. Otherwise: day first.
    if (a > 12 && b <= 12) return iso(y, b, a);
    if (b > 12 && a <= 12) return iso(y, a, b);
    return iso(y, b, a);
  }

  return null;
}

// ── Parsing a whole statement ────────────────────────────────────────────────

export type BankLineInsert = {
  txn_date: string;
  description: string | null;
  reference: string | null;
  amount_cents: number;
  row_no: number;
  occurrence: number;
};

export type BankRowResult = {
  /** 1-based data row (excludes the header) — what the person sees next to the problem. */
  line: number;
  cells: Record<BankColumn, string>;
  errors: string[];
  valid: boolean;
  row?: BankLineInsert;
};

export type StatementParse = {
  headerError: "empty" | "missing_date" | "missing_amount" | null;
  headerFound: string[];
  rows: BankRowResult[];
  validCount: number;
  invalidCount: number;
  /** Signed totals, so the preview can be checked against the statement's own footer. */
  inCents: number;
  outCents: number;
  firstDate: string | null;
  lastDate: string | null;
};

/**
 * The comparable form of a line's free text. This MUST agree with the `fingerprint`
 * generated column in migration 0470, because that column is half of the unique index that
 * makes a re-import a no-op. If the two ever drift, re-importing starts producing
 * duplicates again and nothing in the app will say so.
 */
export function fingerprint(description: string | null, reference: string | null): string {
  return `${description ?? ""} ${reference ?? ""}`.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
}

/**
 * Read a canonical statement (the sheet after mapping) into rows ready to insert.
 *
 * `occurrence` is assigned here: within this file, the nth line sharing a date, an amount
 * and a fingerprint gets the nth number. It is deterministic given the file, which is the
 * property the unique index in 0470 relies on — the same file re-imported produces the same
 * numbering and collides harmlessly, while a genuinely repeated charge (the same R50 card
 * fee twice in one day) takes the next number and is kept.
 */
export function parseStatement(canonicalCsv: string): StatementParse {
  const grid = parseCsv(canonicalCsv);
  const empty: StatementParse = {
    headerError: "empty", headerFound: [], rows: [], validCount: 0, invalidCount: 0,
    inCents: 0, outCents: 0, firstDate: null, lastDate: null,
  };
  if (grid.length === 0) return empty;

  const header = grid[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const headerFound = grid[0].map((h) => h.trim()).filter((h) => h !== "");
  const idx = (c: BankColumn) => header.indexOf(c);

  if (idx("date") < 0) return { ...empty, headerError: "missing_date", headerFound };
  if (idx("amount") < 0 && idx("money_in") < 0 && idx("money_out") < 0) {
    return { ...empty, headerError: "missing_amount", headerFound };
  }

  const seen = new Map<string, number>();
  const rows: BankRowResult[] = [];
  let inCents = 0;
  let outCents = 0;
  const dates: string[] = [];

  for (let r = 1; r < grid.length; r++) {
    const raw = grid[r];
    const get = (c: BankColumn) => {
      const i = idx(c);
      return i >= 0 && i < raw.length ? raw[i].trim() : "";
    };
    const cells = {} as Record<BankColumn, string>;
    for (const c of BANK_COLUMNS) cells[c] = get(c);

    const errors: string[] = [];

    const txn_date = parseBankDate(cells.date);
    if (!txn_date) errors.push(cells.date === "" ? "date_missing" : "date_invalid");

    // A single signed column wins when it is present; otherwise the in/out pair is
    // combined. Both are read even when both exist, because some exports carry a signed
    // "amount" AND a redundant debit column, and the signed one is the unambiguous half.
    let amount_cents: number | null = null;
    if (cells.amount !== "") {
      amount_cents = parseBankAmountToCents(cells.amount);
      if (amount_cents == null) errors.push("amount_invalid");
    } else {
      const inC = cells.money_in === "" ? null : parseBankAmountToCents(cells.money_in);
      const outC = cells.money_out === "" ? null : parseBankAmountToCents(cells.money_out);
      if (cells.money_in !== "" && inC == null) errors.push("amount_invalid");
      if (cells.money_out !== "" && outC == null) errors.push("amount_invalid");
      if (inC != null || outC != null) {
        // A split column carries the magnitude; the column it sits in carries the sign, so
        // a bank that writes its debits as positive numbers is read correctly either way.
        amount_cents = Math.abs(inC ?? 0) - Math.abs(outC ?? 0);
      }
    }
    if (amount_cents == null && !errors.includes("amount_invalid")) errors.push("amount_missing");
    // A zero line is a brought-forward balance or a heading the parser took for data. It is
    // refused rather than stored, matching the `bank_lines_amount_ck` constraint.
    if (amount_cents === 0) errors.push("amount_zero");

    const description = cells.description || null;
    const reference = cells.reference || null;

    const valid = errors.length === 0 && txn_date != null && amount_cents != null;
    let row: BankLineInsert | undefined;
    if (valid && txn_date && amount_cents != null) {
      const k = `${txn_date}|${amount_cents}|${fingerprint(description, reference)}`;
      const occurrence = (seen.get(k) ?? 0) + 1;
      seen.set(k, occurrence);
      row = { txn_date, description, reference, amount_cents, row_no: r, occurrence };
      if (amount_cents > 0) inCents += amount_cents;
      else outCents += -amount_cents;
      dates.push(txn_date);
    }

    rows.push({ line: r, cells, errors, valid, row });
  }

  dates.sort();
  return {
    headerError: null,
    headerFound,
    rows,
    validCount: rows.filter((r) => r.valid).length,
    invalidCount: rows.filter((r) => !r.valid).length,
    inCents,
    outCents,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
  };
}

// ── Matching ─────────────────────────────────────────────────────────────────
//
// A suggestion is a RANKED GUESS shown to a person, never a decision. The scores below are
// tuned so that no single weak signal reaches the threshold on its own: an amount that
// happens to be equal is enough (people pay invoices in full), a reference containing the
// invoice number is enough, but "it is roughly the right size and roughly the right month"
// is not — that is the class of match that gets confirmed by a tired person on a Friday and
// then has to be unpicked out of a statement three weeks later.

export type BankLineLike = {
  id: string;
  txn_date: string;
  description: string | null;
  reference: string | null;
  amount_cents: number;
};

export type InvoiceCandidate = {
  id: string;
  number: string;
  bill_to_name: string | null;
  issue_date: string;
  due_date: string | null;
  total_cents: number;
  amount_paid_cents: number;
};

export type ExpenseCandidate = {
  id: string;
  supplier_name: string;
  reference: string | null;
  expense_date: string;
  amount_cents: number;
  vat_cents: number;
};

export type MatchConfidence = "strong" | "likely" | "possible";

export type Suggestion = {
  targetId: string;
  score: number;
  confidence: MatchConfidence;
  /** i18n key suffixes — the screen renders `bank.why.<reason>`. Never a sentence: this
   *  module has no business deciding what language the reader wants. */
  reasons: string[];
  /** What confirming would post, in cents. Positive; the direction is the line's. */
  amountCents: number;
  /** What is still owed on the target, for the confirmation dialog to show side by side. */
  outstandingCents: number;
};

const MATCH_THRESHOLD = 45;
const MAX_SUGGESTIONS = 4;

const days = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

const norm = (s: string | null | undefined) => (s ?? "").replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();

/** Words worth looking for in a bank narrative. Short ones ("Ltd", "the", "CC") match
 *  everything and would turn the name signal into noise. */
function nameTokens(name: string | null | undefined): string[] {
  return (name ?? "")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4 && !["pty", "ltd", "limited", "trust", "boerdery", "farms", "farm"].includes(w));
}

function confidenceOf(score: number): MatchConfidence {
  if (score >= 85) return "strong";
  if (score >= 60) return "likely";
  return "possible";
}

/** The reference/description signal, shared by both directions. */
function textScore(haystack: string, ref: string | null, name: string | null): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const needle = norm(ref);
  if (needle.length >= 3 && haystack.includes(needle)) {
    score += 38;
    reasons.push("reference");
  } else {
    // Banks truncate references hard — 20 characters is common — so an invoice numbered
    // `INV-0007` frequently reaches the statement as `0007` or `TJ0007`. The digits alone
    // are a weaker signal and are scored as one.
    const digits = (ref ?? "").replace(/\D+/g, "");
    if (digits.length >= 3 && haystack.includes(digits)) {
      score += 18;
      reasons.push("referenceDigits");
    }
  }

  const hit = nameTokens(name).find((w) => haystack.includes(w));
  if (hit) {
    score += 16;
    reasons.push("name");
  }

  return { score, reasons };
}

/**
 * Money IN, against invoices that are still owed.
 *
 * Outstanding is `total − paid`, which is what the customer's remittance advice will say
 * and what the ageing report already uses. It is deliberately not adjusted for credit notes
 * here: those move the document's own totals through the 0419 path, so reading the
 * document is reading the corrected figure.
 */
export function suggestInvoiceMatches(line: BankLineLike, candidates: InvoiceCandidate[]): Suggestion[] {
  if (line.amount_cents <= 0) return [];
  const amount = line.amount_cents;
  const haystack = fingerprint(line.description, line.reference);

  const out: Suggestion[] = [];
  for (const c of candidates) {
    const outstanding = Math.max(0, c.total_cents - c.amount_paid_cents);
    if (outstanding <= 0) continue;

    const age = days(c.issue_date, line.txn_date);
    // Paid long before it was raised, or a year after: not this invoice.
    if (age < -7 || age > 365) continue;

    let score = 0;
    const reasons: string[] = [];

    if (amount === outstanding) {
      score += 50;
      reasons.push("amountExact");
    } else if (amount === c.total_cents) {
      score += 42;
      reasons.push("amountTotal");
    } else if (amount < outstanding) {
      score += 12;
      reasons.push("amountPartial");
    } else {
      // More money than is owed. Never a settlement of this invoice on its own, and
      // suggesting it invites someone to overpay a document and hide the real receipt.
      continue;
    }

    const text = textScore(haystack, c.number, c.bill_to_name);
    score += text.score;
    reasons.push(...text.reasons);

    if (age >= 0 && age <= 180) {
      score += 12;
      reasons.push("dateWindow");
    }
    if (c.due_date && Math.abs(days(c.due_date, line.txn_date)) <= 7) {
      score += 6;
      reasons.push("dueDate");
    }

    if (score >= MATCH_THRESHOLD) {
      out.push({
        targetId: c.id,
        score,
        confidence: confidenceOf(score),
        reasons,
        amountCents: Math.min(amount, outstanding),
        outstandingCents: outstanding,
      });
    }
  }

  // Deterministic: the same inputs must produce the same order on the server and in the
  // browser, or the row a person clicks is not the row that gets posted.
  return out
    .sort((a, b) => b.score - a.score || a.targetId.localeCompare(b.targetId))
    .slice(0, MAX_SUGGESTIONS);
}

/**
 * Money OUT, against supplier invoices not yet marked paid.
 *
 * What leaves the bank is the VAT-INCLUSIVE total, so that is what the amount is compared
 * against. The ex-VAT figure is scored much lower rather than ignored, because a partner
 * who captured a receipt without its VAT line will otherwise never see a suggestion at all
 * and will conclude the feature does not work.
 */
export function suggestExpenseMatches(line: BankLineLike, candidates: ExpenseCandidate[]): Suggestion[] {
  if (line.amount_cents >= 0) return [];
  const amount = -line.amount_cents;
  const haystack = fingerprint(line.description, line.reference);

  const out: Suggestion[] = [];
  for (const c of candidates) {
    const total = c.amount_cents + c.vat_cents;
    if (total <= 0) continue;

    const age = days(c.expense_date, line.txn_date);
    // A supplier can be paid a few days before their invoice date (a deposit, a date typed
    // wrong), but not a year later without someone looking at it deliberately.
    if (age < -7 || age > 365) continue;

    let score = 0;
    const reasons: string[] = [];

    if (amount === total) {
      score += 50;
      reasons.push("amountExact");
    } else if (amount === c.amount_cents) {
      score += 30;
      reasons.push("amountExVat");
    } else {
      continue;
    }

    const text = textScore(haystack, c.reference, c.supplier_name);
    score += text.score;
    reasons.push(...text.reasons);

    if (age >= -7 && age <= 180) {
      score += 12;
      reasons.push("dateWindow");
    }

    if (score >= MATCH_THRESHOLD) {
      out.push({
        targetId: c.id,
        score,
        confidence: confidenceOf(score),
        reasons,
        amountCents: amount,
        outstandingCents: total,
      });
    }
  }

  return out
    .sort((a, b) => b.score - a.score || a.targetId.localeCompare(b.targetId))
    .slice(0, MAX_SUGGESTIONS);
}
