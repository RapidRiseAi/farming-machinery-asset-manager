/**
 * Warranty claims, as the screens read them.
 *
 * Pure functions only. The COVER question is answered in SQL
 * (`app.job_card_warranty_cover`) because it joins a job card to its machine and the
 * answer is caller-scoped; what is here is everything the screen decides once it has that
 * answer, plus the money.
 *
 * Money is EX-VAT here, deliberately unlike `incidents`. A warranty claim is measured
 * against a job card, whose parts, labour and totals are ex-VAT with a rate beside them,
 * and a claim on a different basis could not be compared with the repair it is about.
 */

import type { BadgeTone } from "@/components/ui/badge";

/** `public.warranty_claim_status`. */
export const WARRANTY_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "paid",
  "rejected",
  "withdrawn",
] as const;

export type WarrantyStatus = (typeof WARRANTY_STATUSES)[number];

export const WARRANTY_CLAIM_COLUMNS =
  "id, farm_id, machine_id, job_card_id, supplier, reference, status, submitted_on, " +
  "decided_on, claimed_ex_vat_cents, recovered_ex_vat_cents, notes, " +
  "covered_by_date, covered_by_hours, created_at";

export type WarrantyClaimRow = {
  id: string;
  farm_id: string;
  machine_id: string;
  job_card_id: string;
  supplier: string | null;
  reference: string | null;
  status: WarrantyStatus;
  submitted_on: string | null;
  decided_on: string | null;
  claimed_ex_vat_cents: number | null;
  recovered_ex_vat_cents: number | null;
  notes: string | null;
  covered_by_date: boolean | null;
  covered_by_hours: boolean | null;
  created_at: string;
};

/** What `job_card_warranty_cover` returns for one repair. */
export type WarrantyCover = {
  job_card_id: string;
  machine_id: string;
  on_date: string | null;
  meter_reading: number | null;
  covered_by_date: boolean | null;
  covered_by_hours: boolean | null;
  covered: boolean | null;
};

/**
 * What the job card should SAY about cover.
 *
 * Three answers, not two. `unknown` is the case where the machine has no warranty recorded
 * at all, and it is not the same as "not covered": the farm should go and look at the
 * paperwork rather than be told they have no claim. Telling somebody they are not covered
 * when nobody ever typed in the dates is how a real claim goes unmade.
 */
export type CoverVerdict = "covered" | "not-covered" | "unknown";

export function coverVerdict(cover: WarrantyCover | null | undefined): CoverVerdict {
  if (!cover || cover.covered == null) return "unknown";
  return cover.covered ? "covered" : "not-covered";
}

/** Badge and words for a verdict. */
export function coverLook(v: CoverVerdict): { tone: BadgeTone; labelKey: string } {
  switch (v) {
    case "covered":
      return { tone: "ok", labelKey: "warranty.coverCovered" };
    case "not-covered":
      return { tone: "neutral", labelKey: "warranty.coverNotCovered" };
    default:
      return { tone: "warning", labelKey: "warranty.coverUnknown" };
  }
}

/**
 * Why it was not covered, so the screen can say which basis ran out.
 *
 * Returns an i18n key. A farm arguing with a dealer needs to know whether it was the date
 * or the hours, because the two expire independently and only one of them may be wrong.
 */
export function coverReasonKey(cover: WarrantyCover | null | undefined): string | null {
  if (!cover || cover.covered !== false) return null;
  const dateOut = cover.covered_by_date === false;
  const hoursOut = cover.covered_by_hours === false;
  if (dateOut && hoursOut) return "warranty.reasonBoth";
  if (dateOut) return "warranty.reasonDate";
  if (hoursOut) return "warranty.reasonHours";
  return null;
}

/** Badge shape for a claim's own status. */
export function claimLook(status: WarrantyStatus): { tone: BadgeTone; labelKey: string } {
  switch (status) {
    case "draft":
      return { tone: "neutral", labelKey: "warranty.statusDraft" };
    case "submitted":
      return { tone: "brand", labelKey: "warranty.statusSubmitted" };
    case "approved":
      return { tone: "info", labelKey: "warranty.statusApproved" };
    case "paid":
      return { tone: "ok", labelKey: "warranty.statusPaid" };
    case "rejected":
      return { tone: "danger", labelKey: "warranty.statusRejected" };
    default:
      return { tone: "neutral", labelKey: "warranty.statusWithdrawn" };
  }
}

/** Is this claim still waiting on the dealer? Only these two are money not yet in. */
export function claimOpen(status: WarrantyStatus): boolean {
  return status === "submitted" || status === "approved";
}

/**
 * How long a submitted claim has waited, in whole days.
 *
 * The same arithmetic `app.enqueue_warranty_claim_chases` uses, so the reminder saying
 * "60 days" and the row it links to cannot disagree.
 */
export function daysWaiting(
  claim: Pick<WarrantyClaimRow, "status" | "submitted_on">,
  on?: string,
): number | null {
  if (!claimOpen(claim.status) || !claim.submitted_on) return null;
  const today = on ?? new Date().toISOString().slice(0, 10);
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${claim.submitted_on}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 86_400_000));
}

/**
 * What the dealer still owes, and what has already come back, in ex-VAT cents.
 *
 * `outstanding` counts SUBMITTED and APPROVED only. A rejected claim is not owed, a
 * withdrawn one was never asked for, and a draft has not been sent, so counting any of
 * them would make the figure one a farm could not put in front of a dealer.
 */
export function claimTotals(rows: readonly WarrantyClaimRow[]): {
  outstanding: number;
  recovered: number;
  openCount: number;
} {
  let outstanding = 0;
  let recovered = 0;
  let openCount = 0;
  for (const r of rows) {
    if (claimOpen(r.status)) {
      outstanding += r.claimed_ex_vat_cents ?? 0;
      openCount += 1;
    }
    if (r.status === "paid") recovered += r.recovered_ex_vat_cents ?? 0;
  }
  return { outstanding, recovered, openCount };
}

/**
 * Which fields a status now requires, so the form asks before the database refuses.
 *
 * Mirrors `warranty_claims_paid_ck` and `warranty_claims_submitted_ck`. The database stays
 * the authority; this exists so a farmer gets a sentence instead of a constraint name.
 */
export function requiredFor(status: WarrantyStatus): { submittedOn: boolean; payout: boolean } {
  return {
    submittedOn: status !== "draft" && status !== "withdrawn",
    payout: status === "paid",
  };
}
