import { MB } from "@/lib/limits";
/**
 * What a business's measured WhatsApp messages and stored files COST Rapid Rise, at the rates
 * Rapid Rise entered (usage_rates, 20261107150000): Rapid Rise's own cost view, never a bill.
 *
 * Until 20261118120100 this priced "all measured storage" at cost plus the markup, with no
 * allowance and no blocks, and /admin/usage could raise it as an invoice: the mismatch BRIEF
 * section 11 names. Customers now pay for storage only through the pooled allowance and R49
 * blocks (storage_charges, on the period or usage invoice), and for paid WhatsApp only through
 * the usage ledger under their spending limit (20261118120200). There are no transfer
 * (download) charges at all (decision 36). An unset rate costs nothing rather than guessing.
 */

export type UsageRates = {
  whatsapp_message_cents: number | null;
  storage_gb_month_cents: number | null;
  markup_bps: number;
};

export type UsageCost = { whatsappCents: number; storageCents: number; totalCents: number; gigabytes: number };

/** Decimal gigabytes, the convention of the storage allowance (decision 14). */
const GB = 1000 * MB;

export function withMarkup(cents: number, markupBps: number): number {
  return Math.round(cents * (1 + markupBps / 10000));
}

export function usageCost(usage: { whatsapp_sent: number; storage_bytes: number }, rates: UsageRates): UsageCost {
  const gigabytes = Math.round((Number(usage.storage_bytes) / GB) * 100) / 100;
  const whatsappCents = rates.whatsapp_message_cents == null ? 0 : Number(usage.whatsapp_sent) * rates.whatsapp_message_cents;
  const storageCents = rates.storage_gb_month_cents == null ? 0 : Math.round(gigabytes * rates.storage_gb_month_cents);
  return { whatsappCents, storageCents, totalCents: whatsappCents + storageCents, gigabytes };
}

/** The first day of a month, from "2026-10" or anything date-like; this month when unclear. */
export function monthStart(raw: string | null | undefined, now: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})/.exec(raw ?? "");
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2]}-01`;
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}
