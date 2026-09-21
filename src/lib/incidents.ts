/**
 * Accidents and insurance claims, as the screens read them.
 *
 * Pure functions — no Supabase, no React — so the rules can be tested directly and the
 * page stays a layout.
 *
 * ── The one number this file exists to produce ───────────────────────────────
 * What the insurer still owes. It is the reason the table refuses a `claim_settled` row
 * with no figure and no date: a claim somebody ticked off and never filled in would leave
 * that total quietly too small, and too small is the direction nobody investigates.
 */

import type { BadgeTone } from "@/components/ui/badge";

/** `public.incident_kind`. */
export const INCIDENT_KINDS = [
  "collision",
  "single_vehicle",
  "fire",
  "theft",
  "hijacking",
  "vandalism",
  "third_party_damage",
  "injury",
  "other",
] as const;

/** `public.incident_status`. */
export const INCIDENT_STATUSES = [
  "reported",
  "investigating",
  "no_claim",
  "claim_lodged",
  "claim_settled",
  "claim_rejected",
  "closed",
] as const;

export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** The columns `/incidents` selects. Enumerated once, spread at the call site. */
export const INCIDENT_COLUMNS =
  "id, farm_id, machine_id, kind, status, occurred_at, location, description, " +
  "driver_user_id, driver_name, saps_case_number, saps_station, " +
  "third_party_name, third_party_contact, third_party_reg_no, third_party_insurer, " +
  "injuries, injury_notes, insurer, claim_number, claim_lodged_on, " +
  "excess_incl_cents, claimed_incl_cents, settled_incl_cents, settled_on, " +
  "claim_notes, job_card_id, created_at";

export type IncidentRow = {
  id: string;
  farm_id: string;
  machine_id: string;
  kind: IncidentKind;
  status: IncidentStatus;
  occurred_at: string;
  location: string | null;
  description: string | null;
  driver_user_id: string | null;
  driver_name: string | null;
  saps_case_number: string | null;
  saps_station: string | null;
  third_party_name: string | null;
  third_party_contact: string | null;
  third_party_reg_no: string | null;
  third_party_insurer: string | null;
  injuries: boolean;
  injury_notes: string | null;
  insurer: string | null;
  claim_number: string | null;
  claim_lodged_on: string | null;
  excess_incl_cents: number | null;
  claimed_incl_cents: number | null;
  settled_incl_cents: number | null;
  settled_on: string | null;
  claim_notes: string | null;
  job_card_id: string | null;
  created_at: string;
};

/**
 * Is this claim still waiting on the insurer?
 *
 * `claim_lodged` and nothing else. `reported` and `investigating` are before a claim
 * exists; `no_claim` is a decision already taken; rejected and settled are answers. Only
 * one of the seven is money the farm is owed and has not been given.
 */
export function claimOpen(status: IncidentStatus): boolean {
  return status === "claim_lodged";
}

/** Has this one been dealt with, one way or another? Drives the "still open" count. */
export function incidentOpen(status: IncidentStatus): boolean {
  return status !== "closed" && status !== "no_claim" && status !== "claim_settled";
}

/**
 * How long a lodged claim has been waiting, in whole days, or null if it is not waiting.
 *
 * The same arithmetic `app.enqueue_incident_claim_chases` uses to decide when to speak, so
 * the screen and the reminder cannot disagree about how old a claim is — the chase says
 * "lodged 60 days ago" and the row it links to had better say 60 as well.
 */
export function daysWaiting(row: Pick<IncidentRow, "status" | "claim_lodged_on">, on?: string): number | null {
  if (!claimOpen(row.status) || !row.claim_lodged_on) return null;
  const today = on ?? new Date().toISOString().slice(0, 10);
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.claim_lodged_on}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 86_400_000));
}

/**
 * What the insurer still owes, VAT-inclusive cents.
 *
 * Only claims that are LODGED count. A rejected claim is not owed, a settled one has been
 * paid, and a `no_claim` was never asked for — putting any of those in this figure would
 * make it a number a farm could not reconcile against a single letter from their broker.
 *
 * A lodged claim with no amount contributes zero rather than being skipped: the count of
 * open claims beside this total is what says something is missing, and silently dropping
 * the row would make the two disagree.
 */
export function outstandingClaimCents(rows: readonly IncidentRow[]): number {
  return rows.reduce((sum, r) => (claimOpen(r.status) ? sum + (r.claimed_incl_cents ?? 0) : sum), 0);
}

/** What the farm has actually been paid on claims that settled, VAT-inclusive cents. */
export function settledClaimCents(rows: readonly IncidentRow[]): number {
  return rows.reduce(
    (sum, r) => (r.status === "claim_settled" ? sum + (r.settled_incl_cents ?? 0) : sum),
    0,
  );
}

/**
 * Badge shape for a status.
 *
 * `claim_rejected` is `danger` and `no_claim` is `neutral`, which is the distinction the
 * whole enum exists for: one is the insurer saying no, the other is the farm deciding not
 * to ask. Showing them alike would lose the difference on the screen as well as in the
 * conversation with the broker.
 */
export function incidentLook(status: IncidentStatus): { tone: BadgeTone; labelKey: string } {
  switch (status) {
    case "reported":
      return { tone: "warning", labelKey: "incidents.statusReported" };
    case "investigating":
      return { tone: "info", labelKey: "incidents.statusInvestigating" };
    case "no_claim":
      return { tone: "neutral", labelKey: "incidents.statusNoClaim" };
    case "claim_lodged":
      return { tone: "brand", labelKey: "incidents.statusClaimLodged" };
    case "claim_settled":
      return { tone: "ok", labelKey: "incidents.statusClaimSettled" };
    case "claim_rejected":
      return { tone: "danger", labelKey: "incidents.statusClaimRejected" };
    default:
      return { tone: "neutral", labelKey: "incidents.statusClosed" };
  }
}

/**
 * Sort order: whatever still needs somebody, oldest claim first.
 *
 * A lodged claim that has been waiting longest is the top row of this screen, because it
 * is the one closest to being written off by everybody concerned.
 */
export function incidentOrder(a: IncidentRow, b: IncidentRow, on?: string): number {
  const aw = daysWaiting(a, on);
  const bw = daysWaiting(b, on);
  if (aw != null && bw != null) return bw - aw;
  if (aw != null) return -1;
  if (bw != null) return 1;
  const ao = incidentOpen(a.status) ? 0 : 1;
  const bo = incidentOpen(b.status) ? 0 : 1;
  if (ao !== bo) return ao - bo;
  return b.occurred_at.localeCompare(a.occurred_at);
}

/**
 * Which fields a status now requires, so the form can ask BEFORE the database refuses.
 *
 * The constraints in `20260921100000` are the authority and stay the authority — this is
 * so a farmer gets a sentence about the settlement amount rather than a check-constraint
 * name, and `incidents.test.ts` walks every status against the SQL's two rules.
 */
export function requiredFor(status: IncidentStatus): { lodgedOn: boolean; settlement: boolean } {
  return {
    lodgedOn: status === "claim_lodged" || status === "claim_settled" || status === "claim_rejected",
    settlement: status === "claim_settled",
  };
}
