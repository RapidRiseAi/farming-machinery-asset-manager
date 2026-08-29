import { t, type Lang } from "@/lib/i18n";

/**
 * The accounting export (FR-17.2) — turning the books here into something an accounting
 * package will take.
 *
 * ── The decision that shaped this file, and the evidence for it ─────────────
 *
 * The obvious feature is "export to Sage" and "export to Xero" buttons. This does not
 * ship those, and that is a finding rather than a shortcut.
 *
 * Both vendors' native journal-import column sets were researched before a line of this
 * was written, and NEITHER could be established from a primary source:
 *
 *   * Xero Central renders its help through JavaScript; a fetch of the manual-journal
 *     import article returns a Salesforce shell and no column list at all.
 *   * Sage's own journal-import help pages 404 on the en-us, en-za and en-ca paths. Its
 *     documentation says only "download the CSV template from inside the product" — the
 *     template is the specification, and it is behind a login.
 *   * Every remaining "documented" header set found belongs to a THIRD-PARTY importer,
 *     whose field names are its own and not the vendor's. They disagree with each other,
 *     which is the evidence: SaasAnt maps `Narration / Manual Journal Date / Account Name
 *     / Line Amount`; PostTrans uses `THNarration / THDate / TLAccCode / TLDebit /
 *     TLCredit`. Both are described as "the Xero format".
 *
 * A wrong column set does not fail at our desk. It fails at the accountant's, months
 * later, and it looks like our fault. An honest generic export they map once, in their
 * package's own import wizard, does not.
 *
 * So this ships the generic double-entry journal in the two shapes every package's
 * wizard understands — separate Debit and Credit columns, or one signed Amount column —
 * and the screen says plainly that it is generic and why. Adding a named vendor variant
 * later is a formatting change here and touches none of the arithmetic in 0510.
 *
 * ── Where the numbers come from ─────────────────────────────────────────────
 *
 * Not from this file. `app.partner_journal` / `app.farm_journal` (0510) are the source,
 * for the reason 0413/0431/0460 give: the screen, the CSV and any later PDF must not be
 * able to disagree. This file names the accounts and lays out the columns.
 */

// ── The chart of accounts ────────────────────────────────────────────────────
//
// FleetWise has no chart of accounts and should not invent one it then has to maintain.
// These are a documented DEFAULT in a conventional SA small-business range, emitted by
// 0510 beside a stable `account_key` that gets translated here for display. The
// accountant maps them once at import, and /accounting shows the whole map so they can
// see exactly what lands where BEFORE downloading anything.

export type AccountKind = "asset" | "liability" | "income" | "expense";

export type Account = { code: string; key: string; kind: AccountKind };

/** Every account 0510 can emit, in the order an accountant reads a chart. */
export const CHART: Account[] = [
  { code: "1000", key: "bank", kind: "asset" },
  { code: "1100", key: "receivable", kind: "asset" },
  { code: "1600", key: "cost_purchase", kind: "asset" },
  { code: "2000", key: "payable", kind: "liability" },
  { code: "2000", key: "contra", kind: "liability" },
  { code: "2200", key: "vatOutput", kind: "liability" },
  { code: "2210", key: "vatInput", kind: "asset" },
  { code: "4000", key: "sales", kind: "income" },
  { code: "5000", key: "exp_parts", kind: "expense" },
  { code: "5000", key: "exp_subcontract", kind: "expense" },
  { code: "5000", key: "exp_fuel", kind: "expense" },
  { code: "5000", key: "exp_vehicle", kind: "expense" },
  { code: "5000", key: "exp_tools", kind: "expense" },
  { code: "5000", key: "exp_rent", kind: "expense" },
  { code: "5000", key: "exp_salaries", kind: "expense" },
  { code: "5000", key: "exp_insurance", kind: "expense" },
  { code: "5000", key: "exp_admin", kind: "expense" },
  { code: "5000", key: "exp_marketing", kind: "expense" },
  { code: "5000", key: "exp_bank_fees", kind: "expense" },
  { code: "5000", key: "exp_other", kind: "expense" },
  { code: "6100", key: "badDebt", kind: "expense" },
  { code: "6200", key: "cost_finance", kind: "expense" },
  { code: "6300", key: "cost_fuel", kind: "expense" },
  { code: "6400", key: "cost_parts", kind: "expense" },
  { code: "6500", key: "cost_labour", kind: "expense" },
  { code: "6600", key: "cost_invoice", kind: "expense" },
  { code: "6900", key: "cost_other", kind: "expense" },
  { code: "9999", key: "rounding", kind: "expense" },
];

/** The accounts one side actually uses, so a farm is not shown a partner's VAT accounts. */
export function chartFor(scope: JournalScope): Account[] {
  return CHART.filter((a) =>
    scope === "farm"
      ? a.key.startsWith("cost_") || a.key === "contra"
      : !a.key.startsWith("cost_") && a.key !== "contra"
  );
}

/**
 * The account's name in the reader's language. Falls back to the key, which is what
 * `t()` does anyway — an untranslated account is a visible bug, not a silent blank.
 */
export function accountName(key: string, locale: Lang): string {
  return t(`accounting.acct.${key}`, locale);
}

// ── The journal ──────────────────────────────────────────────────────────────

export type JournalScope = "partner" | "farm";

export type JournalLine = {
  entry_date: string;
  entry_key: string;
  entry_ref: string | null;
  line_no: number;
  account_code: string;
  account_key: string;
  party: string | null;
  description: string | null;
  debit_cents: number;
  credit_cents: number;
  vat_code: string;
  vat_rate_bps: number;
  source_kind: string;
  source_id: string | null;
};

