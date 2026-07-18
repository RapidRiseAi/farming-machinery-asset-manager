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
