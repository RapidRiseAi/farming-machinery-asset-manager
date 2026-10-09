import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role } from "@/lib/auth";
import { matchMachine } from "./normalize";
import {
  canReadFinancialDocuments,
  listDocuments,
  listFaults,
  listJobCards,
  listWorkRequests,
  type AssistantReadScope,
} from "./read-data";
import type { AssistantMachine } from "./types";

/**
 * The farm records the assistant's AI may read, as finished numbers.
 *
 * Every read here runs on the person's own session (`supabase` is the request's client,
 * never the service role), so row policies decide what is visible exactly as they do on
 * the screens: an operator sees the machines assigned to them, a role that may not see
 * money gets litres and no rand. The aggregates are computed in the database
 * (20261005130000) because a model adding up rows gets sums wrong, and the shapes are
 * small on purpose: they go into a prompt, and every character is paid for.
 *
 * Person names are never returned. The model does not need them to answer about
 * machines, and they are personal information that would leave the country with it.
 */

export type FarmDataScope = {
  supabase: SupabaseClient;
  farmId: string;
  role: Role;
  /** The fleet this person can see (loadAssistantMachines): the only machines named. */
  machines: AssistantMachine[];
  /** app.can_view_farm_costs for this person on this farm. */
  costsVisible: boolean;
};

export type Period = { from: string; to: string };

export type MachinePick =
  | { ok: true; machine: AssistantMachine }
  | { ok: false; reason: "not_found" | "ambiguous"; candidates: string[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The database refuses longer periods (20261005130000); stay a little inside it. */
const MAX_PERIOD_DAYS = 1095;
/** PostgREST's page. A result this long may have been cut, and the model is told so. */
const PAGE_ROWS = 1000;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The first day of the month `monthsBack` months before `today`'s month. */
export function monthStart(today: string, monthsBack = 0): string {
  const [y, m] = today.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - monthsBack, 1));
  return d.toISOString().slice(0, 10);
}

/**
 * A period the database will accept, from whatever the model asked for: a missing end is
 * today, a missing start is the start of the month `defaultMonths - 1` months back, a
 * reversed period is turned round, a future end is today, and a span past three years is
 * shortened from the start.
 */
export function normalisePeriod(
  from: string | null | undefined,
  to: string | null | undefined,
  today: string,
  defaultMonths = 6,
): Period {
  let end = to && ISO_DATE.test(to) ? to : today;
  let start = from && ISO_DATE.test(from) ? from : monthStart(end > today ? today : end, defaultMonths - 1);
  if (end > today) end = today;
  if (start > end) [start, end] = [end, start];
  if (daysBetween(start, end) > MAX_PERIOD_DAYS) start = addDays(end, -MAX_PERIOD_DAYS);
  return { from: start, to: end };
}

/**
 * Every month a period touches, "2026-08" style. The database returns only months that
 * had rows, and a model shown August and September alone cannot tell "nothing in July" from
 * "July not included", so the summaries list every month, empty ones as zero.
 */
