/**
 * Audit / sale / warranty document packs (FR-13.4) — the RENDERING half.
 *
 * A South African farm is audited against GLOBALG.A.P. and SIZA. When the auditor
 * arrives, the farmer has to PRODUCE evidence: that the machinery is maintained, that
 * it is licensed, that the people driving it are the people meant to be driving it.
 * Every one of those records is already in this product. What was missing was a way to
 * hand somebody a bundle.
 *
 * Four deliberate decisions live in this file.
 *
 * 1. ONE MULTI-SECTION PDF PER PACK, never a ZIP.
 *    An auditor sitting at a farm-office table wants a document, not an archive to
 *    unpack on a laptop they did not bring. A ZIP is also a build decision, not only a
 *    product one: this repo has kept its shared first-load JS at 102 kB for the whole
 *    project and has never added an archive writer. A single PDF reuses `Pdf`
 *    (src/lib/pdf/doc.ts) — the same engine, the same pagination, the same footer — and
 *    adds no dependency at all.
 *
 * 2. A PACK SAYS WHAT IS MISSING.
 *    This is the whole reason the file is shaped the way it is. A document whose value
 *    is "proof" must never omit silently. If a machine has no licence on file, the
 *    licence table gets a row for that machine SAYING SO — because an auditor reading a
 *    table of five in-date licences on a fifteen-machine fleet reads it as compliance,
 *    not as ten missing documents. Every pack therefore ends with "What is not on file",
 *    and the gaps are computed (`complianceGaps` / `saleGaps` / `warrantyGaps`) rather
 *    than left to whoever writes the next section to remember.
 *
 * 3. EVERY WORD GOES THROUGH `t()`.
 *    src/lib/statement.ts documents what happens otherwise: a statement posted to an
 *    Afrikaans farm having half its lines written in English by a Postgres function. An
 *    Afrikaans farm handing an auditor an English pack is the same failure with higher
 *    stakes, because the auditor is the one who has to read it. Enum values, dates,
 *    headings, the footer and the "what is missing" sentences are all translated; the
 *    only untranslated strings in a pack are the farm's own data.
 *
 * 4. COLUMN WIDTHS ARE MEASURED, NOT GUESSED.
 *    `Pdf.table()` cuts an over-wide cell with an ellipsis (the 0505 `fit()` fix). That is
 *    right for a free-text fault description and wrong for two things: a column HEADING,
 *    where the reader loses the name of what they are looking at and cannot recover it
 *    from context; and a fixed-format value that IS the evidence — "Resolved 09 May 2026"
 *    printed as "Resolved 09…" removes the date an auditor came to see, and
 *    "250 hours / 12 months" printed as "250 hours / 12 m…" is not an interval. Every
 *    width below was set by measuring the header and the worst-case enum value at 9pt in
 *    BOTH languages: Afrikaans is the binding constraint more often than English
 *    ("Binnekort verskuldig" is 94pt against "Due soon" at 41pt), so a table sized by eye
 *    on an English screen truncates for exactly the farms that need the translation.
 *
 * Money is integer cents ex-VAT throughout and is rendered with `rands()` — never
 * `toLocaleString`, for the reason set out in src/lib/money.ts.
 *
 * This module is deliberately free of Supabase and of `server-only`: it takes plain
 * data and returns bytes, so the packs can be generated and measured outside Next.
 * The gathering half is src/lib/pdf/pack-data.ts.
 */
import { Pdf } from "./doc";
import { rands } from "@/lib/money";
import { t, type Lang } from "@/lib/i18n";
import { num, shortDate, enumLabel, meterReading, meterUnit } from "@/lib/format";
import { COST_TYPES, summariseCosts, costPerMeter } from "@/lib/cost";
import {
  warrantyStatus,
  dateExpiryStatus,
  DEFAULT_WARRANTY_LEAD_DAYS,
  DEFAULT_WARRANTY_HOURS_LEAD,
  DEFAULT_LICENCE_LEAD_DAYS,
  type ExpiryStatus,
} from "@/lib/compliance";

// ── The shapes a pack is built from ──────────────────────────────────────────
// Plain rows, exactly as the tables hold them, so the gathering half can hand over what
// it selected without a translation layer in between.

export type PackMachine = {
  id: string;
  name: string;
  type: string;
  status: string;
  make: string | null;
  model: string | null;
  year: number | null;
  serial_no: string | null;
  reg_no: string | null;
  location: string | null;
  meter_type: string;
  current_reading: number | null;
  current_reading_date: string | null;
  purchase_date: string | null;
  purchase_price_cents: number | null;
  supplier: string | null;
  warranty_expiry_date: string | null;
  warranty_expiry_hours: number | null;
  assigned_operator_id: string | null;
};

export type PackLicence = {
  machine_id: string;
  type: string;
  number: string | null;
  expiry_date: string;
  reminder_lead_days: number;
  notes: string | null;
};

export type PackPlanLine = {
  machine_id: string;
  task: string;
  interval_hours: number | null;
  interval_months: number | null;
  last_done_reading: number | null;
  last_done_date: string | null;
  next_due_reading: number | null;
  next_due_date: string | null;
  status: string;
};

export type PackJobCard = {
  machine_id: string;
  type: string;
  status: string;
  date_in: string | null;
  date_out: string | null;
  meter_reading: number | null;
  work_performed: string | null;
  total_cents: number;
  created_at: string;
};

export type PackFault = {
  machine_id: string;
  description: string | null;
  urgency: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
  job_card_id: string | null;
};

