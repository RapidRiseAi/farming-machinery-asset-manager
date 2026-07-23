/**
 * Warranty + licence expiry status — the client/server mirror of the SQL helpers in
 * `0263_expiry_notifications.sql` (app.expiry_status_of / app.worse_expiry), so the UI
 * badges and the notification engine always agree.
 *
 * Status:
 *   - "expired"  — the date is in the past (or the hours meter has passed the limit)
 *   - "expiring" — within `leadDays` of expiry (or within `leadHours` of the hours limit)
 *   - "ok"       — comfortably in date
 *   - null       — no expiry recorded on this basis
 */
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";

export type ExpiryStatus = "ok" | "expiring" | "expired";

export const DEFAULT_WARRANTY_LEAD_DAYS = 30;
export const DEFAULT_WARRANTY_HOURS_LEAD = 50;
export const DEFAULT_LICENCE_LEAD_DAYS = 30;

const todayYmd = (): string => new Date().toISOString().slice(0, 10);

/** Add `days` to today, returned as a YYYY-MM-DD string (UTC — dates are date-only). */
function addDaysYmd(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Status of a date-based expiry (warranty date, licence date). */
export function dateExpiryStatus(
  expiry: string | null | undefined,
  leadDays = DEFAULT_LICENCE_LEAD_DAYS
): ExpiryStatus | null {
  if (!expiry) return null;
  const day = expiry.slice(0, 10);
  const today = todayYmd();
  if (day < today) return "expired";
  if (day <= addDaysYmd(Math.max(0, leadDays))) return "expiring";
  return "ok";
}

/** Status of an hours-based warranty limit vs the current meter reading. */
export function hoursExpiryStatus(
  current: number | null | undefined,
  limit: number | null | undefined,
  leadHours = DEFAULT_WARRANTY_HOURS_LEAD
): ExpiryStatus | null {
  if (limit == null || current == null) return null;
  if (current >= limit) return "expired";
  if (current >= limit - Math.max(0, leadHours)) return "expiring";
  return "ok";
}

/** The more severe of two statuses (null = no signal on that basis). */
export function worseExpiry(a: ExpiryStatus | null, b: ExpiryStatus | null): ExpiryStatus | null {
  if (a === "expired" || b === "expired") return "expired";
  if (a === "expiring" || b === "expiring") return "expiring";
  if (a === "ok" || b === "ok") return "ok";
  return null;
}

/** Combined warranty status from the date basis and (hours meters only) the hours basis. */
export function warrantyStatus(m: {
  warranty_expiry_date: string | null;
  warranty_expiry_hours: number | null;
  meter_type: string;
  current_reading: number | null;
}, leadDays = DEFAULT_WARRANTY_LEAD_DAYS, leadHours = DEFAULT_WARRANTY_HOURS_LEAD): ExpiryStatus | null {
  const byDate = dateExpiryStatus(m.warranty_expiry_date, leadDays);
  const byHours = m.meter_type === "hours"
    ? hoursExpiryStatus(m.current_reading, m.warranty_expiry_hours, leadHours)
    : null;
  return worseExpiry(byDate, byHours);
}

/** Badge tone (maps to the traffic-light status colours used across the kit). */
export function expiryTone(s: ExpiryStatus | null): "ok" | "warning" | "danger" | "neutral" {
  if (s === "expired") return "danger";
  if (s === "expiring") return "warning";
  if (s === "ok") return "ok";
  return "neutral";
}

/** Localised label for a status. */
export function expiryLabel(s: ExpiryStatus | null, locale: Locale): string {
  if (s == null) return t("compliance.statusNone", locale);
  return t(`compliance.status.${s}`, locale);
}

export const LICENCE_TYPES = [
  "vehicle_licence",
  "roadworthy",
  "permit",
  "crossborder",
  "insurance",
  "other",
] as const;
export type LicenceType = (typeof LICENCE_TYPES)[number];

export function licenceTypeLabel(type: string, locale: Locale): string {
  return t(`licenceType.${type}`, locale);
}
