/**
 * Standing invoices (G8, migration 0433).
 *
 * The shared model the list, the detail screen and the actions all read. The cadence
 * arithmetic is mirrored from `app.advance_by_cadence` so a screen showing "next on
 * 28 February" cannot disagree with the date the generator will actually use.
 */

export const CADENCES = ["weekly", "monthly", "quarterly", "yearly"] as const;
export type Cadence = (typeof CADENCES)[number];

export type Schedule = {
  id: string;
  workshop_id: string;
  farm_id: string | null;
  partner_client_id: string | null;
  bill_to_name: string | null;
  name: string;
  subject: string | null;
  notes: string | null;
  cadence: Cadence;
  next_issue_date: string;
  ends_on: string | null;
  last_period_start: string | null;
  last_document_id: string | null;
  vat_rate_bps: number;
  discount_cents: number;
  auto_send: boolean;
  active: boolean;
};

export type ScheduleLine = {
  id: string;
  sort_order: number;
  description: string;
  qty: number;
  unit_price_cents: number;
  discount_cents: number;
};

/**
 * Move a date on by one cadence, matching `app.advance_by_cadence` exactly.
 *
 * The month case is the one that matters. Postgres clamps 31 January + 1 month to
 * 28 February, and so does this: `setUTCMonth` would roll over into March, which is how a
 * schedule set up on the 31st quietly starts billing on the 1st or the 3rd depending on
 * the month. Anything that overshoots the target month is pulled back to its last day.
 */
export function advanceByCadence(from: string, cadence: Cadence): string {
  const d = new Date(`${from}T00:00:00Z`);
  const day = d.getUTCDate();

  if (cadence === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  }

  const months = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDayOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDayOfTarget));
  return target.toISOString().slice(0, 10);
}

/** Ex-VAT total of a schedule's lines — what each generated invoice will come to. */
export function scheduleNetCents(lines: readonly ScheduleLine[]): number {
  return lines.reduce(
    (sum, l) => sum + Math.max(0, Math.round(l.qty * l.unit_price_cents) - (l.discount_cents || 0)),
    0,
  );
}

/** VAT-inclusive total: the number the customer will actually be asked for. */
export function scheduleTotalCents(lines: readonly ScheduleLine[], vatRateBps: number): number {
  const net = scheduleNetCents(lines);
  return net + Math.round((net * vatRateBps) / 10000);
}

/** Is this schedule going to raise anything ever again? */
export function isLive(s: Pick<Schedule, "active" | "ends_on" | "next_issue_date">): boolean {
  if (!s.active) return false;
  return !s.ends_on || s.ends_on >= s.next_issue_date;
}

/** Due now — the generator would raise it on tonight's run. */
export function isDue(s: Pick<Schedule, "active" | "ends_on" | "next_issue_date">, today = new Date()): boolean {
  return isLive(s) && s.next_issue_date <= today.toISOString().slice(0, 10);
}