export function isJournalScope(v: string | null | undefined): v is JournalScope {
  return v === "partner" || v === "farm";
}

/**
 * Two layouts, named by SHAPE rather than by vendor — because the shape is what is
 * actually known, and a vendor name on a file we could not verify is the failure this
 * whole design is avoiding. Every package's import wizard reads one of the two.
 */
export const LAYOUTS = ["dc", "signed"] as const;
export type JournalLayout = (typeof LAYOUTS)[number];

export function isJournalLayout(v: string | null | undefined): v is JournalLayout {
  return v === "dc" || v === "signed";
}

/** Integer cents to the plain decimal an importer parses. Never localised: `1234.50`. */
export function centsToAmount(cents: number): string {
  const c = Math.round(cents);
  const neg = c < 0;
  const abs = Math.abs(c);
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** VAT rate as a plain percentage for the file: 1500 → `15`. */
export function bpsToPercent(bps: number): string {
  const whole = Math.round((bps / 100) * 100) / 100;
  return String(whole);
}

/**
 * The journal as a grid: ONE header row, then data rows and nothing else.
 *
 * No title block, no summary, no blank separator lines — unlike the VAT CSV, which is
 * read by a human. An import wizard reads row 1 as the header and everything after it as
 * data, so a friendly preamble is what makes a file fail on line 1. Anything a human
 * needs to know is on the screen and in the chart-of-accounts download beside it.
 */
export function journalGrid(
  lines: JournalLine[],
  layout: JournalLayout,
  locale: Lang
): (string | number)[][] {
  const head = [
    t("accounting.colDate", locale),
    t("accounting.colJournal", locale),
    t("accounting.colReference", locale),
    t("accounting.colAccountCode", locale),
    t("accounting.colAccount", locale),
    t("accounting.colDescription", locale),
    t("accounting.colParty", locale),
    ...(layout === "dc"
      ? [t("accounting.colDebit", locale), t("accounting.colCredit", locale)]
      : [t("accounting.colAmount", locale)]),
    t("accounting.colVatCode", locale),
    t("accounting.colVatRate", locale),
  ];

  const rows = lines.map((l) => [
    l.entry_date,
    l.entry_key,
    l.entry_ref ?? "",
    l.account_code,
    accountName(l.account_key, locale),
    l.description ?? "",
    l.party ?? "",
    ...(layout === "dc"
      ? [centsToAmount(l.debit_cents), centsToAmount(l.credit_cents)]
      : // Debit positive, credit negative — the convention of every single-column
        // importer, and the reason both layouts exist rather than one guess.
        [centsToAmount(l.debit_cents - l.credit_cents)]),
    l.vat_code,
    bpsToPercent(l.vat_rate_bps),
  ]);

  return [head, ...rows];
}

/** The chart as its own download, so the journal file stays purely machine-readable. */
export function chartGrid(scope: JournalScope, locale: Lang): (string | number)[][] {
  return [
    [
      t("accounting.colAccountCode", locale),
      t("accounting.colAccount", locale),
      t("accounting.colAccountType", locale),
    ],
    ...chartFor(scope).map((a) => [a.code, accountName(a.key, locale), t(`accounting.kind.${a.kind}`, locale)]),
  ];
}

// ── What the screen shows before anyone downloads ────────────────────────────

export type JournalTotals = {
  debit: number;
  credit: number;
  entries: number;
  lines: number;
  /** Entry keys whose debits and credits do not match. Empty is the only healthy value. */
  unbalanced: string[];
};

/**
 * Totals, and the one check worth running in front of the user.
 *
 * A file that balances OVERALL while two entries are wrong in opposite directions
 * imports cleanly and is still wrong, so this checks per entry — the same property G33
 * asserts in SQL. It should never fire; it is here because the moment it does, the
 * person about to hand this to an accountant is the person who needs to know.
 */
export function journalTotals(lines: JournalLine[]): JournalTotals {
  const byEntry = new Map<string, { dr: number; cr: number }>();
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    debit += l.debit_cents;
    credit += l.credit_cents;
    const cur = byEntry.get(l.entry_key) ?? { dr: 0, cr: 0 };
    cur.dr += l.debit_cents;
    cur.cr += l.credit_cents;
    byEntry.set(l.entry_key, cur);
  }
  const unbalanced = [...byEntry.entries()].filter(([, v]) => v.dr !== v.cr).map(([k]) => k);
  return { debit, credit, entries: byEntry.size, lines: lines.length, unbalanced };
}

/** Net movement per account, for the summary the screen leads with. */
export function accountSummary(lines: JournalLine[]): {
  key: string;
  code: string;
  debit: number;
  credit: number;
  net: number;
}[] {
  const map = new Map<string, { key: string; code: string; debit: number; credit: number }>();
  for (const l of lines) {
    const cur = map.get(l.account_key) ?? {
      key: l.account_key,
      code: l.account_code,
      debit: 0,
      credit: 0,
    };
    cur.debit += l.debit_cents;
    cur.credit += l.credit_cents;
    map.set(l.account_key, cur);
  }
  return [...map.values()]
    .map((a) => ({ ...a, net: a.debit - a.credit }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.key.localeCompare(b.key));
}

/** `journal-partner-2026-07-01-to-2026-07-31.csv` — the period is in the filename. */
export function journalFilename(scope: JournalScope, from: string, to: string): string {
  return `journal-${scope}-${from}-to-${to}.csv`;
}
