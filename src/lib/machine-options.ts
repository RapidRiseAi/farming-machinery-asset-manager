import { companyOf, t, type CompanyType, type Lang } from "@/lib/i18n";

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
  "compressor",
  "workshop_tool",
  "other_equipment",
] as const;
export type MachineType = (typeof MACHINE_TYPES)[number];

/**
 * The management and billing profile (20261114090100), separate from what the asset IS
 * (its type) and where it is in its life (its status). `full` is a full-priced fleet space;
 * `equipment` is maintenance-focused support equipment.
 */
export const ASSET_PROFILES = ["full", "equipment"] as const;
export type AssetProfile = (typeof ASSET_PROFILES)[number];

export function isAssetProfile(value: unknown): value is AssetProfile {
  return typeof value === "string" && (ASSET_PROFILES as readonly string[]).includes(value);
}

/**
 * The types that may take the equipment profile: pumps and generators, compressors,
 * workshop tools, unpowered attachments, trailers, and other equipment that is not
 * self-propelled (decision register of 12 November 2026, decisions 1 and 4). Every other
 * type is a self-propelled vehicle and stays full-priced, parked or broken or not.
 *
 * THE SAME LIST IS `app.equipment_eligible` in 20261114090100_equipment_profile.sql, and
 * `machine-options.test.ts` reads that file to keep the two equal. There is no value,
 * size or power rule.
 */
export const EQUIPMENT_ELIGIBLE_TYPES = [
  "pump_generator",
  "compressor",
  "workshop_tool",
  "implement",
  "trailer",
  "other_equipment",
] as const satisfies readonly MachineType[];

export function isEquipmentEligible(type: string | null | undefined): boolean {
  return !!type && (EQUIPMENT_ELIGIBLE_TYPES as readonly string[]).includes(type);
}

/** Taking the equipment profile with this type opens a Rapid Rise review by itself. */
export function needsClassificationReview(type: string | null | undefined): boolean {
  return type === "other_equipment";
}

/** What each kind of company mostly runs, most likely first. "Other" sees everything. */
const TYPES_BY_COMPANY: Record<Exclude<CompanyType, "other">, readonly MachineType[]> = {
  farm: ["tractor", "harvester", "bakkie", "truck", "trailer", "implement", "pump_generator", "atv_other", "car", "motorcycle", "compressor", "workshop_tool", "other_equipment"],
  game_drive: ["game_viewer", "bakkie", "car", "minibus", "truck", "trailer", "boat", "pump_generator", "atv_other", "compressor", "workshop_tool", "other_equipment"],
  goods_transport: ["truck_tractor", "truck", "trailer", "bakkie", "van", "car", "forklift", "atv_other", "compressor", "workshop_tool", "pump_generator", "other_equipment"],
  delivery: ["van", "bakkie", "car", "motorcycle", "truck", "trailer", "atv_other", "compressor", "workshop_tool", "other_equipment"],
  passenger_transport: ["minibus", "bus", "car", "van", "trailer", "atv_other", "compressor", "workshop_tool", "other_equipment"],
  construction: ["earthmoving", "truck", "bakkie", "trailer", "forklift", "pump_generator", "tractor", "car", "atv_other", "compressor", "workshop_tool", "implement", "other_equipment"],
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
  if (type === "implement" || type === "trailer" || type === "workshop_tool" || type === "other_equipment") return "none";
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
  compressor: "Compressor",
  workshop_tool: "Workshop tool",
  other_equipment: "Other equipment (not self-propelled)",
};