export type PackChecklist = {
  machine_id: string;
  template_name: string;
  status: string;
  completed_at: string | null;
  created_at: string;
  performed_by: string | null;
  meter_reading: number | null;
  notes: string | null;
};

export type PackReading = {
  machine_id: string;
  reading: number;
  reading_date: string;
  source: string;
};

export type PackUsage = {
  machine_id: string;
  driver_user_id: string | null;
  driver_name: string | null;
  occurred_on: string;
  meter_reading: number | null;
};

export type PackPhoto = {
  machine_id: string;
  kind: string;
  created_at: string;
  is_primary: boolean;
};

export type PackCost = { type: string; amount_cents: number | null };

/** Who generated it and for whom — printed on the face of every pack. */
export type PackIssuer = {
  farmName: string;
  personName: string;
  /** Farm settings that decide when an expiry counts as "expiring soon". */
  warrantyLeadDays: number;
  warrantyHoursLead: number;
  licenceLeadDays: number;
  /** id → display name, for operators and the people who signed checklists off. */
  peopleById: Map<string, string>;
  generatedAt: Date;
};

export function defaultIssuer(partial: Partial<PackIssuer> = {}): PackIssuer {
  return {
    farmName: "",
    personName: "",
    warrantyLeadDays: DEFAULT_WARRANTY_LEAD_DAYS,
    warrantyHoursLead: DEFAULT_WARRANTY_HOURS_LEAD,
    licenceLeadDays: DEFAULT_LICENCE_LEAD_DAYS,
    peopleById: new Map(),
    generatedAt: new Date(),
    ...partial,
  };
}

// ── Small shared helpers ─────────────────────────────────────────────────────

const NONE = "—";
const dash = (v: unknown) => (v == null || v === "" ? NONE : String(v));

/** Machines that count towards a FLEET compliance figure (Scope §4.1 / C8). */
export function isOnHand(m: { status: string }): boolean {
  return m.status !== "retired" && m.status !== "sold";
}

/** A machine's severity for sorting a table worst-first. */
const severityOf = (s: ExpiryStatus | null): number =>
  s === "expired" ? 0 : s === "expiring" ? 1 : s === "ok" ? 2 : 3;

function expiryWord(s: ExpiryStatus | null, locale: Lang): string {
  if (s == null) return t("packs.notOnFile", locale);
  return t(`compliance.status.${s}`, locale);
}

function serviceWord(status: string, locale: Lang): string {
  if (status === "overdue") return t("ui.statusOverdue", locale);
  if (status === "due_soon") return t("ui.statusDueSoon", locale);
  return t("ui.statusOk", locale);
}

function intervalWord(l: PackPlanLine, locale: Lang): string {
  const parts: string[] = [];
  if (l.interval_hours) parts.push(`${num(l.interval_hours)} ${t("format.unit.hours", locale)}`);
  if (l.interval_months) parts.push(t("packs.months", locale).replace("{n}", num(l.interval_months, 0)));
  return parts.join(" / ") || NONE;
}

function personName(id: string | null, issuer: PackIssuer, locale: Lang): string {
  if (!id) return t("packs.notOnFile", locale);
  return issuer.peopleById.get(id) ?? t("packs.unknownPerson", locale);
}

function machineTitle(m: PackMachine): string {
  const make = [m.make, m.model].filter(Boolean).join(" ");
  return make ? `${m.name} (${make})` : m.name;
}

/** Group rows by machine id — every pack section needs this and nothing else. */
function byMachine<T extends { machine_id: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.machine_id);
    if (list) list.push(r);
    else out.set(r.machine_id, [r]);
  }
  return out;
}

/**
 * The block every pack opens with.
 *
 * It states what the document is, where the figures come from, and — the part that
 * matters — that it lists what is NOT on file. An auditor who does not know that will
 * read an absent row as a satisfied requirement.
 */
function frontMatter(pdf: Pdf, issuer: PackIssuer, locale: Lang, scopeLine: string) {
  pdf.kv(t("packs.farm", locale), issuer.farmName || NONE);
  pdf.kv(t("packs.generatedOn", locale), shortDate(issuer.generatedAt, locale));
  pdf.kv(t("packs.generatedBy", locale), issuer.personName || NONE);
  pdf.kv(t("packs.scope", locale), scopeLine);
  pdf.gap(4);
  pdf.text(t("packs.aboutBody", locale), { size: 9 });
  pdf.gap(2);
}

/**
 * "What is not on file", printed last and printed even when it is empty.
 *
 * Empty matters as much as full: "nothing is missing" is a claim the farm is making,
 * and it should be on the page in words rather than inferred from a section that was
 * quietly skipped.
 */
function gapsSection(pdf: Pdf, gaps: string[], locale: Lang) {
  pdf.heading(t("packs.gapsTitle", locale));
  if (gaps.length === 0) {
    pdf.text(t("packs.gapsNone", locale));
    return;
  }
  pdf.text(t("packs.gapsIntro", locale), { size: 9 });
  pdf.gap(2);
  for (const g of gaps) pdf.text(`- ${g}`);
}

/** Footer + wordmark: the FARM's document, produced from FleetWise. */
function brandFor(issuer: PackIssuer, locale: Lang) {
  return {
    name: issuer.farmName || "FleetWise",
    footer: t("packs.footer", locale)
      .replace("{farm}", issuer.farmName || "FleetWise")
      .replace("{date}", shortDate(issuer.generatedAt, locale)),
    poweredBy: false,
  };
}

