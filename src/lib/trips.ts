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

/** A trip's income less its own expenses. Null when no income was set: "not known", not R0. */
export function tripResultCents(incomeCents: number | null, expenseCents: number): number | null {
  return incomeCents == null ? null : incomeCents - expenseCents;
}

export type ReportTrip = {
  id: string;
  machine_id: string;
  status: string;
  opening_reading: number | null;
  closing_reading: number | null;
};

export type VehicleEarnings = {
  machineId: string;
  /** Finished trips in the window. */
  trips: number;
  /** Of those, the ones with both readings: the only ones the distance comes from. */
  tripsWithKm: number;
  km: number;
  incomeCents: number;
  expenseCents: number;
  /** Trips with no income entered: their expenses count, their income is not known. */
  tripsWithoutIncome: number;
  /**
   * Per kilometre after trip expenses, from the trips with both readings ONLY. A trip
   * without readings adds money but no distance, and counting it would inflate the figure.
   * Null when no trip has a distance above zero: there is nothing to divide by.
   */
  perKmCents: number | null;
};

export type TripReport = {
  vehicles: VehicleEarnings[];
  /** Finished trips counted. */
  finished: number;
  /** Finished trips without both readings: in the money, out of the per-km figure. */
  withoutReadings: number;
  /** Finished trips whose readings show no distance (closing equal to opening). */
  zeroKm: number;
  /** Trips in the window that were cancelled or are not finished: never counted. */
  cancelled: number;
  unfinished: number;
};

/**
 * What each vehicle earned over the trips given, as honestly as the records allow.
 *
 * Only finished trips count; cancelled and unfinished ones are reported, never summed.
 * Money is the trip's own: its income and the expenses added to that trip. Fuel draws,
 * job cards and services are the vehicle's costs and live in the cost reports; they are
 * deliberately NOT added here, so nothing is counted twice when a trip is set beside them.
 */
export function tripReport(
  trips: ReportTrip[],
  incomeByTrip: ReadonlyMap<string, number>,
  expensesByTrip: ReadonlyMap<string, number>,
): TripReport {
  const rows = new Map<string, VehicleEarnings & { kmIncome: number; kmExpense: number }>();
  let finished = 0;
  let withoutReadings = 0;
  let zeroKm = 0;
  let cancelled = 0;
  let unfinished = 0;
  for (const trip of trips) {
    if (trip.status === "cancelled") {
      cancelled += 1;
      continue;
    }
    if (trip.status !== "completed") {
      unfinished += 1;
      continue;
    }
    finished += 1;
    const row = rows.get(trip.machine_id) ?? {
      machineId: trip.machine_id, trips: 0, tripsWithKm: 0, km: 0, incomeCents: 0, expenseCents: 0,
      tripsWithoutIncome: 0, perKmCents: null, kmIncome: 0, kmExpense: 0,
    };
    const income = incomeByTrip.get(trip.id);
    const expense = expensesByTrip.get(trip.id) ?? 0;
    const km = tripDistance(trip);
    row.trips += 1;
    row.incomeCents += income ?? 0;
    row.expenseCents += expense;
    if (income == null) row.tripsWithoutIncome += 1;
    if (km == null) {
      withoutReadings += 1;
    } else {
      if (km === 0) zeroKm += 1;
      row.tripsWithKm += 1;
      row.km += km;
      row.kmIncome += income ?? 0;
      row.kmExpense += expense;
    }
    rows.set(trip.machine_id, row);
  }
  const vehicles = [...rows.values()].map(({ kmIncome, kmExpense, ...row }) => ({
    ...row,
    perKmCents: marginPerKmCents({ incomeCents: kmIncome, expenseCents: kmExpense, km: row.km }),
  }));
  vehicles.sort((a, b) => b.incomeCents - a.incomeCents || a.machineId.localeCompare(b.machineId));
  return { vehicles, finished, withoutReadings, zeroKm, cancelled, unfinished };
}

/** Rand typed by a person, as cents: "1 250,50" and "1250.50" are the same. Null if not a number. */
export function randsToCents(raw: string): number | null {
  const plain = raw.replace(/[\sR]/g, "").replace(",", ".");
  if (plain === "") return null;
  const value = Number(plain);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}
