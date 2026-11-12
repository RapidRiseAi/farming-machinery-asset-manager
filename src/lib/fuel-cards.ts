/**
 * Reading a fuel card statement, and the checks that make it worth reading. Banks each lay
 * these out differently, so columns are found by what they are usually called, in English and
 * Afrikaans. The file is parsed by the same CSV reader as the vehicle import.
 */

const FILL_FLAGS = ["unknown_vehicle", "over_tank", "too_soon", "odometer_back"] as const;
export type FillFlag = (typeof FILL_FLAGS)[number];

/** Two fills this close together on one vehicle usually mean one of them is not for it. */
const TOO_SOON_HOURS = 3;

const MAX_FILL_ROWS = 2000;

type Column = "date" | "time" | "card" | "vehicle" | "driver" | "merchant" | "litres" | "amount" | "odometer";

const ALIASES: Record<Column, string[]> = {
  date: ["date", "datum", "transactiondate", "transdate", "transaksiedatum"],
  time: ["time", "tyd", "transactiontime"],
  card: ["card", "kaart", "cardnumber", "cardno", "kaartnommer", "fleetcard"],
  vehicle: ["reg", "registration", "regno", "vehicle", "vehiclereg", "registrasie", "voertuig", "fleetno", "vehicleregistration"],
  driver: ["driver", "bestuurder", "drivername"],
  merchant: ["merchant", "site", "garage", "station", "handelaar", "merchantname", "location"],
  litres: ["litres", "liters", "quantity", "qty", "volume", "liter"],
  amount: ["amount", "value", "total", "bedrag", "rand", "transactionamount", "totalamount"],
  odometer: ["odometer", "odo", "km", "kilometres", "kilometers", "mileage", "odometerreading"],
};

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which column of the file is which. A file without the essentials says what is missing. */
export function findColumns(headers: string[]): { columns: Partial<Record<Column, number>>; missing: Column[] } {
  const columns: Partial<Record<Column, number>> = {};
  headers.forEach((header, index) => {
    const key = plain(header);
    for (const [column, names] of Object.entries(ALIASES) as [Column, string[]][]) {
      if (columns[column] === undefined && names.includes(key)) columns[column] = index;
    }
  });
  const missing = (["date", "litres", "amount"] as Column[]).filter((c) => columns[c] === undefined);
  return { columns, missing };
}

/** A registration, whatever the spacing: "ABC 123 GP" and "abc123gp" are one vehicle. */
export const plainReg = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function parseNumber(raw: string | undefined): number | null {
  const text = (raw ?? "").replace(/[\sR]/g, "").replace(/,(?=\d{1,2}$)/, ".").replace(/,/g, "");
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** dd/mm/yyyy, yyyy-mm-dd and dd-mm-yyyy, read as South African time. */
export function parseWhen(date: string | undefined, time?: string): string | null {
  const d = (date ?? "").trim();
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(d);
  const local = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(d);
  const parts = iso ? [iso[1], iso[2], iso[3]] : local ? [local[3], local[2], local[1]] : null;
  if (!parts) return null;
  const [year, month, day] = parts.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const clock = /(\d{1,2}):(\d{2})/.exec(time || d.slice(10));
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${year}-${pad(month)}-${pad(day)}T${pad(Number(clock?.[1] ?? 12))}:${pad(Number(clock?.[2] ?? 0))}:00+02:00`;
  return Number.isNaN(Date.parse(stamp)) ? null : new Date(stamp).toISOString();
}

export type Fill = {
  occurredAt: string;
  cardRef: string;
  vehicleRef: string | null;
  driverRef: string | null;
  merchant: string | null;
  litres: number;
  amountCents: number;
  odometer: number | null;
};

/** Rows that can be read, and how many could not. Nothing unreadable is guessed at. */
export function readFills(rows: string[][]): { fills: Fill[]; skipped: number; missing: string[] } {
  const [headers, ...body] = rows;
  const { columns, missing } = findColumns(headers ?? []);
  if (missing.length > 0) return { fills: [], skipped: 0, missing };
  const cell = (row: string[], column: Column) => {
    const index = columns[column];
    return index === undefined ? undefined : row[index]?.trim();
  };
  const fills: Fill[] = [];
  let skipped = 0;
  for (const row of body.slice(0, MAX_FILL_ROWS)) {
    if (row.every((c) => c.trim() === "")) continue;
    const occurredAt = parseWhen(cell(row, "date"), cell(row, "time"));
    const litres = parseNumber(cell(row, "litres"));
    const amount = parseNumber(cell(row, "amount"));
    if (!occurredAt || litres == null || amount == null || litres < 0 || amount < 0) {
      skipped += 1;
      continue;
    }
    fills.push({
      occurredAt,
      cardRef: cell(row, "card") ?? "",
      vehicleRef: cell(row, "vehicle") || null,
      driverRef: cell(row, "driver") || null,
      merchant: cell(row, "merchant") || null,
      litres,
      amountCents: Math.round(amount * 100),
      odometer: parseNumber(cell(row, "odometer")),
    });
  }
  return { fills, skipped, missing: [] };
}

export type KnownVehicle = { id: string; regKey: string; tankLitres: number | null };
export type PastFill = { machineId: string; occurredAt: string; odometer: number | null };

/** Match each fill to a vehicle and check it, oldest first, against what came before it. */
export function checkFills(
  fills: Fill[],
  vehicles: KnownVehicle[],
  history: PastFill[] = [],
): (Fill & { machineId: string | null; flags: FillFlag[] })[] {
  const byReg = new Map(vehicles.filter((v) => v.regKey).map((v) => [v.regKey, v]));
  const seen = [...history];
  return [...fills]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .map((fill) => {
      const vehicle = byReg.get(plainReg(fill.vehicleRef));
      const flags: FillFlag[] = [];
      if (!vehicle) return { ...fill, machineId: null, flags: ["unknown_vehicle" as const] };

      if (vehicle.tankLitres != null && fill.litres > Number(vehicle.tankLitres)) flags.push("over_tank");
      const earlier = seen.filter((p) => p.machineId === vehicle.id && p.occurredAt <= fill.occurredAt);
      const previous = earlier.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).at(-1);
      if (previous) {
        const gap = (Date.parse(fill.occurredAt) - Date.parse(previous.occurredAt)) / (60 * 60 * 1000);
        if (gap < TOO_SOON_HOURS) flags.push("too_soon");
      }
      const lastOdometer = earlier.filter((p) => p.odometer != null).at(-1)?.odometer;
      if (fill.odometer != null && lastOdometer != null && fill.odometer < lastOdometer) flags.push("odometer_back");

      seen.push({ machineId: vehicle.id, occurredAt: fill.occurredAt, odometer: fill.odometer });
      return { ...fill, machineId: vehicle.id, flags };
    });
}