// ── Gap detection ────────────────────────────────────────────────────────────
// Kept apart from rendering so a section cannot be added without the gap it implies,
// and so the isolation of "what counts as missing" is testable on its own.

/** How stale a meter may be before the hours on a compliance pack stop being evidence. */
export const STALE_READING_DAYS = 60;

function daysBetween(a: Date, b: Date): number {
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
      Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
      86_400_000,
  );
}

function isStale(dateStr: string | null, now: Date): boolean {
  if (!dateStr) return true;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return true;
  return daysBetween(d, now) > STALE_READING_DAYS;
}

export type ComplianceInput = {
  machines: PackMachine[];
  licences: PackLicence[];
  plan: PackPlanLine[];
  faults: PackFault[];
  checklists: PackChecklist[];
  usage: PackUsage[];
  issuer: PackIssuer;
};

/**
 * What an auditor would find absent. One sentence per machine per missing record,
 * named — "no licence on file" against a list of fifteen tractors is not actionable.
 */
export function complianceGaps(input: ComplianceInput, locale: Lang): string[] {
  const { machines, issuer } = input;
  const lic = byMachine(input.licences);
  const plan = byMachine(input.plan);
  const chk = byMachine(input.checklists.filter((c) => c.status === "completed"));
  const gaps: string[] = [];

  const name = (m: PackMachine) => m.name;
  const list = (ms: PackMachine[]) => ms.map(name).join(", ");

  const noLicence = machines.filter((m) => (lic.get(m.id) ?? []).length === 0);
  if (noLicence.length > 0) {
    gaps.push(t("packs.gapNoLicence", locale).replace("{machines}", list(noLicence)));
  }

  const noPlan = machines.filter((m) => (plan.get(m.id) ?? []).length === 0);
  if (noPlan.length > 0) {
    gaps.push(t("packs.gapNoPlan", locale).replace("{machines}", list(noPlan)));
  }

  const noChecklist = machines.filter((m) => (chk.get(m.id) ?? []).length === 0);
  if (noChecklist.length > 0) {
    gaps.push(t("packs.gapNoChecklist", locale).replace("{machines}", list(noChecklist)));
  }

  const noOperator = machines.filter((m) => !m.assigned_operator_id);
  if (noOperator.length > 0) {
    gaps.push(t("packs.gapNoOperator", locale).replace("{machines}", list(noOperator)));
  }

  const stale = machines.filter(
    (m) => m.meter_type !== "none" && isStale(m.current_reading_date, issuer.generatedAt),
  );
  if (stale.length > 0) {
    gaps.push(
      t("packs.gapStaleMeter", locale)
        .replace("{days}", num(STALE_READING_DAYS, 0))
        .replace("{machines}", list(stale)),
    );
  }

  const noWarranty = machines.filter(
    (m) => !m.warranty_expiry_date && m.warranty_expiry_hours == null,
  );
  if (noWarranty.length > 0) {
    gaps.push(t("packs.gapNoWarranty", locale).replace("{machines}", list(noWarranty)));
  }

  return gaps;
}

export type SaleInput = {
  machine: PackMachine;
  licences: PackLicence[];
  plan: PackPlanLine[];
  jobCards: PackJobCard[];
  faults: PackFault[];
  readings: PackReading[];
  photos: PackPhoto[];
  costs: PackCost[];
  /** F5 `tco` is Professional+. Denied → the cost section says so; it never vanishes. */
  costsAllowed: boolean;
  issuer: PackIssuer;
};

export function saleGaps(input: SaleInput, locale: Lang): string[] {
  const { machine: m } = input;
  const gaps: string[] = [];
  if (input.licences.length === 0) gaps.push(t("packs.saleGapNoLicence", locale));
  if (m.purchase_date == null && m.purchase_price_cents == null) {
    gaps.push(t("packs.saleGapNoPurchase", locale));
  }
  if (input.plan.length === 0) gaps.push(t("packs.saleGapNoPlan", locale));
  if (input.jobCards.length === 0) gaps.push(t("packs.saleGapNoHistory", locale));
  if (input.readings.length === 0) gaps.push(t("packs.saleGapNoReadings", locale));
  if (m.serial_no == null || m.serial_no === "") gaps.push(t("packs.saleGapNoSerial", locale));
  if (input.photos.length === 0) gaps.push(t("packs.saleGapNoPhotos", locale));
  if (!input.costsAllowed) gaps.push(t("packs.saleGapCostsGated", locale));
  return gaps;
}

export type WarrantyInput = {
  machine: PackMachine;
  plan: PackPlanLine[];
  jobCards: PackJobCard[];
  faults: PackFault[];
  readings: PackReading[];
  issuer: PackIssuer;
};

export function warrantyGaps(input: WarrantyInput, locale: Lang): string[] {
  const { machine: m } = input;
  const gaps: string[] = [];
  if (!m.warranty_expiry_date && m.warranty_expiry_hours == null) {
    gaps.push(t("packs.warrantyGapNoTerms", locale));
  }
  if (input.plan.length === 0) gaps.push(t("packs.warrantyGapNoPlan", locale));
  if (input.jobCards.filter((j) => j.type === "scheduled_service").length === 0) {
    gaps.push(t("packs.warrantyGapNoServices", locale));
  }
  if (input.readings.length === 0) gaps.push(t("packs.warrantyGapNoReadings", locale));
  if (m.serial_no == null || m.serial_no === "") gaps.push(t("packs.warrantyGapNoSerial", locale));
  const undated = input.plan.filter((l) => l.last_done_date == null && l.last_done_reading == null);
  if (undated.length > 0) {
    gaps.push(
      t("packs.warrantyGapNeverDone", locale).replace("{tasks}", undated.map((l) => l.task).join(", ")),
    );
  }
  return gaps;
}

