/**
 * AARTO fine workflow — shared client/server model (feature G2, FR-13.2).
 *
 * Mirrors the `fine_status` enum (migration 0370) and the nomination-deadline reminder
 * thresholds (0371) so the UI and the nightly engine agree. A fine is captured against a
 * VEHICLE; the driver is nominated from the usage log before a statutory deadline.
 */
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import type { BadgeTone } from "@/components/ui/badge";
import { dateExpiryStatus, type ExpiryStatus } from "@/lib/compliance";

/** Lifecycle, in order: received -> driver_identified -> nominated -> paid | disputed -> closed. */
export const FINE_STATUSES = [
  "received",
  "driver_identified",
  "nominated",
  "paid",
  "disputed",
  "closed",
] as const;
export type FineStatus = (typeof FINE_STATUSES)[number];

/** Statuses where a driver still has to be nominated (the §23 "pending nominations" set). */
export const PENDING_NOMINATION_STATUSES: readonly FineStatus[] = ["received", "driver_identified"];

/** Statuses that are still "live" (not paid / disputed-resolved / closed) — shown in the inbox. */
export const OPEN_FINE_STATUSES: readonly FineStatus[] = [
  "received",
  "driver_identified",
  "nominated",
  "disputed",
];

/** Days before the nomination deadline to start reminding (mirrors 0371 default). */
export const DEFAULT_AARTO_LEAD_DAYS = 14;

export function isFineStatus(value: string): value is FineStatus {
  return (FINE_STATUSES as readonly string[]).includes(value);
}

/** Does this fine still need the driver nominated? */
export function nominationPending(status: string): boolean {
  return (PENDING_NOMINATION_STATUSES as readonly string[]).includes(status);
}

export function fineStatusLabel(status: string, locale: Locale): string {
  return t(`fineStatus.${status}`, locale);
}

/** Badge tone for a fine status (traffic-light: received/identified warn, nominated info, paid ok). */
export function fineStatusTone(status: string): BadgeTone {
  switch (status) {
    case "received":
      return "warning";
    case "driver_identified":
      return "info";
    case "nominated":
      return "brand";
    case "paid":
      return "ok";
    case "disputed":
      return "danger";
    case "closed":
      return "neutral";
    default:
      return "neutral";
  }
}

/**
 * Status of a fine's nomination deadline, but only while a nomination is still owed. Returns
 * null once nominated/paid/disputed/closed (no deadline pressure) or when no deadline is set.
 */
export function nominationDeadlineStatus(
  deadline: string | null | undefined,
  status: string,
  leadDays = DEFAULT_AARTO_LEAD_DAYS
): ExpiryStatus | null {
  if (!nominationPending(status)) return null;
  return dateExpiryStatus(deadline, leadDays);
}
