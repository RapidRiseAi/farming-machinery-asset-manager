import type { BadgeTone } from "@/components/ui/badge";
import { companyOf, type CompanyType, type Lang } from "@/lib/i18n";

/**
 * What a trip form asks for, by company. Weight and seals mean nothing to a shuttle, and
 * passenger counts mean nothing to a truck. "Other" sees both: it could be either.
 */
export function tripFields(lang: Lang): { goods: boolean; passengers: boolean } {
  const company: CompanyType | null = companyOf(lang);
  if (company === "game_drive" || company === "passenger_transport") return { goods: false, passengers: true };
  if (company === "goods_transport" || company === "delivery" || company === "construction" || company === "farm") {
    return { goods: true, passengers: false };
  }
  return { goods: true, passengers: true };
}

export const TRIP_STATUS_TONE: Record<string, BadgeTone> = {
  planned: "neutral",
  underway: "brand",
  completed: "ok",
  cancelled: "warning",
};
export const EXPENSE_KINDS = ["toll", "accommodation", "meals", "repair", "other"] as const;
export const TRAILER_TYPES: readonly string[] = ["trailer"];

/** How far a trip went, from the readings at each end. Null until both are known. */
export function tripDistance(trip: { opening_reading: number | null; closing_reading: number | null }): number | null {
  const { opening_reading: open, closing_reading: close } = trip;
  if (open == null || close == null) return null;
  return Math.max(0, Number(close) - Number(open));
}

export type TripMoney = {
  incomeCents: number;
  expenseCents: number;
  km: number;
};

/** What a vehicle earned per kilometre after trip costs. Null when it has not moved. */
export function marginPerKmCents(m: TripMoney): number | null {
  if (m.km <= 0) return null;
  return Math.round((m.incomeCents - m.expenseCents) / m.km);
}

/** Rand typed by a person, as cents: "1 250,50" and "1250.50" are the same. Null if not a number. */
export function randsToCents(raw: string): number | null {
  const plain = raw.replace(/[\sR]/g, "").replace(",", ".");
  if (plain === "") return null;
  const value = Number(plain);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}