// ── Identity block, shared by all three per-machine packs ────────────────────

function identity(pdf: Pdf, m: PackMachine, issuer: PackIssuer, locale: Lang, withPurchase: boolean) {
  pdf.kv(t("machines.type", locale), enumLabel("machineType", m.type, locale));
  pdf.kv(
    t("packs.makeModelYear", locale),
    [[m.make, m.model].filter(Boolean).join(" ") || NONE, m.year ? `(${m.year})` : ""]
      .filter(Boolean)
      .join(" "),
  );
  pdf.kv(t("packs.serial", locale), dash(m.serial_no));
  pdf.kv(t("machines.regNo", locale), dash(m.reg_no));
  pdf.kv(t("machines.status", locale), enumLabel("machineStatus", m.status, locale));
  pdf.kv(
    t("packs.currentMeter", locale),
    m.current_reading != null
      ? `${meterReading(m.current_reading, m.meter_type, locale)} (${m.current_reading_date ? shortDate(m.current_reading_date, locale) : t("machines.neverRead", locale)})`
      : t("packs.notOnFile", locale),
  );
  pdf.kv(t("packs.assignedOperator", locale), personName(m.assigned_operator_id, issuer, locale));
  if (m.location) pdf.kv(t("machines.location", locale), m.location);
  if (withPurchase) {
    pdf.kv(
      t("packs.purchased", locale),
      m.purchase_date
        ? `${shortDate(m.purchase_date, locale)}${m.supplier ? ` · ${m.supplier}` : ""}`
        : t("packs.notOnFile", locale),
    );
    pdf.kv(
      t("packs.purchasePrice", locale),
      m.purchase_price_cents != null ? rands(m.purchase_price_cents) : t("packs.notOnFile", locale),
    );
  }
}

/** Warranty terms as three rows, each saying "not on file" rather than blank. */
function warrantyBlock(pdf: Pdf, m: PackMachine, issuer: PackIssuer, locale: Lang) {
  const ws = warrantyStatus(m, issuer.warrantyLeadDays, issuer.warrantyHoursLead);
  pdf.kv(
    t("compliance.warrantyDate", locale),
    m.warranty_expiry_date ? shortDate(m.warranty_expiry_date, locale) : t("packs.notOnFile", locale),
  );
  pdf.kv(
    t("compliance.warrantyHours", locale),
    m.warranty_expiry_hours != null
      ? `${num(m.warranty_expiry_hours)} ${t("format.unit.hours", locale)}`
      : t("packs.notOnFile", locale),
  );
  pdf.kv(t("machines.status", locale), expiryWord(ws, locale));
}

// ── Fault section, shared: raised AND how it was resolved ────────────────────
// An auditor is not asking "are there faults" — every farm has faults. They are asking
// whether a reported fault reaches a conclusion. So resolved faults belong here too,
// with the date they closed.

function faultTable(
  pdf: Pdf,
  faults: PackFault[],
  nameById: Map<string, string>,
  locale: Lang,
  withMachine: boolean,
) {
  if (faults.length === 0) {
    pdf.text(t("packs.noFaults", locale));
    return;
  }
  const headers = withMachine
    ? [t("packs.date", locale), t("packs.asset", locale), t("packs.problem", locale), t("faults.urgency", locale), t("packs.outcome", locale)]
    : [t("packs.date", locale), t("packs.problem", locale), t("faults.urgency", locale), t("packs.outcome", locale)];
  const widths = withMachine ? [62, 100, 163, 76, 98] : [70, 244, 80, 105];
  const rows = faults.map((f) => {
    const outcome =
      f.status === "resolved"
        ? `${t("faultStatus.resolved", locale)}${f.resolved_at ? ` ${shortDate(f.resolved_at, locale)}` : ""}`
        : enumLabel("faultStatus", f.status, locale);
    const cells = [
      shortDate(f.created_at, locale),
      f.description ?? NONE,
      f.urgency ? enumLabel("urgency", f.urgency, locale) : NONE,
      outcome,
    ];
    if (withMachine) cells.splice(1, 0, nameById.get(f.machine_id) ?? NONE);
    return cells;
  });
  pdf.table(headers, rows, widths);
}

// ═════════════════════════════════════════════════════════════════════════════
// COMPLIANCE PACK — GLOBALG.A.P. / SIZA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `machines` is the set the pack covers, and the CALLER decides it:
 *  - fleet-wide → the machines on hand (retired/sold already filtered out, and the
 *    number excluded stated in `excludedCount` so the total is explained rather than
 *    unexplained);
 *  - one machine → that machine, whatever its status, because you named it.
 */
