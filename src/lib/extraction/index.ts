// Document extraction (task B5): the adapter between a reader of photos and PDFs (an OCR or vision
// provider) and the import review. Nothing here writes a reading: what a provider returns is staged
// as rows for a person to check (public.import_rows_stage), every value it was not sure of stays
// uncertain, and text inside a document is data, never an instruction.
//
// No live provider is wired. Which provider, and what reading a page costs a Professional business,
// is the founder's decision (FOUNDER-DECISIONS-PENDING); until then the configured provider is
// "none" and the readiness flag document_extraction is off. A provider added later can only run
// inside a spending hold (runExtraction takes the hold and settle steps; the app passes the AI
// usage ledger's holdBudget/settleHold, the one owner-chosen limit from task A3).

import type { Units } from "@/lib/ai-usage/ledger";
import { runHeld, type HoldStep, type SettleStep } from "./held";
import { planAllows, type Plan } from "@/lib/entitlements";
import { normaliseDate } from "@/lib/import-staging";
import { READINGS_IMPORT_MAX_ROWS } from "@/lib/limits";

/** One reading as a provider saw it. Every field is untrusted text from the document. */
export type ExtractedReading = {
  page: number;
  asset?: unknown;
  date?: unknown;
  /** Every date the provider found for this reading; more than one is a conflict for a person. */
  dateCandidates?: unknown;
  reading?: unknown;
  unit?: unknown;
  /** 0 to 1 per value. A missing or malformed confidence is treated as 0 (uncertain), never as sure. */
  confidence?: { asset?: unknown; date?: unknown; reading?: unknown };
  /** The words around the reading as the provider read them, kept for the person checking. */
  sourceText?: unknown;
};

export type ExtractionInput = { bytes: Uint8Array; contentType: string; fileName: string };

export type ExtractionOutput = {
  pages: number;
  readings: ExtractedReading[];
  /** What the call used, priced by the ledger at settlement. */
  units: Units;
  costUsd?: number | null;
};

export interface ExtractionProvider {
  /** The batch's `provider` (lowercase letters, digits, _ and -). */
  readonly name: string;
  /** The ledger's model id for pricing the hold and the settlement. */
  readonly model: string;
  /** What a document of this size is expected to use, for the hold before the call. */
  estimate(input: ExtractionInput): Units;
  extract(input: ExtractionInput): Promise<ExtractionOutput>;
}

/** Content a provider may be given: the same photos and PDFs the app already accepts. */
export const EXTRACTION_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export const EXTRACTION_MAX_PAGES = 500;

/**
 * The provider this deployment is configured with, or null. Only "none" exists today: a value
 * naming a provider that is not built answers null too, so a typo can never switch reading on.
 */
export function configuredProvider(
  env: Record<string, string | undefined> = process.env,
  registry: Record<string, () => ExtractionProvider> = {},
): ExtractionProvider | null {
  const name = (env.DOCUMENT_EXTRACTION_PROVIDER ?? "none").trim().toLowerCase();
  if (name === "" || name === "none") return null;
  const make = registry[name];
  return make ? make() : null;
}

/** A staging row for public.import_rows_stage (the database names every problem). */
export type DocumentRow = {
  row_no: number;
  page: number;
  asset: string;
  date: string;
  date_candidates?: string[];
  reading: string;
  unit?: string;
  confidence: { asset: number; date: number; reading: number };
  source_text?: string;
};

// Text from a document, as plain characters: no control characters, bounded length.
function clean(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// A provider's confidence, or 0: a value it did not state is a value it was not sure of.
function sure(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? Math.round(value * 1000) / 1000 : 0;
}

/**
 * A provider's output into staging rows, in page order. Refused whole when it is not readable
 * (no pages, too many) rather than staged in part; each value goes through as text.
 */
export function rowsFromExtraction(out: ExtractionOutput):
  | { ok: true; rows: DocumentRow[]; pages: number }
  | { ok: false; error: "import-invalid" | "import-too-many" | "import-empty" } {
  const pages = Number(out?.pages);
  if (!Number.isInteger(pages) || pages < 1) return { ok: false, error: "import-invalid" };
  if (pages > EXTRACTION_MAX_PAGES) return { ok: false, error: "import-too-many" };
  const readings = Array.isArray(out.readings) ? out.readings : [];
  if (readings.length > READINGS_IMPORT_MAX_ROWS) return { ok: false, error: "import-too-many" };
  const ordered = readings
    .map((r, i) => ({ r, i, page: Number(r?.page) }))
    .filter(({ page }) => Number.isInteger(page) && page >= 1 && page <= pages)
    .sort((a, b) => a.page - b.page || a.i - b.i);
  const rows = ordered.map(({ r, page }, n): DocumentRow => {
    const candidates = Array.isArray(r.dateCandidates)
      ? [...new Set(r.dateCandidates.map((d) => normaliseDate(clean(d, 40))).filter(Boolean))].slice(0, 5)
      : [];
    const row: DocumentRow = {
      row_no: n + 1,
      page,
      asset: clean(r.asset, 120),
      date: normaliseDate(clean(r.date, 40)),
      reading: clean(r.reading, 40),
      confidence: { asset: sure(r.confidence?.asset), date: sure(r.confidence?.date), reading: sure(r.confidence?.reading) },
    };
    if (candidates.length) row.date_candidates = candidates;
    const unit = clean(r.unit, 20);
    if (unit) row.unit = unit;
    const text = clean(r.sourceText, 1000);
    if (text) row.source_text = text;
    return row;
  });
  // A reading on a page outside the document is dropped, never moved to another page.
  if (rows.length === 0) return { ok: false, error: "import-empty" };
  return { ok: true, rows, pages };
}

export type ExtractionRefusal =
  /** Reading documents is not on Essential. */
  | "plan"
  /** Professional: what reading a page costs has not been decided (the founder's decision). */
  | "cost_undecided"
  /** The ledger refused the hold (no limit chosen, limit reached, billing paused, ...). */
  | "spend_refused"
  /** The provider failed or answered something unreadable; the hold is settled at what it used. */
  | "provider_failed";

/**
 * Run one document through a provider, inside a spending hold. Complete and above only for now:
 * reading documents on Professional waits for its price, and Essential does not have it. Never throws.
 */
export async function runExtraction(args: {
  provider: ExtractionProvider;
  input: ExtractionInput;
  plan: Plan | null;
  hold: HoldStep;
  settle: SettleStep;
}): Promise<
  | { ok: true; rows: DocumentRow[]; pages: number }
  | { ok: false; reason: ExtractionRefusal; error?: string }
> {
  const { provider, input, plan } = args;
  // Professional and up have the feature (the database's tco rank); only plans with Complete's paid
  // AI assistance (voice_ai) have an approved way to pay for a provider today.
  if (!plan || !planAllows(plan, "tco")) return { ok: false, reason: "plan" };
  if (!planAllows(plan, "voice_ai")) return { ok: false, reason: "cost_undecided" };
  const result = await runHeld({
    model: provider.model,
    estimate: provider.estimate(input),
    hold: args.hold,
    settle: args.settle,
    call: async () => {
      const out = await provider.extract(input);
      const mapped = rowsFromExtraction(out);
      return { value: mapped, units: out.units, costUsd: out.costUsd, usable: mapped.ok };
    },
  });
  if (result.ok) return result.value.ok ? result.value : { ok: false, reason: "provider_failed" };
  if (result.reason === "spend_refused") return { ok: false, reason: "spend_refused", error: result.error };
  return result.value && !result.value.ok
    ? { ok: false, reason: "provider_failed", error: result.value.error }
    : { ok: false, reason: "provider_failed" };
}
