import { t, type Locale } from "@/lib/i18n";

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
  "retired",
  "sold",
] as const;

export const METER_TYPES = ["hours", "km", "none"] as const;

// i18n-aware label helpers (preferred going forward). Keys live under the
// machineType / machineStatus / meterType namespaces in the i18n dictionaries.
export const typeLabel = (key: string, locale: Locale) => t(`machineType.${key}`, locale);
export const statusLabel = (key: string, locale: Locale) => t(`machineStatus.${key}`, locale);
export const meterLabel = (key: string, locale: Locale) => t(`meterType.${key}`, locale);

// Legacy English label maps — kept for any consumer not yet passing a locale.
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
  retired: "Retired",
  sold: "Sold",
};

export const METER_LABELS: Record<string, string> = {
  hours: "Hours",
  km: "Kilometres",
  none: "None (calendar only)",
};