export async function buildCompliancePack(
  input: ComplianceInput & { excludedCount?: number; singleMachine?: boolean },
  locale: Lang,
): Promise<Uint8Array> {
  const { machines, issuer } = input;
  const nameById = new Map(machines.map((m) => [m.id, m.name]));
  const single = input.singleMachine === true ? machines[0] : null;

  const title = single
    ? t("packs.complianceTitleOne", locale).replace("{machine}", machineTitle(single))
    : t("packs.complianceTitle", locale).replace("{farm}", issuer.farmName || "");
  const pdf = await Pdf.create(title, brandFor(issuer, locale));
  pdf.header(t("packs.complianceSubtitle", locale));

  const scope = single
    ? t("packs.scopeOne", locale).replace("{machine}", single.name)
    : t("packs.scopeFleet", locale)
        .replace("{n}", num(machines.length, 0))
        .replace("{excluded}", num(input.excludedCount ?? 0, 0));
  frontMatter(pdf, issuer, locale, scope);

  // ── 1. The assets the pack covers ──────────────────────────────────────────
  pdf.heading(t("packs.assetsTitle", locale));
  if (machines.length === 0) {
    pdf.text(t("packs.noAssets", locale));
  } else {
    pdf.table(
      [
        t("packs.asset", locale),
        t("machines.type", locale),
        t("machines.regNo", locale),
        t("machines.status", locale),
        t("packs.meter", locale),
        t("packs.operator", locale),
      ],
      machines.map((m) => [
        m.name,
        enumLabel("machineType", m.type, locale),
        dash(m.reg_no),
        enumLabel("machineStatus", m.status, locale),
        m.current_reading != null
          ? `${num(m.current_reading)} ${meterUnit(m.meter_type, locale)}`.trim()
          : t("packs.notOnFile", locale),
        m.assigned_operator_id
          ? personName(m.assigned_operator_id, issuer, locale)
          : t("packs.notOnFile", locale),
      ]),
      [112, 74, 80, 70, 78, 85],
    );
  }

  // ── 2. Licences and renewals ───────────────────────────────────────────────
  // A machine with NO licence gets its own row. This is the single most important
  // line in the file: without it the table reads as "here are the documents" and an
  // absent machine reads as one that needed none.
  pdf.heading(t("packs.licencesTitle", locale));
  const licByMachine = byMachine(input.licences);
  type LicRow = { severity: number; cells: string[] };
  const licRows: LicRow[] = [];
  for (const m of machines) {
    const own = licByMachine.get(m.id) ?? [];
    if (own.length === 0) {
      licRows.push({
        severity: -1, // missing outranks expired: an absent document cannot even be judged
        cells: [m.name, t("packs.noLicenceOnFile", locale), NONE, NONE, t("packs.notOnFile", locale)],
      });
      continue;
    }
    for (const l of own) {
      const s = dateExpiryStatus(l.expiry_date, l.reminder_lead_days ?? issuer.licenceLeadDays);
      licRows.push({
        severity: severityOf(s),
        cells: [
          m.name,
          enumLabel("licenceType", l.type, locale),
          dash(l.number),
          shortDate(l.expiry_date, locale),
          expiryWord(s, locale),
        ],
      });
    }
  }
  licRows.sort((a, b) => a.severity - b.severity || a.cells[0].localeCompare(b.cells[0]));
  if (licRows.length === 0) {
    pdf.text(t("packs.noAssets", locale));
  } else {
    pdf.table(
      [
        t("packs.asset", locale),
        t("packs.document", locale),
        t("compliance.number", locale),
        t("compliance.expires", locale),
        t("machines.status", locale),
      ],
      licRows.map((r) => r.cells),
      [116, 126, 92, 87, 78],
    );
  }

  // ── 3. Warranty ────────────────────────────────────────────────────────────
  pdf.heading(t("compliance.warranty", locale));
  const warrantyRows = machines
    .map((m) => {
      const ws = warrantyStatus(m, issuer.warrantyLeadDays, issuer.warrantyHoursLead);
      return {
        severity: ws == null ? -1 : severityOf(ws),
        cells: [
          m.name,
          m.warranty_expiry_date ? shortDate(m.warranty_expiry_date, locale) : t("packs.notOnFile", locale),
          m.warranty_expiry_hours != null
            ? `${num(m.warranty_expiry_hours)} ${t("format.unit.hours", locale)}`
            : NONE,
          expiryWord(ws, locale),
        ],
      };
    })
    .sort((a, b) => a.severity - b.severity || a.cells[0].localeCompare(b.cells[0]));
  if (warrantyRows.length === 0) {
    pdf.text(t("compliance.noWarranty", locale));
  } else {
    pdf.table(
      [t("packs.asset", locale), t("compliance.warrantyDate", locale), t("compliance.warrantyHours", locale), t("machines.status", locale)],
      warrantyRows.map((r) => r.cells),
      [150, 130, 110, 109],
    );
  }

  // ── 4. Service adherence — was the plan followed? ──────────────────────────
  pdf.heading(t("packs.serviceTitle", locale));
  const planByMachine = byMachine(input.plan);
  const svcRows = machines.map((m) => {
    const lines = planByMachine.get(m.id) ?? [];
    const overdue = lines.filter((l) => l.status === "overdue").length;
    const dueSoon = lines.filter((l) => l.status === "due_soon").length;
    const lastDone = lines
      .map((l) => l.last_done_date)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1);
    return {
      severity: lines.length === 0 ? -1 : overdue > 0 ? 0 : dueSoon > 0 ? 1 : 2,
      cells: [
        m.name,
        lines.length === 0 ? t("packs.noPlanOnFile", locale) : num(lines.length, 0),
        lines.length === 0 ? NONE : num(overdue, 0),
        lines.length === 0 ? NONE : num(dueSoon, 0),
        lastDone ? shortDate(lastDone, locale) : t("packs.notOnFile", locale),
      ],
    };
  });
  svcRows.sort((a, b) => a.severity - b.severity || a.cells[0].localeCompare(b.cells[0]));
  if (svcRows.length === 0) {
    pdf.text(t("packs.noAssets", locale));
  } else {
    pdf.table(
      [
        t("packs.asset", locale),
        t("packs.tasksOnPlan", locale),
        t("ui.statusOverdue", locale),
        t("ui.statusDueSoon", locale),
        t("packs.lastServiced", locale),
      ],
      svcRows.map((r) => r.cells),
      [120, 120, 64, 98, 97],
    );
    pdf.gap(4);
    // The tasks themselves, for the machines that are behind — a count is a finding,
    // a task name is something the farm can act on before the auditor leaves.
    const overdueTasks = input.plan.filter((l) => l.status === "overdue");
    if (overdueTasks.length > 0) {
      pdf.text(t("packs.overdueTasksIntro", locale), { size: 9 });
      pdf.table(
        [t("packs.asset", locale), t("packs.task", locale), t("packs.interval", locale), t("packs.lastDone", locale)],
        overdueTasks.map((l) => [
          nameById.get(l.machine_id) ?? NONE,
          l.task,
          intervalWord(l, locale),
          l.last_done_date ? shortDate(l.last_done_date, locale) : t("packs.neverDone", locale),
        ]),
        [124, 172, 100, 103],
      );
    }
  }

  // ── 5. Inspections / checklists ────────────────────────────────────────────
  pdf.heading(t("packs.checklistsTitle", locale));
  const chkByMachine = byMachine(input.checklists.filter((c) => c.status === "completed"));
  const chkRows = machines.map((m) => {
    const own = chkByMachine.get(m.id) ?? [];
    const last = own
      .map((c) => c.completed_at ?? c.created_at)
      .sort()
      .at(-1);
    return {
      severity: own.length === 0 ? 0 : 1,
      cells: [
        m.name,
        own.length === 0 ? t("packs.noChecklistOnFile", locale) : num(own.length, 0),
        last ? shortDate(last, locale) : NONE,
        own.length > 0 ? (own[0].template_name ?? NONE) : NONE,
      ],
    };
  });
  chkRows.sort((a, b) => a.severity - b.severity || a.cells[0].localeCompare(b.cells[0]));
  if (chkRows.length === 0) {
    pdf.text(t("packs.noAssets", locale));
  } else {
    pdf.table(
      [t("packs.asset", locale), t("packs.inspectionsDone", locale), t("packs.lastInspection", locale), t("packs.template", locale)],
      chkRows.map((r) => r.cells),
      [140, 120, 110, 129],
    );
  }

  // ── 6. Faults raised, and how they ended ───────────────────────────────────
  pdf.heading(t("packs.faultsTitle", locale));
  pdf.text(t("packs.faultsIntro", locale), { size: 9 });
  pdf.gap(2);
  faultTable(pdf, input.faults, nameById, locale, !single);

  // ── 7. Who operates what ───────────────────────────────────────────────────
  pdf.heading(t("packs.operatorsTitle", locale));
  pdf.text(t("packs.operatorsIntro", locale), { size: 9 });
  pdf.gap(2);
  const usageByMachine = byMachine(input.usage);
  pdf.table(
    [t("packs.asset", locale), t("packs.assignedOperator", locale), t("packs.recentDrivers", locale), t("packs.lastUse", locale)],
    machines.map((m) => {
      const own = usageByMachine.get(m.id) ?? [];
      const names = [
        ...new Set(
          own.map((u) =>
            u.driver_user_id
              ? (issuer.peopleById.get(u.driver_user_id) ?? t("packs.unknownPerson", locale))
              : (u.driver_name ?? t("packs.unknownPerson", locale)),
          ),
        ),
      ];
      const last = own.map((u) => u.occurred_on).sort().at(-1);
      return [
        m.name,
        m.assigned_operator_id
          ? personName(m.assigned_operator_id, issuer, locale)
          : t("packs.noOperatorOnFile", locale),
        names.length > 0 ? names.slice(0, 4).join(", ") : t("packs.notOnFile", locale),
        last ? shortDate(last, locale) : t("packs.notOnFile", locale),
      ];
    }),
    [120, 120, 170, 89],
  );

  // ── 8. What is not on file ─────────────────────────────────────────────────
  gapsSection(pdf, complianceGaps(input, locale), locale);

  return pdf.save();
}

