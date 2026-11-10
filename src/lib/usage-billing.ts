/**
 * What a business's messages and storage come to, at Rapid Rise's cost plus its markup
 * (20261107150000). Nothing is charged until Rapid Rise has set what each costs: an unset rate
 * charges nothing rather than guessing.
 */

export type UsageRates = {
  whatsapp_message_cents: number | null;
  storage_gb_month_cents: number | null;
  markup_bps: number;
};

export type UsageCharge = { whatsappCents: number; storageCents: number; totalCents: number; gigabytes: number };

const GB = 1024 * 1024 * 1024;

export function withMarkup(cents: number, markupBps: number): number {
  return Math.round(cents * (1 + markupBps / 10000));
}

export function usageCharge(usage: { whatsapp_sent: number; storage_bytes: number }, rates: UsageRates): UsageCharge {
  const gigabytes = Math.round((Number(usage.storage_bytes) / GB) * 100) / 100;
  const whatsappCents = rates.whatsapp_message_cents == null
    ? 0
    : withMarkup(Number(usage.whatsapp_sent) * rates.whatsapp_message_cents, rates.markup_bps);
  const storageCents = rates.storage_gb_month_cents == null
    ? 0
    : withMarkup(Math.round(gigabytes * rates.storage_gb_month_cents), rates.markup_bps);
  return { whatsappCents, storageCents, totalCents: whatsappCents + storageCents, gigabytes };
}

/** The first day of a month, from "2026-10" or anything date-like; this month when unclear. */
export function monthStart(raw: string | null | undefined, now: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})/.exec(raw ?? "");
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2]}-01`;
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}