export function monthsIn(period: Period): string[] {
  const months: string[] = [];
  let [y, m] = period.from.split("-").map(Number);
  const [endY, endM] = period.to.split("-").map(Number);
  while ((y < endY || (y === endY && m <= endM)) && months.length < 40) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

/** Cents to rand, two decimals; null stays null (money the person may not see). */
export function rand(cents: number | string | null | undefined): number | null {
  if (cents == null) return null;
  const n = Number(cents);
  return Number.isFinite(n) ? Math.round(n) / 100 : null;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value: number, places = 1): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

export function pickMachine(scope: Pick<FarmDataScope, "machines">, query: string | null | undefined): MachinePick | null {
  if (!query?.trim()) return null;
  const match = matchMachine(query, scope.machines);
  if (match.machine) return { ok: true, machine: match.machine };
  return {
    ok: false,
    reason: match.ambiguous ? "ambiguous" : "not_found",
    candidates: match.alternatives.map((machine) => machine.name).slice(0, 6),
  };
}

function machineNotResolved(pick: Extract<MachinePick, { ok: false }>) {
  return {
    machineNotResolved: pick.reason,
    candidates: pick.candidates,
    hint: pick.reason === "ambiguous"
      ? "Several machines match. Ask which one, naming the candidates."
      : "No machine this person can see has that name. Say so; do not guess another machine.",
  };
}

/**
 * Names for machine ids, the visible fleet first; ids outside it (retired or sold
 * machines still carrying history) are read once through the person's session, so a
 * machine they cannot see is never named.
 */
async function machineNames(scope: FarmDataScope, ids: Array<string | null>): Promise<Map<string, string>> {
  const names = new Map(scope.machines.map((machine) => [machine.id, machine.name]));
  const missing = [...new Set(ids.filter((id): id is string => Boolean(id) && !names.has(id!)))];
  if (missing.length) {
    const { data } = await scope.supabase
      .from("machines")
      .select("id, name, status")
      .eq("farm_id", scope.farmId)
      .in("id", missing.slice(0, 200));
    for (const row of (data as Array<{ id: string; name: string; status: string }> | null) ?? []) {
      names.set(row.id, row.status === "sold" || row.status === "retired" ? `${row.name} (${row.status})` : row.name);
    }
  }
  return names;
}

function consumptionFor(machine: AssistantMachine | undefined, litres: number, span: number) {
  if (!machine || span <= 0 || litres <= 0) return {};
  if (machine.meterType === "hours") return { litresPerHour: round(litres / span, 2) };
  if (machine.meterType === "km") return { litresPer100km: round((litres / span) * 100, 1) };
  return {};
}

type FuelRow = {
  machine_id: string | null;
  month: string | null;
  litres: number | string;
  cost_cents: number | string | null;
  draws: number;
  priced_draws: number;
};
type ConsumptionRow = { machine_id: string; interval_litres: number | string; meter_span: number | string; intervals: number };
type TankBalanceRow = {
  tank_id: string;
  delivered_litres: number | string;
  issued_litres: number | string;
  balance_litres: number | string;
  dipped_on: string | null;
  dip_litres: number | string | null;
  book_at_dip_litres: number | string | null;
};

async function tankBalances(scope: FarmDataScope) {
  const [balances, tanks] = await Promise.all([
    scope.supabase.rpc("fuel_tank_balances", { p_farm: scope.farmId }),
    scope.supabase.from("fuel_tanks").select("id, name, capacity_l").eq("farm_id", scope.farmId).is("deleted_at", null),
  ]);
  if (balances.error) throw balances.error;
  const info = new Map(((tanks.data as Array<{ id: string; name: string; capacity_l: number | null }> | null) ?? []).map((t) => [t.id, t]));
  return ((balances.data as TankBalanceRow[] | null) ?? []).map((row) => {
    const tank = info.get(row.tank_id);
    const balance = num(row.balance_litres);
    const capacity = tank?.capacity_l ? Number(tank.capacity_l) : null;
    return {
      tank: tank?.name ?? "Tank",
      balanceLitres: round(balance),
      ...(capacity ? { capacityLitres: capacity, percentFull: Math.round((Math.max(0, balance) / capacity) * 100) } : {}),
      deliveredLitresAllTime: round(num(row.delivered_litres)),
      drawnLitresAllTime: round(num(row.issued_litres)),
      ...(row.dipped_on && row.dip_litres != null && row.book_at_dip_litres != null
        ? {
            lastDip: {
              date: row.dipped_on,
              measuredLitres: round(num(row.dip_litres)),
              booksSaidLitres: round(num(row.book_at_dip_litres)),
              differenceLitres: round(num(row.dip_litres) - num(row.book_at_dip_litres)),
            },
          }
        : {}),
    };
  });
}

/**
 * Diesel drawn in a period: totals, per month, per machine (with litres per hour or per
 * 100 km where metered draws allow), draws booked to no machine, and, for the whole farm,
 * each tank's balance and last dip.
 */
export async function fuelSummary(
  scope: FarmDataScope,
  input: { from?: string | null; to?: string | null; machine?: string | null },
  today: string,
) {
  const period = normalisePeriod(input.from, input.to, today, 6);
  const pick = pickMachine(scope, input.machine);
  if (pick && !pick.ok) return { period, ...machineNotResolved(pick) };
  const machineId = pick?.ok ? pick.machine.id : null;
  const base = { p_farm: scope.farmId, p_from: period.from, p_to: period.to, p_machine: machineId };
  const [byMachine, byMonth, consumption, tanks, purchases] = await Promise.all([
    scope.supabase.rpc("assistant_fuel_summary", { ...base, p_by: "machine" }),
    scope.supabase.rpc("assistant_fuel_summary", { ...base, p_by: "month" }),
    scope.supabase.rpc("assistant_fuel_consumption", base),
    machineId ? Promise.resolve(null) : tankBalances(scope),
    machineId || !scope.costsVisible ? Promise.resolve(null) : fuelPurchases(scope, period),
  ]);
  if (byMachine.error) throw byMachine.error;
  if (byMonth.error) throw byMonth.error;
  if (consumption.error) throw consumption.error;
  const machineRows = (byMachine.data as FuelRow[] | null) ?? [];
  const monthRows = ((byMonth.data as FuelRow[] | null) ?? []).sort((a, b) => String(a.month).localeCompare(String(b.month)));
  const rates = new Map(((consumption.data as ConsumptionRow[] | null) ?? []).map((row) => [row.machine_id, row]));
  const names = await machineNames(scope, machineRows.map((row) => row.machine_id));
  const fleet = new Map(scope.machines.map((machine) => [machine.id, machine]));

  const totals = machineRows.reduce(
    (acc, row) => ({
      litres: acc.litres + num(row.litres),
      cents: row.cost_cents == null ? acc.cents : acc.cents + num(row.cost_cents),
      draws: acc.draws + row.draws,
      priced: acc.priced + row.priced_draws,
    }),
    { litres: 0, cents: 0, draws: 0, priced: 0 },
  );
  const perMachine = machineRows
    .filter((row) => row.machine_id)
    .sort((a, b) => num(b.litres) - num(a.litres))
    .map((row) => {
      const rate = rates.get(row.machine_id!);
      return {
        machine: names.get(row.machine_id!) ?? "Machine",
        litres: round(num(row.litres)),
        ...(scope.costsVisible ? { costRand: rand(row.cost_cents) } : {}),
        draws: row.draws,
        ...consumptionFor(fleet.get(row.machine_id!), num(rate?.interval_litres), num(rate?.meter_span)),
      };
    });
  const noMachine = machineRows.find((row) => !row.machine_id);
  return {
    period,
    ...(pick?.ok ? { machine: pick.machine.name } : {}),
    money: scope.costsVisible ? "rand, ex VAT" : "not visible for this role",
    total: {
      litres: round(totals.litres),
      ...(scope.costsVisible ? { costRand: rand(totals.cents), drawsWithAPrice: totals.priced } : {}),
      draws: totals.draws,
    },
    byMonth: monthsIn(period).map((month) => {
      const row = monthRows.find((r) => String(r.month).slice(0, 7) === month);
      return {
        month,
        litres: round(num(row?.litres)),
        ...(scope.costsVisible ? { costRand: row ? rand(row.cost_cents) ?? 0 : 0 } : {}),
        draws: row?.draws ?? 0,
      };
    }),
    byMachine: perMachine.slice(0, 25),
    ...(perMachine.length > 25 ? { moreMachines: perMachine.length - 25 } : {}),
    ...(noMachine && !machineId
      ? { notBookedToAMachine: { litres: round(num(noMachine.litres)), ...(scope.costsVisible ? { costRand: rand(noMachine.cost_cents) } : {}) } }
      : {}),
    ...(tanks ? { tanks } : {}),
    ...(purchases ? { dieselBought: purchases } : {}),
    ...(machineRows.length >= PAGE_ROWS ? { truncated: true } : {}),
  };
}

/**
 * Diesel BOUGHT in the period (deliveries into the farm's tanks), beside the diesel the
 * machines USED above. A delivery is tank stock, not a machine's cost (0241), so the two
 * differ by what the tanks gained or lost; a farmer asking "what did we spend on diesel"
 * may mean either, and without this the assistant could only ever answer the second.
 * Roles that see costs only, as every rand figure here.
 */
async function fuelPurchases(scope: FarmDataScope, period: { from: string; to: string }) {
  const { data, error } = await scope.supabase
    .from("fuel_deliveries")
    .select("date, litres, price_per_l_cents")
    .eq("farm_id", scope.farmId)
    .is("deleted_at", null)
    .gte("date", period.from)
    .lte("date", period.to)
    .order("date", { ascending: true })
    .limit(PAGE_ROWS);
  if (error) return null;
  const rows = (data as Array<{ date: string; litres: number | string | null; price_per_l_cents: number | string | null }> | null) ?? [];
  let litres = 0;
  let cents = 0;
  let unpriced = 0;
  const byMonth = new Map<string, { litres: number; cents: number }>();
  for (const row of rows) {
    const l = num(row.litres);
    const c = row.price_per_l_cents == null ? null : l * num(row.price_per_l_cents);
    litres += l;
    if (c == null) unpriced += 1;
    else cents += c;
    const month = String(row.date).slice(0, 7);
    const entry = byMonth.get(month) ?? { litres: 0, cents: 0 };
    entry.litres += l;
    entry.cents += c ?? 0;
    byMonth.set(month, entry);
  }
  return {
    deliveries: rows.length,
    litres: round(litres),
    costRand: rand(cents) ?? 0,
    ...(unpriced ? { deliveriesWithoutAPrice: unpriced } : {}),
    byMonth: [...byMonth.entries()].map(([month, v]) => ({ month, litres: round(v.litres), costRand: rand(v.cents) ?? 0 })),
    ...(rows.length >= PAGE_ROWS ? { truncated: true } : {}),
  };
}

type CostRow = {
  machine_id: string | null;
  month: string | null;
  fuel_cents: number | string;
  parts_cents: number | string;
  labour_cents: number | string;
  invoice_cents: number | string;
  other_cents: number | string;
  purchase_cents: number | string;
  finance_cents: number | string;
  total_cents: number | string;
  entries: number;
};

function costColumns(row: CostRow) {
  const running = num(row.fuel_cents) + num(row.parts_cents) + num(row.labour_cents) + num(row.invoice_cents) + num(row.other_cents);
  return {
    totalRand: rand(row.total_cents),
    runningCostRand: rand(running),
    fuelRand: rand(row.fuel_cents),
    partsRand: rand(row.parts_cents),
    labourRand: rand(row.labour_cents),
    workshopInvoicesRand: rand(row.invoice_cents),
    otherRand: rand(row.other_cents),
    ...(num(row.purchase_cents) ? { purchaseRand: rand(row.purchase_cents) } : {}),
    ...(num(row.finance_cents) ? { financeRand: rand(row.finance_cents) } : {}),
  };
}

/**
 * Money from the cost ledger the reports read: per month and per machine, fuel, parts,
 * labour, workshop invoices and other (the running cost), plus purchase and finance where
 * recorded. Nothing at all for a role that may not see costs.
 */
export async function costSummary(
  scope: FarmDataScope,
  input: { from?: string | null; to?: string | null; machine?: string | null },
  today: string,
) {
  const period = normalisePeriod(input.from, input.to, today, 12);
  if (!scope.costsVisible) {
    return { period, costsVisible: false, note: "This person's role may not see costs on this farm. Say so; never estimate." };
  }
  const pick = pickMachine(scope, input.machine);
  if (pick && !pick.ok) return { period, ...machineNotResolved(pick) };
  const machineId = pick?.ok ? pick.machine.id : null;
  const base = { p_farm: scope.farmId, p_from: period.from, p_to: period.to, p_machine: machineId };
  const [byMachine, byMonth] = await Promise.all([
    scope.supabase.rpc("assistant_cost_summary", { ...base, p_by: "machine" }),
    scope.supabase.rpc("assistant_cost_summary", { ...base, p_by: "month" }),
  ]);
  if (byMachine.error) throw byMachine.error;
  if (byMonth.error) throw byMonth.error;
  const machineRows = (byMachine.data as CostRow[] | null) ?? [];
  const monthRows = ((byMonth.data as CostRow[] | null) ?? []).sort((a, b) => String(a.month).localeCompare(String(b.month)));
  const names = await machineNames(scope, machineRows.map((row) => row.machine_id));
  const total = machineRows.reduce<CostRow>(
    (acc, row) => ({
      ...acc,
      fuel_cents: num(acc.fuel_cents) + num(row.fuel_cents),
      parts_cents: num(acc.parts_cents) + num(row.parts_cents),
      labour_cents: num(acc.labour_cents) + num(row.labour_cents),
      invoice_cents: num(acc.invoice_cents) + num(row.invoice_cents),
      other_cents: num(acc.other_cents) + num(row.other_cents),
      purchase_cents: num(acc.purchase_cents) + num(row.purchase_cents),
      finance_cents: num(acc.finance_cents) + num(row.finance_cents),
      total_cents: num(acc.total_cents) + num(row.total_cents),
      entries: acc.entries + row.entries,
    }),
    { machine_id: null, month: null, fuel_cents: 0, parts_cents: 0, labour_cents: 0, invoice_cents: 0, other_cents: 0, purchase_cents: 0, finance_cents: 0, total_cents: 0, entries: 0 },
  );
  const perMachine = machineRows
    .filter((row) => row.machine_id)
    .sort((a, b) => num(b.total_cents) - num(a.total_cents))
    .map((row) => ({ machine: names.get(row.machine_id!) ?? "Machine", ...costColumns(row) }));
  const farmLevel = machineRows.find((row) => !row.machine_id);
  return {
    period,
    ...(pick?.ok ? { machine: pick.machine.name } : {}),
    money: "rand, ex VAT",
    total: costColumns(total),
    byMonth: monthsIn(period).map((month) => {
      const row = monthRows.find((r) => String(r.month).slice(0, 7) === month);
      return { month, ...(row ? costColumns(row) : { totalRand: 0, runningCostRand: 0 }) };
    }),
    byMachine: perMachine.slice(0, 25),
    ...(perMachine.length > 25 ? { moreMachines: perMachine.length - 25 } : {}),
    ...(farmLevel && !machineId ? { notBookedToAMachine: costColumns(farmLevel) } : {}),
  };
}

type ServiceLineRow = {
  machine_id: string;
  task: string;
  interval_hours: number | string | null;
  interval_months: number | null;
  last_done_reading: number | string | null;
  last_done_date: string | null;
  next_due_reading: number | string | null;
  next_due_date: string | null;
  status: "ok" | "due_soon" | "overdue";
};

const STATUS_ORDER = { overdue: 0, due_soon: 1, ok: 2 } as const;

/** Service plan lines: what is due, by meter or date, worst first. */
export async function servicePlan(scope: FarmDataScope, input: { machine?: string | null; onlyDue?: boolean | null }) {
  const pick = pickMachine(scope, input.machine);
  if (pick && !pick.ok) return machineNotResolved(pick);
  const ids = pick?.ok ? [pick.machine.id] : scope.machines.map((machine) => machine.id);
  if (!ids.length) return { lines: [] };
  let query = scope.supabase
    .from("service_plan_lines")
    .select("machine_id, task, interval_hours, interval_months, last_done_reading, last_done_date, next_due_reading, next_due_date, status")
    .eq("farm_id", scope.farmId)
    .in("machine_id", ids)
    .is("deleted_at", null);
  if (input.onlyDue) query = query.in("status", ["due_soon", "overdue"]);
  const { data, error } = await query;
  if (error) throw error;
  const names = new Map(scope.machines.map((machine) => [machine.id, machine]));
  const rows = ((data as ServiceLineRow[] | null) ?? [])
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || String(a.next_due_date ?? "9").localeCompare(String(b.next_due_date ?? "9")));
  const unit = (machineId: string) => (names.get(machineId)?.meterType === "km" ? "km" : "h");
  return {
    ...(pick?.ok ? { machine: pick.machine.name } : {}),
    lines: rows.slice(0, 40).map((row) => ({
      machine: names.get(row.machine_id)?.name ?? "Machine",
      task: row.task,
      status: row.status,
      every: [row.interval_hours != null ? `${num(row.interval_hours)} ${unit(row.machine_id)}` : null, row.interval_months != null ? `${row.interval_months} months` : null].filter(Boolean).join(" or "),
      ...(row.next_due_reading != null || row.next_due_date ? { nextDue: [row.next_due_reading != null ? `${num(row.next_due_reading)} ${unit(row.machine_id)}` : null, row.next_due_date].filter(Boolean).join(" or ") } : {}),
      ...(row.last_done_date || row.last_done_reading != null ? { lastDone: [row.last_done_reading != null ? `${num(row.last_done_reading)} ${unit(row.machine_id)}` : null, row.last_done_date].filter(Boolean).join(", ") } : {}),
    })),
    ...(rows.length > 40 ? { moreLines: rows.length - 40 } : {}),
  };
}

