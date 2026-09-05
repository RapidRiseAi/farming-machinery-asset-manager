/**
 * Dunning and lifecycle policy — the TypeScript twin of the policy columns on
 * `billing_settings` (migration 20260903160000).
 *
 * WHY THERE IS A TWIN AT ALL. The authority is the database row: a policy change should
 * be a decision somebody makes, recorded by the audit log, not a deploy nobody reviews.
 * But a screen that says "we will try again on the 14th" has to say the same thing the
 * engine will actually do, and a test has to be able to prove that without a database.
 * So this file holds the SHAPE and the ARITHMETIC, and the values are defaults that
 * mirror the migration's own defaults exactly.
 *
 *   ⚠ EVERY VALUE IN `PROPOSED_BILLING_POLICY` IS A PROPOSAL AWAITING FOUNDER SIGN-OFF.
 *   They are the migration's defaults, and the migration says the same thing about them.
 *   `BILLING_POLICY_SIGNED_OFF` is false and stays false until somebody decides.
 *   Read the live row before showing a number to a customer; these are the fallback.
 *
 * THE ARITHMETIC MUST AGREE WITH `app.billing_register_failure`. That function is the
 * one that actually moves a subscription, and it works like this:
 *
 *     v_n := failed_attempt_count + 1;                       -- this failure's number
 *     if v_n <= array_length(retry_offsets_days, 1) then
 *       status = 'past_due';  next_retry_on = current_date + retry_offsets_days[v_n];
 *       grace_ends_on = null;
 *     else
 *       status = 'grace';     next_retry_on = null;
 *       grace_ends_on = coalesce(grace_ends_on, current_date + grace_days);
 *     end if;
 *
 * Two details in there are easy to get wrong and are reproduced deliberately below:
 * Postgres arrays are 1-BASED (so `retry_offsets_days[1]` is the first retry, which is
 * JavaScript's index 0), and an EXISTING grace end is kept rather than pushed out — a
 * farm cannot extend its own grace by failing again.
 *
 * DATES. Everything is a calendar date (`YYYY-MM-DD`), computed in UTC, because the
 * columns it mirrors are `date` and Postgres's `current_date` on Supabase is UTC. Doing
 * the arithmetic on local time would put a farm's retry a day out for half of every day.
 */

import type { Plan } from "@/lib/entitlements";

/** A calendar date, `YYYY-MM-DD`. The shape every `date` column round-trips as. */
export type IsoDate = string;

export type BillingPolicy = {
  /** Free days before anything is charged. */
  trialDays: number;
  /**
   * Days after each failure on which to try again, in order. Three tries across a
   * fortnight covers the ordinary causes — money arriving on payday, a reissued card,
   * the bank's own outage — without becoming harassment.
   */
  retryOffsetsDays: readonly number[];
  /** After the last retry fails, how long full access continues while we reach them. */
  graceDays: number;
  /** Where the EFFECTIVE plan (`farms.plan`) lands when grace expires. Data untouched. */
  downgradeToPlan: Plan;
  /** Cancellation takes effect at period end by default: they paid for the period. */
  cancelAtPeriodEnd: boolean;
  /** Whether adding vehicles mid-term on an annual plan raises a pro-rata charge. */
  prorateAnnualAdditions: boolean;
  /** Days after issue an invoice is due. Card subscriptions charge on issue. */
  paymentTermsDays: number;
};

/**
 * PROPOSED defaults, identical to the column defaults in 20260903160000. Frozen so a
 * caller cannot mutate the shared object and quietly change everybody's dunning.
 */
export const PROPOSED_BILLING_POLICY: BillingPolicy = Object.freeze({
  trialDays: 14,
  retryOffsetsDays: Object.freeze([3, 7, 14]) as readonly number[],
  graceDays: 7,
  downgradeToPlan: "essential" as Plan,
  cancelAtPeriodEnd: true,
  prorateAnnualAdditions: false,
  paymentTermsDays: 7,
});

/**
 * False until the founder signs the policy off. A screen that presents these numbers to
 * a customer as settled while this is false is presenting a guess as a commitment.
 */
export const BILLING_POLICY_SIGNED_OFF = false;

// ── Date arithmetic, in UTC, on calendar dates ────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Normalise a `Date` or an ISO date string to `YYYY-MM-DD`, in UTC. */
export function toIsoDate(value: Date | IsoDate): IsoDate {
  if (typeof value === "string") {
    const m = ISO_DATE.exec(value.trim());
    if (!m) throw new RangeError("billing policy: expected a YYYY-MM-DD date");
    return value.trim();
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("billing policy: expected a valid Date");
  }
  return value.toISOString().slice(0, 10);
}

/** `from` plus `days` calendar days, in UTC. Negative days go backwards. */
export function addDays(from: Date | IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days)) throw new RangeError("billing policy: days must be an integer");
  const iso = toIsoDate(from);
  const m = ISO_DATE.exec(iso)!;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: Date | IsoDate, b: Date | IsoDate): number {
  const pa = ISO_DATE.exec(toIsoDate(a))!;
  const pb = ISO_DATE.exec(toIsoDate(b))!;
  const ma = Date.UTC(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]));
  const mb = Date.UTC(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]));
  return Math.round((mb - ma) / 86_400_000);
}

