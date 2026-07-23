/**
 * Fuel consumption helpers shared by the fuel page, machine detail and reports, so the
 * UI numbers match the SQL engine (app.machine_fuel_consumption / app.enqueue_fuel_anomalies
 * in migration 0242). Interval ("brim-to-brim") method: order a machine's metered draws by
 * meter reading and, for each consecutive pair with a positive meter delta, attribute the
 * LATER draw's litres to that interval. Lifetime consumption = Σ interval litres ÷ Σ meter
 * delta — L/hr for hours meters, L/100km for km meters (Scope §23).
 */
import { t, type Locale } from "@/lib/i18n";

/** Qualifying diesel activities (SARS-style dropdown, Scope §9). */
export const FUEL_ACTIVITIES = [
  "ploughing",
  "planting",
  "spraying",
  "harvesting",
  "transport",
  "irrigation",
  "generator",
  "loading",
  "other",
] as const;
export type FuelActivity = (typeof FUEL_ACTIVITIES)[number];
export const activityLabel = (key: string, locale: Locale) => t(`fuel.activity.${key}`, locale);

export type FuelIssueRow = {
  id: string;
  date: string;
  litres: number | null;
  meter_reading: number | null;
  cost_cents: number | null;
};

export type FuelInterval = {
  date: string;
  meter: number;
  litres: number;
  delta: number;
  /** consumption for this interval in the display unit: L/hr (hours) or L/100km (km). */
  value: number;
};

export type FuelConsumption = {
  meterType: string;
  litres: number; // total litres across intervals
  meterSpan: number; // total meter delta across intervals
  intervals: number;
  /** raw consumption: L per meter unit (L/hr for hours, L/km for km); null if no span. */
  consumption: number | null;
  /** display consumption: L/hr for hours, L/100km for km; null if not metered / no span. */
  display: number | null;
  trend: FuelInterval[];
};

/** Compute interval + lifetime consumption from a machine's fuel issues. */
export function computeConsumption(issues: FuelIssueRow[], meterType: string): FuelConsumption {
  const metered = issues
    .filter((i) => i.meter_reading != null && i.litres != null && i.litres > 0)
    .map((i) => ({ id: i.id, date: i.date, meter: Number(i.meter_reading), litres: Number(i.litres) }))
    .sort((a, b) => a.meter - b.meter || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const km = meterType === "km";
  const trend: FuelInterval[] = [];
  let litres = 0;
  let meterSpan = 0;
  for (let i = 1; i < metered.length; i++) {
    const delta = metered[i].meter - metered[i - 1].meter;
    if (delta <= 0) continue;
    const l = metered[i].litres;
    litres += l;
    meterSpan += delta;
    const perUnit = l / delta;
    trend.push({ date: metered[i].date, meter: metered[i].meter, litres: l, delta, value: km ? perUnit * 100 : perUnit });
  }

  const consumption = meterSpan > 0 ? litres / meterSpan : null;
  const display =
    consumption == null || (meterType !== "hours" && meterType !== "km")
      ? null
      : km
        ? consumption * 100
        : consumption;

  return { meterType, litres, meterSpan, intervals: trend.length, consumption, display, trend };
}

/** Format a consumption figure with its unit, e.g. "0.63 L/hr" or "18.5 L/100km". */
export function formatConsumption(c: FuelConsumption, locale: Locale): string {
  if (c.display == null) return "—";
  const unit = c.meterType === "km" ? t("fuel.perKm", locale) : t("fuel.perHr", locale);
  const v = c.display.toLocaleString("en-ZA", { maximumFractionDigits: 2 });
  return `${v} ${unit}`;
}