function readScope(scope: FarmDataScope): AssistantReadScope {
  return { supabase: scope.supabase, farmId: scope.farmId, role: scope.role, machines: scope.machines };
}

function day(value: unknown): string | null {
  return typeof value === "string" && value ? value.slice(0, 10) : null;
}

function notResolved(match: { ok: boolean; reason?: "not_found" | "ambiguous"; alternatives?: string[] } | undefined) {
  if (!match || match.ok) return null;
  return machineNotResolved({ ok: false, reason: match.reason ?? "not_found", candidates: match.alternatives ?? [] });
}

export async function faultList(scope: FarmDataScope, input: { status?: "open" | "resolved" | "all" | null; machine?: string | null }) {
  const result = await listFaults(readScope(scope), { machine: input.machine ?? undefined, view: input.status ?? "open", limit: 12 });
  const unresolved = notResolved(result.match);
  if (unresolved) return unresolved;
  return {
    status: input.status ?? "open",
    faults: result.faults.map((row) => ({
      machine: row.machine,
      problem: row.description ?? row.category,
      urgency: row.urgency,
      status: row.status,
      reported: day(row.reportedAt),
    })),
    ...(result.faults.length >= 12 ? { more: "possibly more, see the Faults page" } : {}),
  };
}

export async function jobCardList(
  scope: FarmDataScope,
  input: { status?: "active" | "completed" | "all" | null; type?: "scheduled_service" | "repair" | "inspection" | "other" | null; machine?: string | null },
) {
  const result = await listJobCards(readScope(scope), {
    machine: input.machine ?? undefined,
    view: input.status ?? "active",
    type: input.type ?? undefined,
    limit: 12,
  });
  const unresolved = notResolved(result.match);
  if (unresolved) return unresolved;
  return {
    status: input.status ?? "active",
    jobCards: result.jobCards.map((row) => ({
      machine: row.machine,
      type: row.type,
      status: row.status,
      in: day(row.dateIn),
      out: day(row.dateOut),
      problem: row.problem,
      work: row.workPerformed,
      ...(scope.costsVisible && row.totalCents != null ? { totalRand: rand(row.totalCents) } : {}),
    })),
    ...(result.jobCards.length >= 12 ? { more: "possibly more, see the Job cards page" } : {}),
  };
}