// ── The policy questions ──────────────────────────────────────────────────────

/**
 * When the retry for failure number `failureNumber` (1-based, as
 * `app.billing_register_failure` counts them) falls — or null when the retries are
 * exhausted and the subscription goes to grace instead.
 */
export function retryDateFor(
  failureNumber: number,
  from: Date | IsoDate,
  policy: BillingPolicy = PROPOSED_BILLING_POLICY,
): IsoDate | null {
  if (!Number.isInteger(failureNumber) || failureNumber < 1) {
    throw new RangeError("billing policy: failureNumber is 1-based");
  }
  const offsets = policy.retryOffsetsDays;
  if (failureNumber > offsets.length) return null;
  return addDays(from, offsets[failureNumber - 1]);
}

/** True once this failure number has no retry left — the grace door. */
export function retriesExhausted(
  failureNumber: number,
  policy: BillingPolicy = PROPOSED_BILLING_POLICY,
): boolean {
  return failureNumber > policy.retryOffsetsDays.length;
}

/**
 * When grace ends. `existing` mirrors the SQL's `coalesce(grace_ends_on, …)`: a
 * subscription already in grace keeps the date it was given, so failing again cannot
 * push the deadline out.
 */
export function graceEndsOn(
  from: Date | IsoDate,
  policy: BillingPolicy = PROPOSED_BILLING_POLICY,
  existing?: IsoDate | Date | null,
): IsoDate {
  if (existing) return toIsoDate(existing);
  return addDays(from, policy.graceDays);
}

export type DunningStep = {
  /** Where the subscription lands. Mirrors the two branches of the SQL exactly. */
  status: "past_due" | "grace";
  /** The new `failed_attempt_count`. */
  failedAttemptCount: number;
  nextRetryOn: IsoDate | null;
  graceEndsOn: IsoDate | null;
};

/**
 * What `app.billing_register_failure` will do, without asking the database.
 *
 * `failedAttemptCount` is the count BEFORE this failure — the value currently on the
 * subscription row — exactly as the SQL reads it before adding one.
 */
export function dunningStep(
  failedAttemptCount: number,
  from: Date | IsoDate,
  policy: BillingPolicy = PROPOSED_BILLING_POLICY,
  existingGraceEndsOn?: IsoDate | Date | null,
): DunningStep {
  if (!Number.isInteger(failedAttemptCount) || failedAttemptCount < 0) {
    throw new RangeError("billing policy: failedAttemptCount must be a non-negative integer");
  }
  const n = failedAttemptCount + 1;
  const retry = retryDateFor(n, from, policy);
  if (retry !== null) {
    return { status: "past_due", failedAttemptCount: n, nextRetryOn: retry, graceEndsOn: null };
  }
  return {
    status: "grace",
    failedAttemptCount: n,
    nextRetryOn: null,
    graceEndsOn: graceEndsOn(from, policy, existingGraceEndsOn),
  };
}

/** When an invoice issued on `issuedOn` falls due. Mirrors the generator's `due_on`. */
export function invoiceDueOn(
  issuedOn: Date | IsoDate,
  policy: BillingPolicy = PROPOSED_BILLING_POLICY,
): IsoDate {
  return addDays(issuedOn, policy.paymentTermsDays);
}

/** The last day of a trial that started on `startedOn`. */
export function trialEndsOn(
  startedOn: Date | IsoDate,
  policy: BillingPolicy = PROPOSED_BILLING_POLICY,
): IsoDate {
  return addDays(startedOn, policy.trialDays);
}

/**
 * Read a policy back out of a `billing_settings` row (snake_case, as PostgREST returns
 * it), falling back field by field to the proposal. Field-by-field rather than
 * all-or-nothing so one null column cannot silently replace the whole policy.
 */
export function policyFromSettings(row: Record<string, unknown> | null | undefined): BillingPolicy {
  const d = PROPOSED_BILLING_POLICY;
  if (!row) return d;
  const int = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
  const offsets = Array.isArray(row.retry_offsets_days)
    ? (row.retry_offsets_days as unknown[]).filter(
        (v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0,
      )
    : [];
  return {
    trialDays: int(row.trial_days, d.trialDays),
    retryOffsetsDays: offsets.length > 0 ? offsets : d.retryOffsetsDays,
    graceDays: int(row.grace_days, d.graceDays),
    downgradeToPlan:
      typeof row.downgrade_to_plan === "string" ? (row.downgrade_to_plan as Plan) : d.downgradeToPlan,
    cancelAtPeriodEnd:
      typeof row.cancel_at_period_end === "boolean" ? row.cancel_at_period_end : d.cancelAtPeriodEnd,
    prorateAnnualAdditions:
      typeof row.prorate_annual_additions === "boolean"
        ? row.prorate_annual_additions
        : d.prorateAnnualAdditions,
    paymentTermsDays: int(row.payment_terms_days, d.paymentTermsDays),
  };
}