// ═════════════════════════════════════════════════════════════════════════════
// SALE PACK
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The document that goes with a machine changing hands.
 *
 * Retired and sold machines are NOT excluded here, and that is the point: the fleet
 * compliance figures answer "what is on the farm", while this answers "what am I
 * selling". A machine already marked `sold` is exactly the one whose pack somebody
 * needs. The status is printed on the face of the document either way.
 *
 * Open faults are DECLARED — a section that prints whether or not there are any,
 * because "no faults section" and "no faults" must not look the same to a buyer.
 */
export async function buildSalePack(input: SaleInput, locale: Lang): Promise<Uint8Array> {
  const { machine: m, issuer } = input;
  const pdf = await Pdf.create(
    t("packs.saleTitle", locale).replace("{machine}", machineTitle(m)),
    brandFor(issuer, locale),
  );
  pdf.header(t("packs.saleSubtitle", locale));

  frontMatter(pdf, issuer, locale, t("packs.scopeOne", locale).replace("{machine}", m.name));

  pdf.heading(t("packs.identityTitle", locale));
  identity(pdf, m, issuer, locale, true);

  // ── Compliance at handover ─────────────────────────────────────────────────
  pdf.heading(t("compliance.title", locale));
  warrantyBlock(pdf, m, issuer, locale);
  pdf.gap(4);
  if (input.licences.length === 0) {
    pdf.text(t("packs.noLicenceOnFileOne", locale));
  } else {
    pdf.table(
      [t("packs.document", locale), t("compliance.number", locale), t("compliance.expires", locale), t("machines.status", locale)],
      input.licences.map((l) => [
        enumLabel("licenceType", l.type, locale),
        dash(l.number),
        shortDate(l.expiry_date, locale),
        expiryWord(dateExpiryStatus(l.expiry_date, l.reminder_lead_days ?? issuer.licenceLeadDays), locale),
      ]),
      [150, 140, 110, 99],
    );
  }

  // ── Service record ─────────────────────────────────────────────────────────
  pdf.heading(t("packs.serviceRecordTitle", locale));
  if (input.plan.length === 0) {
    pdf.text(t("packs.noPlanOnFileOne", locale));
  } else {
    pdf.table(
      [t("packs.task", locale), t("packs.interval", locale), t("packs.lastDone", locale), t("packs.nextDue", locale), t("machines.status", locale)],
      input.plan.map((l) => [
        l.task,
        intervalWord(l, locale),
        l.last_done_date || l.last_done_reading != null
          ? [l.last_done_reading != null ? num(l.last_done_reading) : "", l.last_done_date ? shortDate(l.last_done_date, locale) : ""].filter(Boolean).join(" · ")
          : t("packs.neverDone", locale),
        l.next_due_date || l.next_due_reading != null
          ? [l.next_due_reading != null ? num(l.next_due_reading) : "", l.next_due_date ? shortDate(l.next_due_date, locale) : ""].filter(Boolean).join(" · ")
          : NONE,
        serviceWord(l.status, locale),
      ]),
      [111, 100, 100, 100, 88],
    );
    pdf.gap(6);
  }
  if (input.jobCards.length === 0) {
    pdf.text(t("packs.noJobCards", locale));
  } else {
    pdf.table(
      [t("packs.date", locale), t("packs.jobType", locale), t("packs.workDone", locale), t("machines.status", locale), t("packs.total", locale)],
      input.jobCards.map((j) => [
        shortDate(j.date_out ?? j.date_in ?? j.created_at, locale),
        enumLabel("jobType", j.type, locale),
        j.work_performed ?? NONE,
        enumLabel("jobStatus", j.status, locale),
        rands(j.total_cents),
      ]),
      [70, 106, 161, 82, 80],
      [false, false, false, false, true],
    );
  }

  // ── Meter history ──────────────────────────────────────────────────────────
  pdf.heading(t("packs.meterHistoryTitle", locale));
  if (input.readings.length === 0) {
    pdf.text(t("packs.noReadings", locale));
  } else {
    pdf.text(t("packs.meterHistoryIntro", locale), { size: 9 });
    pdf.gap(2);
    pdf.table(
      [t("packs.date", locale), t("packs.reading", locale), t("packs.source", locale)],
      input.readings.map((r) => [
        shortDate(r.reading_date, locale),
        meterReading(r.reading, m.meter_type, locale),
        enumLabel("meterSource", r.source, locale),
      ]),
      [150, 200, 149],
    );
  }

  // ── Lifetime cost & TCO — gated, and SAID when denied ──────────────────────
  pdf.heading(t("packs.costTitle", locale));
  if (!input.costsAllowed) {
    // The gate never becomes a silent omission. A buyer reading a pack with no cost
    // section must be told there IS one and why it is absent, otherwise a plan
    // boundary looks like a machine with no costs.
    pdf.text(t("packs.costGated", locale));
  } else {
    const { total, breakdown } = summariseCosts(input.costs);
    const perMeter =
      m.meter_type === "hours" || m.meter_type === "km" ? costPerMeter(total, m.current_reading) : null;
    pdf.kv(t("packs.tco", locale), rands(total));
    pdf.kv(
      m.meter_type === "km" ? t("packs.costPerKm", locale) : t("packs.costPerHour", locale),
      perMeter != null ? rands(perMeter) : t("packs.notOnFile", locale),
    );
    const rows = COST_TYPES.filter((ct) => breakdown[ct] > 0).map((ct) => [
      enumLabel("costType", ct, locale),
      rands(breakdown[ct]),
    ]);
    if (rows.length === 0) pdf.text(t("packs.noCosts", locale));
    else pdf.table([t("packs.costType", locale), t("packs.amountExVat", locale)], rows, [340, 159], [false, true]);
  }

  // ── Declared faults — printed whether or not there are any ─────────────────
  pdf.heading(t("packs.declaredFaultsTitle", locale));
  const open = input.faults.filter((f) => f.status !== "resolved");
  const resolved = input.faults.filter((f) => f.status === "resolved");
  if (open.length === 0) {
    pdf.text(t("packs.declaredFaultsNone", locale).replace("{date}", shortDate(issuer.generatedAt, locale)));
  } else {
    pdf.text(t("packs.declaredFaultsIntro", locale).replace("{n}", num(open.length, 0)));
    pdf.gap(2);
    faultTable(pdf, open, new Map(), locale, false);
  }
  pdf.gap(4);
  pdf.text(
    t("packs.resolvedFaultsCount", locale).replace("{n}", num(resolved.length, 0)),
    { size: 9 },
  );

  // ── Photographs on file ────────────────────────────────────────────────────
  // The images themselves are not reproduced here — see the note in the pack. Listing
  // them is not decoration: a buyer told there are eleven photographs on the record can
  // ask for them, whereas a pack that says nothing implies there are none.
  pdf.heading(t("packs.photosTitle", locale));
  if (input.photos.length === 0) {
    pdf.text(t("packs.noPhotos", locale));
  } else {
    pdf.text(
      t("packs.photosIntro", locale).replace("{n}", num(input.photos.length, 0)),
      { size: 9 },
    );
    pdf.gap(2);
    pdf.table(
      [t("packs.photo", locale), t("packs.date", locale), t("packs.primaryPhoto", locale)],
      input.photos.map((p, i) => [
        `${i + 1}`,
        shortDate(p.created_at, locale),
        p.is_primary ? t("packs.yes", locale) : NONE,
      ]),
      [150, 200, 149],
    );
  }

  gapsSection(pdf, saleGaps(input, locale), locale);

  pdf.gap(6);
  pdf.text(t("packs.saleBasis", locale).replace("{date}", shortDate(issuer.generatedAt, locale)), { size: 9 });

  return pdf.save();
}