export async function workRequestList(scope: FarmDataScope, input: { status?: "active" | "all" | null; machine?: string | null }) {
  const result = await listWorkRequests(readScope(scope), { machine: input.machine ?? undefined, view: input.status ?? "active", limit: 12 });
  const unresolved = notResolved(result.match);
  if (unresolved) return unresolved;
  return {
    workRequests: result.workRequests.map((row) => ({
      machine: row.machine,
      kind: row.kind,
      status: row.status,
      title: row.title,
      ...(scope.costsVisible && row.quoteAmountCents != null ? { quoteRand: rand(row.quoteAmountCents) } : {}),
      ...(scope.costsVisible && row.invoiceAmountCents != null ? { invoiceRand: rand(row.invoiceAmountCents) } : {}),
      updated: day(row.updatedAt),
    })),
  };
}

export async function documentList(
  scope: FarmDataScope,
  input: { kind?: "quote" | "invoice" | null; outstandingOnly?: boolean | null; machine?: string | null },
) {
  if (!canReadFinancialDocuments(scope.role)) return { notAllowed: "This role cannot see quotes or invoices." };
  const result = await listDocuments(readScope(scope), {
    machine: input.machine ?? undefined,
    kind: input.kind ?? undefined,
    outstandingOnly: Boolean(input.outstandingOnly),
    limit: 12,
  });
  const unresolved = notResolved(result.match);
  if (unresolved) return unresolved;
  return {
    documents: result.documents.map((row) => ({
      kind: row.kind,
      number: row.number,
      subject: row.subject,
      status: row.status,
      machine: row.machine,
      issued: day(row.issueDate),
      due: day(row.dueDate),
      totalRand: rand(row.totalCents),
      outstandingRand: rand(row.outstandingCents),
    })),
  };
}

