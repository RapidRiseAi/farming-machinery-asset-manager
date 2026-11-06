import { companyOf, t, type CompanyType, type Locale, type Lang } from "@/lib/i18n";

export const MACHINE_TYPES = [
  "tractor",
  "harvester",
  "bakkie",
  "truck",
  "implement",
  "pump_generator",
  "atv_other",
  "car",
  "van",
  "minibus",
  "bus",
  "game_viewer",
  "truck_tractor",
  "trailer",
  "motorcycle",
  "forklift",
  "earthmoving",
  "boat",
] as const;
export type MachineType = (typeof MACHINE_TYPES)[number];

/** What each kind of company mostly runs, most likely first. "Other" sees everything. */
const TYPES_BY_COMPANY: Record<Exclude<CompanyType, "other">, readonly MachineType[]> = {
  farm: ["tractor", "harvester", "bakkie", "truck", "trailer", "implement", "pump_generator", "atv_other", "car", "motorcycle"],
  game_drive: ["game_viewer", "bakkie", "car", "minibus", "truck", "trailer", "boat", "pump_generator", "atv_other"],
  goods_transport: ["truck_tractor", "truck", "trailer", "bakkie", "van", "car", "forklift", "atv_other"],
  delivery: ["van", "bakkie", "car", "motorcycle", "truck", "trailer", "atv_other"],
  passenger_transport: ["minibus", "bus", "car", "van", "trailer", "atv_other"],
  construction: ["earthmoving", "truck", "bakkie", "trailer", "forklift", "pump_generator", "tractor", "car", "atv_other"],
};

/**
 * The types to offer this reader. A row's own type stays on the list, so editing an old
 * vehicle never quietly changes what it is.
 */
export function machineTypesFor(lang: Lang, current?: string | null): readonly MachineType[] {
  const company = companyOf(lang);
  const list = company && company !== "other" ? TYPES_BY_COMPANY[company] : MACHINE_TYPES;
  if (current && !(list as readonly string[]).includes(current) && (MACHINE_TYPES as readonly string[]).includes(current)) {
    return [current as MachineType, ...list];
  }
  return list;
}

const ON_THE_ROAD: readonly string[] = ["bakkie", "truck", "car", "van", "minibus", "bus", "game_viewer", "truck_tractor", "motorcycle"];

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
  if (type && ON_THE_ROAD.includes(type)) return "km";
  if (type === "implement" || type === "trailer") return "none";
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
  car: "Car / SUV",
  van: "Van",
  minibus: "Minibus / Shuttle",
  bus: "Bus",
  game_viewer: "Game viewer",
  truck_tractor: "Truck tractor (horse)",
  trailer: "Trailer",
  motorcycle: "Motorcycle",
  forklift: "Forklift",
  earthmoving: "Earthmoving / Plant",
  boat: "Boat",
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
