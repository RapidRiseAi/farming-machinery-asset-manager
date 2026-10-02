import { t, type Locale, type Lang } from "@/lib/i18n";

export const MACHINE_TYPES = [
  "tractor",
  "harvester",
  "bakkie",
  "truck",
  "implement",
  "pump_generator",
  "atv_other",
] as const;

export const MACHINE_STATUSES = [
  "active",
  "in_workshop",
  "standby",
  "out_of_service",
  "retired",
  "sold",
] as const;

// Statuses that keep a machine on the active fleet (counted, notified, reported).
// `retired`/`sold` are the only excluded statuses; `out_of_service` is active-but-down.
export const INACTIVE_STATUSES = ["retired", "sold"] as const;

export const METER_TYPES = ["hours", "km", "none"] as const;

/**
 * The meter a new machine of this type most likely has, so the add form starts on the
 * right one: a bakkie or a truck has an odometer, an implement (a plough, a trailer)
 * usually has no meter at all, and everything else runs on an hour meter. Only a
 * starting point: the person can change it, and the form stops following the type the
 * moment they do.
 */
export function defaultMeterFor(type: string | null | undefined): (typeof METER_TYPES)[number] {
  if (type === "bakkie" || type === "truck") return "km";
  if (type === "implement") return "none";
  return "hours";
}

// i18n-aware label helpers (preferred going forward). Keys live under the
// machineType / machineStatus / meterType namespaces in the i18n dictionaries.
export const typeLabel = (key: string, locale: Lang) => t(`machineType.${key}`, locale);
export const statusLabel = (key: string, locale: Lang) => t(`machineStatus.${key}`, locale);
export const meterLabel = (key: string, locale: Lang) => t(`meterType.${key}`, locale);

// Legacy English label maps, kept for any consumer not yet passing a locale.
export const TYPE_LABELS: Record<string, string> = {
  tractor: "Tractor",
  harvester: "Harvester / Combine",
  bakkie: "Bakkie / LDV",
  truck: "Truck",
  implement: "Implement",
  pump_generator: "Pump / Generator",
  atv_other: "ATV / Other",
};

export const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  in_workshop: "In workshop",
  standby: "Standby",
  out_of_service: "Out of service",
  retired: "Retired",
  sold: "Sold",
};

export const METER_LABELS: Record<string, string> = {
  hours: "Hours",
  km: "Kilometres",
  none: "None (calendar only)",
};
