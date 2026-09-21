/**
 * Driver and operator documents, as the screens read them.
 *
 * Pure functions only — no Supabase, no React — so the rules can be tested directly and so
 * the page stays a layout. The status rule here MIRRORS `app.expiry_status_of` (0263),
 * which is what the nightly pass uses to decide whether to warn a farm. The two
 * disagreeing means the screen says a PrDP is fine on the morning the engine emails to say
 * it expired, and `driver-credentials.test.ts` pins them together case by case.
 */

import type { BadgeTone } from "@/components/ui/badge";
import type { StatTone } from "@/components/ui/stat";

/** `public.driver_credential_type`, in the order a farm thinks about them. */
export const CREDENTIAL_TYPES = [
  "drivers_licence",
  "prdp",
  "competency",
  "medical",
  "induction",
  "other",
] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/** The columns `/team/licences` selects. Enumerated once, spread at the call site. */
export type CredentialRow = {
  id: string;
  farm_id: string;
  user_id: string | null;
  person_name: string | null;
  type: CredentialType;
  code: string | null;
  number: string | null;
  issued_on: string | null;
  expiry_date: string | null;
  reminder_lead_days: number | null;
  notes: string | null;
};

/**
 * `expired` | `expiring` | `ok`, plus `none` for a document with no expiry at all.
 *
 * `none` is NOT `ok`. A site induction that never expires and a licence whose date nobody
 * captured look identical in a database and mean opposite things to a farm, so the screen
 * says "no expiry recorded" rather than quietly showing a green badge.
 */
export type CredentialState = "expired" | "expiring" | "ok" | "none";

/** Today as `YYYY-MM-DD`, in the local calendar the dates were captured in. */
function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Add days to a `YYYY-MM-DD` string, staying in dates rather than in milliseconds. */
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return isoDay(new Date(y, (m ?? 1) - 1, (d ?? 1) + n));
}

/**
 * The TypeScript mirror of `app.expiry_status_of(expiry, lead)`.
 *
 * Expired is `expiry < today` — the last day is INCLUSIVE, as it is on the card itself and
 * as the SQL has it. Off by one here is a farm told its driver may not drive on the day
 * they still may, which is the direction that gets the warning ignored.
 */
export function credentialState(
  row: Pick<CredentialRow, "expiry_date" | "reminder_lead_days">,
  on?: string,
): CredentialState {
  if (!row.expiry_date) return "none";
  const today = on ?? isoDay(new Date());
  if (row.expiry_date < today) return "expired";
  const lead = row.reminder_lead_days ?? 30;
  return row.expiry_date <= addDays(today, lead) ? "expiring" : "ok";
}

/** Expired first, then expiring, then fine, then the ones with no date. */
export function expiryOrder(state: CredentialState): number {
  switch (state) {
    case "expired":
      return 0;
    case "expiring":
      return 1;
    case "ok":
      return 2;
    default:
      return 3;
  }
}

/** Badge shape and words for a state. One map, so the list and any summary agree. */
export function credentialLook(state: CredentialState): { tone: BadgeTone; labelKey: string } {
  switch (state) {
    case "expired":
      return { tone: "danger", labelKey: "credentials.stateExpired" };
    case "expiring":
      return { tone: "warning", labelKey: "credentials.stateExpiring" };
    case "ok":
      return { tone: "ok", labelKey: "credentials.stateOk" };
    default:
      return { tone: "neutral", labelKey: "credentials.stateNoExpiry" };
  }
}

/** How loud a count of trouble should be on its tile. Zero is never loud. */
export function countTone(n: number, state: "expired" | "expiring"): StatTone {
  if (n <= 0) return "default";
  return state === "expired" ? "overdue" : "due";
}

/**
 * Whose document this is.
 *
 * A row belongs to a signed-in user OR carries a typed name — the database enforces
 * exactly one — so this resolves the first through the farm's own people and falls back to
 * the second. A user whose name cannot be resolved still gets something printable rather
 * than an empty cell on a compliance screen.
 */
export function credentialPerson(
  row: Pick<CredentialRow, "user_id" | "person_name">,
  nameById: ReadonlyMap<string, string>,
): string {
  if (row.user_id) {
    const name = nameById.get(row.user_id)?.trim();
    if (name) return name;
    return row.user_id.slice(0, 8);
  }
  return row.person_name?.trim() ?? "";
}

/**
 * Which of this driver's documents had already expired on a given day.
 *
 * The TypeScript mirror of `app.driver_credential_lapses`, used by `/fines` so the warning
 * can be rendered beside every pending nomination without a round trip per fine. The rule
 * is the SQL's rule, matched clause for clause, and `driver-credentials.test.ts` walks the
 * same cases the SQL suite does:
 *
 *   * a DATE, never "today" — a nomination is a statement about a day in the past, and a
 *     licence that is fine now says nothing about the 14th of June;
 *   * expired is `expiry < on`, the last day inclusive, as it is on the card;
 *   * a user matches by id; a typed name matches only rows that belong to NO user, folded
 *     and trimmed, so one careless free-text entry cannot speak for a real person's file.
 */
export function lapsedOn(
  rows: readonly CredentialRow[],
  who: { userId: string | null; name: string | null },
  on: string,
): CredentialRow[] {
  const name = who.name?.trim().toLowerCase() ?? "";
  return rows
    .filter((r) => {
      if (!r.expiry_date || r.expiry_date >= on) return false;
      if (who.userId) return r.user_id === who.userId;
      if (!name) return false;
      return r.user_id == null && (r.person_name?.trim().toLowerCase() ?? "") === name;
    })
    .sort((a, b) => (a.expiry_date ?? "").localeCompare(b.expiry_date ?? ""));
}