/** One machine in full: what it is, its meter, every service line, faults, jobs and fuel. */
export async function machineDetails(scope: FarmDataScope, input: { machine: string }, today: string) {
  const pick = pickMachine(scope, input.machine);
  if (!pick) return { machineNotResolved: "not_found", hint: "Ask which machine." };
  if (!pick.ok) return machineNotResolved(pick);
  const machine = pick.machine;
  const since = addDays(today, -90);
  // The machine is resolved: every read below is scoped to it alone. Matching its name
  // again against the whole fleet can come back ambiguous ("Groen John Deere" also scores
  // 0.98 on every other John Deere), the trap local-read.ts scopeForChosenMachine avoids.
  const one: FarmDataScope = { ...scope, machines: [machine] };
  const [info, readings, service, faults, jobs, fuel] = await Promise.all([
    scope.supabase.from("machines").select("type, make, model, year, reg_no, location, status").eq("id", machine.id).maybeSingle(),
    scope.supabase.from("meter_readings").select("reading, reading_date").eq("farm_id", scope.farmId).eq("machine_id", machine.id)
      .is("deleted_at", null).order("reading_date", { ascending: false }).order("created_at", { ascending: false }).limit(5),
    servicePlan(one, { machine: machine.name }),
    faultList(one, { status: "open", machine: machine.name }),
    jobCardList(one, { status: "active", machine: machine.name }),
    fuelSummary(one, { from: since, to: today, machine: machine.name }, today),
  ]);
  const row = (info.data as { type: string | null; make: string | null; model: string | null; year: number | null; reg_no: string | null; location: string | null; status: string } | null) ?? null;
  const unit = machine.meterType === "km" ? "km" : machine.meterType === "hours" ? "h" : machine.meterType;
  return {
    machine: machine.name,
    type: row?.type ?? null,
    makeModel: [row?.make ?? machine.make, row?.model ?? machine.model].filter(Boolean).join(" ") || null,
    year: row?.year ?? null,
    registration: row?.reg_no ?? null,
    location: row?.location ?? null,
    status: row?.status ?? machine.status,
    meter: machine.currentReading != null ? `${machine.currentReading} ${unit} on ${machine.currentReadingDate ?? "an unknown date"}` : "no reading recorded",
    recentReadings: ((readings.data as Array<{ reading: number | string; reading_date: string }> | null) ?? []).map((r) => `${num(r.reading)} ${unit} on ${r.reading_date}`),
    service,
    openFaults: "faults" in faults ? faults.faults : faults,
    activeJobCards: "jobCards" in jobs ? jobs.jobCards : jobs,
    fuelLast90Days: "total" in fuel ? { ...fuel.total, ...(fuel.byMachine[0] ? { rate: fuel.byMachine[0] } : {}) } : fuel,
  };
}

/** The fleet in one line per machine, for the model's prompt: what most questions need. */
export function fleetSnapshot(machines: AssistantMachine[], limit = 150): string {
  const lines = machines.slice(0, limit).map((machine) => {
    const unit = machine.meterType === "km" ? "km" : machine.meterType === "hours" ? "h" : "";
    const what = [machine.type, [machine.make, machine.model].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const meter = machine.currentReading != null ? `${machine.currentReading} ${unit}`.trim() + (machine.currentReadingDate ? ` on ${machine.currentReadingDate}` : "") : "no meter reading";
    const due = machine.serviceStatus
      ? `service ${machine.serviceStatus.replace("_", " ")}${machine.nextDueReading != null || machine.nextDueDate ? ` (next ${[machine.nextDueReading != null ? `${machine.nextDueReading} ${unit}`.trim() : null, machine.nextDueDate].filter(Boolean).join(" or ")})` : ""}`
      : "no service plan";
    return `- ${machine.name}${what ? ` (${what})` : ""}: ${machine.status.replace("_", " ")}; ${meter}; ${due}`;
  });
  const more = machines.length > limit ? `\n- and ${machines.length - limit} more machines (ask by name)` : "";
  return lines.join("\n") + more;
}