// ═════════════════════════════════════════════════════════════════════════════
// WARRANTY PACK
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What a warranty claim actually turns on: the terms on file, and whether the service
 * plan was followed. A claim is refused on a skipped service, so the pack states the
 * standing of every task and names the ones that were never done — rather than
 * printing only the services that WERE performed, which is the shape that flatters.
 */
export async function buildWarrantyPack(input: WarrantyInput, locale: Lang): Promise<Uint8Array> {
  const { machine: m, issuer } = input;
  const pdf = await Pdf.create(
    t("packs.warrantyTitle", locale).replace("{machine}", machineTitle(m)),
    brandFor(issuer, locale),
  );
  pdf.header(t("packs.warrantySubtitle", locale));

  frontMatter(pdf, issuer, locale, t("packs.scopeOne", locale).replace("{machine}", m.name));

  pdf.heading(t("packs.identityTitle", locale));
  identity(pdf, m, issuer, locale, true);

  pdf.heading(t("packs.warrantyTermsTitle", locale));
  warrantyBlock(pdf, m, issuer, locale);

  // ── Adherence ──────────────────────────────────────────────────────────────
  pdf.heading(t("packs.adherenceTitle", locale));
  const overdue = input.plan.filter((l) => l.status === "overdue");
  const never = input.plan.filter((l) => l.last_done_date == null && l.last_done_reading == null);
  const services = input.jobCards.filter((j) => j.type === "scheduled_service");
  pdf.kv(t("packs.tasksOnPlan", locale), input.plan.length === 0 ? t("packs.noPlanOnFile", locale) : num(input.plan.length, 0));
  pdf.kv(t("ui.statusOverdue", locale), num(overdue.length, 0));
  pdf.kv(t("packs.neverDoneCount", locale), num(never.length, 0));
  pdf.kv(t("packs.servicesRecorded", locale), num(services.length, 0));
  pdf.gap(4);
  pdf.text(
    overdue.length === 0 && never.length === 0 && input.plan.length > 0
      ? t("packs.adherenceClean", locale)
      : t("packs.adherenceQualified", locale),
    { size: 9 },
  );
  pdf.gap(2);

  if (input.plan.length === 0) {
    pdf.text(t("packs.noPlanOnFileOne", locale));
  } else {
    pdf.table(
      [t("packs.task", locale), t("packs.interval", locale), t("packs.lastDone", locale), t("packs.nextDue", locale), t("machines.status", locale)],
      input.plan.map((l) => [
        l.task,
        intervalWord(l, locale),
        l.last_done_date || l.last_done_reading != null
          ? [l.last_done_reading != null ? num(l.last_done_reading) : "", l.last_done_date ? shortDate(l.last_done_date, locale) : ""].filter(Boolean).join(" · ")
          : t("packs.neverDone", locale),
        l.next_due_date || l.next_due_reading != null
          ? [l.next_due_reading != null ? num(l.next_due_reading) : "", l.next_due_date ? shortDate(l.next_due_date, locale) : ""].filter(Boolean).join(" · ")
          : NONE,
        serviceWord(l.status, locale),
      ]),
      [111, 100, 100, 100, 88],
    );
  }

  // ── Services performed ─────────────────────────────────────────────────────
  pdf.heading(t("packs.servicesPerformedTitle", locale));
  if (input.jobCards.length === 0) {
    pdf.text(t("packs.noJobCards", locale));
  } else {
    pdf.table(
      [t("packs.date", locale), t("packs.jobType", locale), t("packs.meter", locale), t("packs.workDone", locale), t("machines.status", locale)],
      input.jobCards.map((j) => [
        shortDate(j.date_out ?? j.date_in ?? j.created_at, locale),
        enumLabel("jobType", j.type, locale),
        j.meter_reading != null ? num(j.meter_reading) : NONE,
        j.work_performed ?? NONE,
        enumLabel("jobStatus", j.status, locale),
      ]),
      [70, 106, 56, 180, 87],
    );
  }

  // ── Fault history ──────────────────────────────────────────────────────────
  pdf.heading(t("packs.faultsTitle", locale));
  faultTable(pdf, input.faults, new Map(), locale, false);

  // ── Meter readings — the evidence the hours are recorded, not asserted ─────
  pdf.heading(t("packs.meterHistoryTitle", locale));
  if (input.readings.length === 0) {
    pdf.text(t("packs.noReadings", locale));
  } else {
    pdf.table(
      [t("packs.date", locale), t("packs.reading", locale), t("packs.source", locale)],
      input.readings.map((r) => [
        shortDate(r.reading_date, locale),
        meterReading(r.reading, m.meter_type, locale),
        enumLabel("meterSource", r.source, locale),
      ]),
      [150, 200, 149],
    );
  }

  gapsSection(pdf, warrantyGaps(input, locale), locale);

  return pdf.save();
}
