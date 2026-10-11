import "server-only";

import {
  PAGE_ROWS,
  addDays,
  daysBetween,
  machineNames,
  machineNotResolved,
  monthsIn,
  normalisePeriod,
  num,
  pickMachine,
  rand,
  round,
  type FarmDataScope,
} from "./farm-data";

/**
 * The rest of the farm's records, for the questions farm-data.ts could not answer.
 *
 * Added 2026-10-11 after the assistant was asked what it could not do: how many hours the
 * tractor worked last month, what it costs to run per hour, when the bakkie's licence
 * runs out, which tyres are worn, what is in the parts store, whether the farm is over its
 * repair budget, what a machine is worth now, which machine breaks down most. None of
 * those records reached the AI before.
 *
 * The rules are farm-data.ts's, unchanged: every read is on the person's own session, so
 * row policies decide what they see exactly as on the screens; money only for a role that
 * may see costs; the shapes are small and already added up, because they go into a prompt
 * and a model adding rows gets sums wrong; and no person's name is ever returned (drivers'
 * documents and fines are counted and dated, never named), because names would leave the
 * country with the prompt.
 */

const MONEY_HIDDEN = "not visible for this role";

type Row = Record<string, unknown>;

function rows<T = Row>(data: unknown): T[] {
  return (data as T[] | null) ?? [];
}

function money(scope: FarmDataScope): string {
  return scope.costsVisible ? "rand, ex VAT unless marked incl VAT" : MONEY_HIDDEN;
}

function fleetById(scope: FarmDataScope) {
  return new Map(scope.machines.map((machine) => [machine.id, machine]));
}

function resolve(scope: FarmDataScope, query: string | null | undefined) {
  const pick = pickMachine(scope, query);
  if (pick && !pick.ok) return { error: machineNotResolved(pick) } as const;
  return { machineId: pick?.ok ? pick.machine.id : null, machineName: pick?.ok ? pick.machine.name : null } as const;
}

/** Up to `pages` pages of a query PostgREST would otherwise cut at a thousand rows. */
async function paged<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  pages = 4,
): Promise<{ list: T[]; truncated: boolean }> {
  const list: T[] = [];
  for (let page = 0; page < pages; page += 1) {
    const { data, error } = await build(page * PAGE_ROWS, page * PAGE_ROWS + PAGE_ROWS - 1);
    if (error) throw error;
    const chunk = rows<T>(data);
    list.push(...chunk);
    if (chunk.length < PAGE_ROWS) return { list, truncated: false };
  }
  return { list, truncated: true };
}

type CostRow = {
  machine_id: string | null;
  fuel_cents: number | string;
  parts_cents: number | string;
  labour_cents: number | string;
  invoice_cents: number | string;
  other_cents: number | string;
  purchase_cents: number | string;
  finance_cents: number | string;
  total_cents: number | string;
};

/** Running costs (fuel, parts, labour, workshop invoices, other) per machine in a period, in cents. */
async function runningCostsByMachine(scope: FarmDataScope, from: string, to: string, machineId: string | null) {
  const { data, error } = await scope.supabase.rpc("assistant_cost_summary", {
    p_farm: scope.farmId,
    p_from: from,
    p_to: to,
    p_by: "machine",
    p_machine: machineId,
  });
  if (error) throw error;
  const out = new Map<string | null, CostRow>();
  for (const row of rows<CostRow>(data)) out.set(row.machine_id, row);
  return out;
}

function running(row: CostRow | undefined): number {
  if (!row) return 0;
  return num(row.fuel_cents) + num(row.parts_cents) + num(row.labour_cents) + num(row.invoice_cents) + num(row.other_cents);
}

// == Usage: hours and kilometres worked =======================================

/**
 * What each machine's meter moved in a period: from the last reading before it (or the
 * first in it) to the last in it, per month, per day, and, for a role that sees money, the
 * running cost per hour or per kilometre over the same period. A reading lower than the
 * one before it is a replaced meter, not negative work: it is skipped and counted.
 */
export async function machineUsage(
  scope: FarmDataScope,
  input: { from?: string | null; to?: string | null; machine?: string | null },
  today: string,
) {
  const period = normalisePeriod(input.from, input.to, today, 6);
  const picked = resolve(scope, input.machine);
  if ("error" in picked) return { period, ...picked.error };
  const { machineId } = picked;
  const since = addDays(period.from, -180);
  const { list, truncated } = await paged<{ machine_id: string; reading: number | string; reading_date: string }>((a, b) => {
    let q = scope.supabase
      .from("meter_readings")
      .select("machine_id, reading, reading_date")
      .eq("farm_id", scope.farmId)
      .is("deleted_at", null)
      .is("voided_reason", null)
      .gte("reading_date", since)
      .lte("reading_date", period.to)
      .order("reading_date", { ascending: true })
      .order("created_at", { ascending: true });
    if (machineId) q = q.eq("machine_id", machineId);
    return q.range(a, b);
  });
  const costs = scope.costsVisible ? await runningCostsByMachine(scope, period.from, period.to, machineId).catch(() => null) : null;

  const fleet = fleetById(scope);
  const byMachine = new Map<string, Array<{ reading: number; date: string }>>();
  for (const row of list) {
    const series = byMachine.get(row.machine_id) ?? [];
    series.push({ reading: num(row.reading), date: row.reading_date });
    byMachine.set(row.machine_id, series);
  }
  const names = await machineNames(scope, [...byMachine.keys()]);
  const months = monthsIn(period);
  const machines = [];
  const noReadings: string[] = [];
  for (const [id, series] of byMachine) {
    const before = series.filter((r) => r.date < period.from);
    const inside = series.filter((r) => r.date >= period.from);
    if (!inside.length) {
      noReadings.push(names.get(id) ?? "Machine");
      continue;
    }
    const chain = before.length ? [before[before.length - 1], ...inside] : inside;
    let used = 0;
    let meterChanges = 0;
    const perMonth = new Map<string, number>();
    for (let i = 1; i < chain.length; i += 1) {
      const delta = chain[i].reading - chain[i - 1].reading;
      if (delta < 0) {
        meterChanges += 1;
        continue;
      }
      used += delta;
      const month = chain[i].date.slice(0, 7);
      perMonth.set(month, (perMonth.get(month) ?? 0) + delta);
    }
    const first = chain[0];
    const last = chain[chain.length - 1];
    const days = Math.max(1, daysBetween(first.date, last.date));
    const unit = fleet.get(id)?.meterType === "km" ? "km" : "hours";
    const runningCents = costs ? running(costs.get(id)) : null;
    machines.push({
      machine: names.get(id) ?? "Machine",
      unit,
      from: { date: first.date, reading: round(first.reading, 1) },
      to: { date: last.date, reading: round(last.reading, 1) },
      used: round(used, 1),
      readingsInPeriod: inside.length,
      averagePerDay: round(used / days, 2),
      averagePerMonth: round((used / days) * 30.44, 1),
      ...(runningCents !== null
        ? {
            runningCostRand: rand(runningCents) ?? 0,
            ...(used > 0 ? { [unit === "km" ? "runningCostPerKmRand" : "runningCostPerHourRand"]: round(runningCents / 100 / used, 2) } : {}),
          }
        : {}),
      ...(meterChanges ? { meterReplaced: meterChanges } : {}),
      ...(!before.length ? { note: "No reading before the period: counted from the first reading in it." } : {}),
      byMonth: months.map((month) => ({ month, used: round(perMonth.get(month) ?? 0, 1) })),
    });
  }
  machines.sort((a, b) => b.used - a.used);
  // Months per machine only where they fit: a big fleet gets the totals.
  const slim = machines.length > 8 ? machines.map(({ byMonth: _byMonth, ...rest }) => rest) : machines;
  const unread = scope.machines
    .filter((m) => m.meterType !== "none" && (!machineId || m.id === machineId) && !byMachine.has(m.id))
    .map((m) => m.name);
  return {
    period,
    money: money(scope),
    note: "Usage is the meter's movement between readings; months with sparse readings are approximate. Running cost excludes purchase and finance.",
    machines: slim.slice(0, 30),
    ...(machines.length > 30 ? { moreMachines: machines.length - 30 } : {}),
    ...(noReadings.length || unread.length ? { noReadingsInPeriod: [...noReadings, ...unread].slice(0, 30) } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

// == Service and repair history ===============================================

type JobRow = {
  machine_id: string;
  type: string;
  date_in: string | null;
  date_out: string | null;
  meter_reading: number | string | null;
  work_performed: string | null;
  reported_problem: string | null;
  created_at: string;
  total_cents?: number | string | null;
  parts_total_cents?: number | string | null;
  labour_total_cents?: number | string | null;
};

/**
 * Completed job cards in a period: services, repairs and inspections, what they cost, how
 * long the machine was in, and when each machine was last serviced.
 */
export async function serviceHistory(
  scope: FarmDataScope,
  input: { from?: string | null; to?: string | null; machine?: string | null; type?: string | null },
  today: string,
) {
  const period = normalisePeriod(input.from, input.to, today, 12);
  const picked = resolve(scope, input.machine);
  if ("error" in picked) return { period, ...picked.error };
  const cols = "machine_id, type, date_in, date_out, meter_reading, work_performed, reported_problem, created_at"
    + (scope.costsVisible ? ", total_cents, parts_total_cents, labour_total_cents" : "");
  // The _visible projection: job card totals are money columns, granted only through it.
  let q = scope.supabase
    .from("job_cards_visible")
    .select(cols)
    .eq("farm_id", scope.farmId)
    .is("deleted_at", null)
    .in("status", ["completed", "approved"])
    .gte("created_at", `${addDays(period.from, -120)}T00:00:00Z`)
    .order("created_at", { ascending: false })
    .limit(PAGE_ROWS);
  if (picked.machineId) q = q.eq("machine_id", picked.machineId);
  if (input.type && ["scheduled_service", "repair", "inspection", "other"].includes(input.type)) q = q.eq("type", input.type);
  const { data, error } = await q;
  if (error) throw error;
  const done = (job: JobRow) => job.date_out ?? job.date_in ?? job.created_at.slice(0, 10);
  const jobs = rows<JobRow>(data).filter((job) => done(job) >= period.from && done(job) <= period.to);
  const names = await machineNames(scope, jobs.map((job) => job.machine_id));

  const byType = new Map<string, { count: number; cents: number; workshopDays: number; withDays: number }>();
  for (const job of jobs) {
    const entry = byType.get(job.type) ?? { count: 0, cents: 0, workshopDays: 0, withDays: 0 };
    entry.count += 1;
    entry.cents += num(job.total_cents);
    if (job.date_in && job.date_out) {
      entry.workshopDays += Math.max(0, daysBetween(job.date_in, job.date_out));
      entry.withDays += 1;
    }
    byType.set(job.type, entry);
  }
  const lastService = new Map<string, JobRow>();
  for (const job of jobs) {
    if (job.type !== "scheduled_service") continue;
    const seen = lastService.get(job.machine_id);
    if (!seen || done(job) > done(seen)) lastService.set(job.machine_id, job);
  }
  const totalCents = jobs.reduce((t, job) => t + num(job.total_cents), 0);
  return {
    period,
    ...(picked.machineName ? { machine: picked.machineName } : {}),
    money: money(scope),
    completedJobs: jobs.length,
    ...(scope.costsVisible ? { totalRand: rand(totalCents) ?? 0 } : {}),
    byType: [...byType.entries()].map(([type, v]) => ({
      type,
      jobs: v.count,
      ...(scope.costsVisible ? { totalRand: rand(v.cents) ?? 0, averagePerJobRand: rand(v.cents / v.count) ?? 0 } : {}),
      ...(v.withDays ? { averageDaysInWorkshop: round(v.workshopDays / v.withDays, 1) } : {}),
    })),
    lastServiceByMachine: [...lastService.entries()].map(([id, job]) => ({
      machine: names.get(id) ?? "Machine",
      date: done(job),
      ...(job.meter_reading != null ? { reading: num(job.meter_reading) } : {}),
    })),
    jobs: jobs.slice(0, 20).map((job) => ({
      date: done(job),
      machine: names.get(job.machine_id) ?? "Machine",
      type: job.type,
      ...(job.meter_reading != null ? { reading: num(job.meter_reading) } : {}),
      work: (job.work_performed ?? job.reported_problem ?? "").slice(0, 140) || undefined,
      ...(scope.costsVisible ? { totalRand: rand(job.total_cents) ?? 0, partsRand: rand(job.parts_total_cents) ?? 0, labourRand: rand(job.labour_total_cents) ?? 0 } : {}),
    })),
    ...(jobs.length > 20 ? { moreJobs: jobs.length - 20 } : {}),
  };
}

// == Licences, permits, warranties and drivers' documents =====================

/**
 * What expires: vehicle documents (licence disc, roadworthy, permits, insurance), machine
 * warranties by date and by hours, and drivers' documents (licences, PrDP, medicals),
 * counted and dated but never named.
 */
export async function complianceStatus(scope: FarmDataScope, input: { withinDays?: number | null; machine?: string | null }, today: string) {
  const within = Math.max(1, Math.min(365, Math.round(input.withinDays ?? 60)));
  const until = addDays(today, within);
  const picked = resolve(scope, input.machine);
  if ("error" in picked) return { asOf: today, ...picked.error };
  const visibleIds = scope.machines.map((m) => m.id);
  let lq = scope.supabase
    .from("licences")
    .select("machine_id, type, expiry_date")
    .eq("farm_id", scope.farmId)
    .is("deleted_at", null)
    .order("expiry_date", { ascending: true })
    .limit(500);
  if (picked.machineId) lq = lq.eq("machine_id", picked.machineId);
  const [licences, credentials, warranties] = await Promise.all([
    lq,
    picked.machineId
      ? Promise.resolve({ data: [], error: null })
      : scope.supabase
          .from("driver_credentials")
          .select("type, expiry_date")
          .eq("farm_id", scope.farmId)
          .is("deleted_at", null)
          .not("expiry_date", "is", null)
          .order("expiry_date", { ascending: true })
          .limit(500),
    scope.supabase
      .from("machines")
      .select("id, name, warranty_expiry_date, warranty_expiry_hours, current_reading, meter_type")
      .eq("farm_id", scope.farmId)
      .in("id", picked.machineId ? [picked.machineId] : visibleIds.slice(0, 300)),
  ]);
  if (licences.error) throw licences.error;
  const names = await machineNames(scope, rows<{ machine_id: string }>(licences.data).map((r) => r.machine_id));
  const state = (expires: string) => (expires < today ? "expired" : expires <= until ? "expiring" : "ok");
  const allLicences = rows<{ machine_id: string; type: string; expiry_date: string }>(licences.data);
  const vehicleDocuments = allLicences
    .filter((r) => r.expiry_date <= until)
    .map((r) => ({
      machine: names.get(r.machine_id) ?? "Machine",
      document: r.type,
      expires: r.expiry_date,
      daysLeft: daysBetween(today, r.expiry_date),
      status: state(r.expiry_date),
    }));
  const drivers = credentials.error ? null : rows<{ type: string; expiry_date: string }>(credentials.data);
  const driverDocuments = drivers
    ?.filter((r) => r.expiry_date <= until)
    .map((r) => ({ document: r.type, expires: r.expiry_date, daysLeft: daysBetween(today, r.expiry_date), status: state(r.expiry_date) }));
  const warrantyRows = warranties.error ? [] : rows<{ name: string; warranty_expiry_date: string | null; warranty_expiry_hours: number | string | null; current_reading: number | string | null; meter_type: string }>(warranties.data);
  const machineWarranties = warrantyRows
    .filter((m) => m.warranty_expiry_date || m.warranty_expiry_hours != null)
    .map((m) => ({
      machine: m.name,
      ...(m.warranty_expiry_date ? { untilDate: m.warranty_expiry_date, daysLeft: daysBetween(today, m.warranty_expiry_date) } : {}),
      ...(m.warranty_expiry_hours != null
        ? { untilReading: num(m.warranty_expiry_hours), currentReading: num(m.current_reading), unit: m.meter_type === "km" ? "km" : "hours" }
        : {}),
      status: m.warranty_expiry_date && m.warranty_expiry_date < today
        ? "expired"
        : m.warranty_expiry_hours != null && num(m.current_reading) >= num(m.warranty_expiry_hours)
          ? "expired by meter"
          : "in warranty",
    }));
  return {
    asOf: today,
    window: `expired, or expiring within ${within} days (to ${until})`,
    vehicleDocumentsTracked: allLicences.length,
    vehicleDocuments,
    ...(driverDocuments
      ? {
          driverDocumentsTracked: drivers!.length,
          driverDocuments,
          driverNote: "Drivers are not named here; their names are on the Team page, under Licences.",
        }
      : picked.machineId ? {} : { driverDocuments: "not visible for this role" }),
    machineWarranties,
  };
}

// == Tyres =====================================================================

/** Tyres on each machine with their last check, wear and use since fitting; what is in stock. */
export async function tyreStatus(scope: FarmDataScope, input: { machine?: string | null }) {
  const picked = resolve(scope, input.machine);
  if ("error" in picked) return picked.error;
  let fq = scope.supabase
    .from("tyre_fitments")
    .select("tyre_id, machine_id, axle, position_label, fitted_on, fitted_reading")
    .eq("farm_id", scope.farmId)
    .is("deleted_at", null)
    .is("removed_on", null)
    .limit(PAGE_ROWS);
  if (picked.machineId) fq = fq.eq("machine_id", picked.machineId);
  const [fitments, tyres, checks] = await Promise.all([
    fq,
    scope.supabase
      .from("tyres")
      .select("id, brand, pattern, size, status, new_tread_mm, purchase_date" + (scope.costsVisible ? ", purchase_cost_cents" : ""))
      .eq("farm_id", scope.farmId)
      .is("deleted_at", null)
      .limit(PAGE_ROWS),
    scope.supabase
      .from("tyre_checks")
      .select("tyre_id, checked_on, tread_mm, pressure_kpa")
      .eq("farm_id", scope.farmId)
      .is("deleted_at", null)
      .order("checked_on", { ascending: false })
      .limit(PAGE_ROWS),
  ]);
  if (fitments.error) throw fitments.error;
  if (tyres.error) throw tyres.error;
  const tyreById = new Map(rows<Row>(tyres.data).map((t) => [String(t.id), t]));
  const lastCheck = new Map<string, Row>();
  for (const check of checks.error ? [] : rows<Row>(checks.data)) if (!lastCheck.has(String(check.tyre_id))) lastCheck.set(String(check.tyre_id), check);
  const fleet = fleetById(scope);
  const names = await machineNames(scope, rows<{ machine_id: string }>(fitments.data).map((f) => f.machine_id));
  const fitted = rows<Row>(fitments.data).map((f) => {
    const tyre = tyreById.get(String(f.tyre_id)) ?? {};
    const check = lastCheck.get(String(f.tyre_id));
    const newTread = tyre.new_tread_mm != null ? num(tyre.new_tread_mm) : null;
    const tread = check ? num(check.tread_mm) : null;
    const machine = fleet.get(String(f.machine_id));
    const used = machine?.currentReading != null && f.fitted_reading != null ? num(machine.currentReading) - num(f.fitted_reading) : null;
    const leftPercent = tread != null && newTread ? Math.round((tread / newTread) * 100) : null;
    return {
      machine: names.get(String(f.machine_id)) ?? "Machine",
      position: f.position_label ?? f.axle,
      tyre: [tyre.brand, tyre.pattern, tyre.size].filter(Boolean).join(" ") || "Tyre",
      fittedOn: f.fitted_on,
      ...(used != null && used >= 0 ? { usedSinceFitted: round(used, 0), unit: machine?.meterType === "km" ? "km" : "hours" } : {}),
      ...(check ? { lastCheck: { date: check.checked_on, treadMm: tread, ...(check.pressure_kpa != null ? { pressureKpa: num(check.pressure_kpa) } : {}) } } : { lastCheck: null }),
      ...(newTread != null ? { newTreadMm: newTread } : {}),
      ...(leftPercent != null ? { treadLeftPercent: leftPercent } : {}),
      replaceSoon: tread != null && (tread <= 3 || (leftPercent != null && leftPercent <= 25)),
      ...(scope.costsVisible && tyre.purchase_cost_cents != null ? { costRand: rand(tyre.purchase_cost_cents as number) } : {}),
    };
  });
  const inStock = rows<Row>(tyres.data).filter((t) => t.status === "in_stock");
  const sizes = new Map<string, number>();
  for (const t of inStock) sizes.set(String(t.size ?? "unknown size"), (sizes.get(String(t.size ?? "unknown size")) ?? 0) + 1);
  return {
    money: money(scope),
    rule: "replaceSoon: 3 mm of tread or less, or a quarter of the new tread or less, at the last check.",
    fitted: fitted.slice(0, 60),
    ...(fitted.length > 60 ? { moreFitted: fitted.length - 60 } : {}),
    inStock: [...sizes.entries()].map(([size, count]) => ({ size, count })),
  };
}

// == Fines, incidents and warranty claims ======================================

/** Traffic fines, incidents and warranty claims in a period, with what is still open or owed. */
export async function finesIncidentsClaims(
  scope: FarmDataScope,
  input: { from?: string | null; to?: string | null; machine?: string | null },
  today: string,
) {
  const period = normalisePeriod(input.from, input.to, today, 12);
  const picked = resolve(scope, input.machine);
  if ("error" in picked) return { period, ...picked.error };
  const withMachine = <T extends { eq: (c: string, v: string) => T }>(q: T) => (picked.machineId ? q.eq("machine_id", picked.machineId) : q);
  const [fines, incidents, claims] = await Promise.all([
    withMachine(
      scope.supabase
        .from("fines")
        .select("machine_id, offence, offence_date, fine_date, status, nomination_deadline" + (scope.costsVisible ? ", amount_cents" : ""))
        .eq("farm_id", scope.farmId)
        .is("deleted_at", null)
        .gte("fine_date", period.from)
        .lte("fine_date", period.to)
        .order("fine_date", { ascending: false })
        .limit(300),
    ),
    withMachine(
      scope.supabase
        .from("incidents")
        .select("machine_id, kind, status, occurred_at, injuries" + (scope.costsVisible ? ", excess_incl_cents, claimed_incl_cents, settled_incl_cents" : ""))
        .eq("farm_id", scope.farmId)
        .is("deleted_at", null)
        .gte("occurred_at", `${period.from}T00:00:00Z`)
        .lte("occurred_at", `${period.to}T23:59:59Z`)
        .order("occurred_at", { ascending: false })
        .limit(300),
    ),
    withMachine(
      scope.supabase
        .from("warranty_claims")
        .select("machine_id, status, submitted_on, decided_on, created_at" + (scope.costsVisible ? ", claimed_ex_vat_cents, recovered_ex_vat_cents" : ""))
        .eq("farm_id", scope.farmId)
        .is("deleted_at", null)
        .gte("created_at", `${period.from}T00:00:00Z`)
        .order("created_at", { ascending: false })
        .limit(300),
    ),
  ]);
  const fineRows = fines.error ? null : rows<Row>(fines.data);
  const incidentRows = incidents.error ? null : rows<Row>(incidents.data);
  const claimRows = claims.error ? null : rows<Row>(claims.data);
  const names = await machineNames(scope, [...(fineRows ?? []), ...(incidentRows ?? []), ...(claimRows ?? [])].map((r) => String(r.machine_id)));
  const name = (r: Row) => names.get(String(r.machine_id)) ?? "Machine";
  const openFines = (fineRows ?? []).filter((f) => !["paid", "closed"].includes(String(f.status)));
  return {
    period,
    ...(picked.machineName ? { machine: picked.machineName } : {}),
    money: money(scope),
    fines: fineRows === null
      ? "not visible for this role"
      : {
          count: fineRows.length,
          outstanding: openFines.length,
          ...(scope.costsVisible ? { totalRand: rand(fineRows.reduce((t, f) => t + num(f.amount_cents), 0)) ?? 0, outstandingRand: rand(openFines.reduce((t, f) => t + num(f.amount_cents), 0)) ?? 0 } : {}),
          nominationsDue: openFines
            .filter((f) => f.nomination_deadline && String(f.nomination_deadline) >= today)
            .map((f) => ({ machine: name(f), deadline: f.nomination_deadline, daysLeft: daysBetween(today, String(f.nomination_deadline)) })),
          list: fineRows.slice(0, 15).map((f) => ({
            date: f.offence_date ?? f.fine_date,
            machine: name(f),
            offence: f.offence ? String(f.offence).slice(0, 80) : undefined,
            status: f.status,
            ...(scope.costsVisible ? { amountRand: rand(f.amount_cents as number) } : {}),
          })),
          driverNote: "Drivers are not named here; see the Fines page.",
        },
    incidents: incidentRows === null
      ? "not visible for this role"
      : {
          count: incidentRows.length,
          open: incidentRows.filter((i) => !["closed", "claim_settled", "claim_rejected", "no_claim"].includes(String(i.status))).length,
          withInjuries: incidentRows.filter((i) => i.injuries === true).length,
          ...(scope.costsVisible
            ? {
                claimedInclVatRand: rand(incidentRows.reduce((t, i) => t + num(i.claimed_incl_cents), 0)) ?? 0,
                settledInclVatRand: rand(incidentRows.reduce((t, i) => t + num(i.settled_incl_cents), 0)) ?? 0,
                excessInclVatRand: rand(incidentRows.reduce((t, i) => t + num(i.excess_incl_cents), 0)) ?? 0,
              }
            : {}),
          list: incidentRows.slice(0, 15).map((i) => ({ date: String(i.occurred_at).slice(0, 10), machine: name(i), kind: i.kind, status: i.status })),
        },
    warrantyClaims: claimRows === null
      ? "not visible for this role"
      : {
          count: claimRows.length,
          pending: claimRows.filter((c) => ["draft", "submitted"].includes(String(c.status))).length,
          ...(scope.costsVisible
            ? {
                claimedRand: rand(claimRows.reduce((t, c) => t + num(c.claimed_ex_vat_cents), 0)) ?? 0,
                recoveredRand: rand(claimRows.reduce((t, c) => t + num(c.recovered_ex_vat_cents), 0)) ?? 0,
              }
            : {}),
          list: claimRows.slice(0, 15).map((c) => ({ machine: name(c), status: c.status, submitted: c.submitted_on ?? undefined, decided: c.decided_on ?? undefined })),
        },
  };
}

// == Parts stock ===============================================================

/** What is in the parts store, what is at or below its reorder point, and how fast it goes. */
export async function stockLevels(scope: FarmDataScope, input: { search?: string | null; lowOnly?: boolean | null }, today: string) {
  const [stock, movements] = await Promise.all([
    scope.supabase
      .from("stock_items")
      .select("id, part_catalogue_id, unit, on_hand, reorder_point, bin")
      .eq("farm_id", scope.farmId)
      .is("deleted_at", null)
      .limit(PAGE_ROWS),
    scope.supabase
      .from("stock_movements")
      .select("stock_item_id, qty")
      .eq("farm_id", scope.farmId)
      .eq("kind", "issue")
      .is("deleted_at", null)
      .gte("occurred_on", addDays(today, -90))
      .limit(PAGE_ROWS * 2),
  ]);
  if (stock.error) throw stock.error;
  // The catalogue through its _visible projection, not embedded in the stock read: its typical
  // cost is a money column granted only there, and an embed reaches the raw table.
  const catalogueIds = [...new Set(rows<Row>(stock.data).map((item) => String(item.part_catalogue_id)))];
  const catalogue = catalogueIds.length
    ? await scope.supabase
        .from("parts_catalogue_visible")
        .select("id, part_no, description, category" + (scope.costsVisible ? ", typical_cost_cents" : ""))
        .in("id", catalogueIds.slice(0, PAGE_ROWS))
    : { data: [], error: null };
  if (catalogue.error) throw catalogue.error;
  const partById = new Map(rows<Row>(catalogue.data).map((part) => [String(part.id), part]));
  const items = { data: rows<Row>(stock.data).map((item) => ({ ...item, parts_catalogue: partById.get(String(item.part_catalogue_id)) ?? null })) };
  const issued = new Map<string, number>();
  for (const m of movements.error ? [] : rows<Row>(movements.data)) issued.set(String(m.stock_item_id), (issued.get(String(m.stock_item_id)) ?? 0) + Math.abs(num(m.qty)));
  const needle = input.search?.trim().toLocaleLowerCase("en-ZA") ?? "";
  const list = rows<Row>(items.data)
    .map((item) => {
      const part = (Array.isArray(item.parts_catalogue) ? item.parts_catalogue[0] : item.parts_catalogue) as Row | null;
      const onHand = num(item.on_hand);
      const reorder = item.reorder_point != null ? num(item.reorder_point) : null;
      const used90 = issued.get(String(item.id)) ?? 0;
      const weekly = used90 / (90 / 7);
      return {
        part: String(part?.part_no ?? ""),
        description: part?.description ? String(part.description).slice(0, 80) : undefined,
        category: part?.category ?? undefined,
        onHand,
        unit: item.unit,
        ...(reorder != null ? { reorderPoint: reorder } : {}),
        low: reorder != null && onHand <= reorder,
        usedLast90Days: round(used90, 1),
        ...(weekly > 0 ? { weeksLeftAtThatRate: round(onHand / weekly, 1) } : {}),
        ...(item.bin ? { bin: item.bin } : {}),
        ...(scope.costsVisible && part?.typical_cost_cents != null ? { typicalCostRand: rand(part.typical_cost_cents as number), stockValueRand: rand(num(part.typical_cost_cents) * onHand) } : {}),
      };
    })
    .filter((item) => !needle || `${item.part} ${item.description ?? ""} ${item.category ?? ""}`.toLocaleLowerCase("en-ZA").includes(needle))
    .filter((item) => !input.lowOnly || item.low)
    .sort((a, b) => Number(b.low) - Number(a.low) || a.part.localeCompare(b.part));
  return {
    money: money(scope),
    items: list.slice(0, 60),
    ...(list.length > 60 ? { moreItems: list.length - 60 } : {}),
    lowCount: list.filter((item) => item.low).length,
    ...(scope.costsVisible ? { stockValueRand: round(list.reduce((t, item) => t + num((item as { stockValueRand?: number }).stockValueRand), 0), 2) } : {}),
  };
}

// == Budgets ===================================================================

/** Each budget running on a day against what has been spent in its period, and whether spending is ahead of time. */
export async function budgetStatus(scope: FarmDataScope, input: { on?: string | null }, today: string) {
  if (!scope.costsVisible) return { money: MONEY_HIDDEN };
  const on = input.on && /^\d{4}-\d{2}-\d{2}$/.test(input.on) ? input.on : today;
  const { data, error } = await scope.supabase
    .from("budgets")
    .select("machine_id, category, period_type, period_start, period_end, amount_cents, note")
    .eq("farm_id", scope.farmId)
    .is("deleted_at", null)
    .lte("period_start", on)
    .gte("period_end", on)
    .limit(200);
  if (error) throw error;
  const budgets = rows<Row>(data);
  // One cost read per distinct period, not per budget.
  const periods = new Map<string, Promise<Map<string | null, CostRow>>>();
  for (const b of budgets) {
    const key = `${b.period_start}|${b.period_end}`;
    if (!periods.has(key)) {
      const end = String(b.period_end) > today ? today : String(b.period_end);
      periods.set(key, runningCostsByMachine(scope, String(b.period_start), end, null));
    }
  }
  const names = await machineNames(scope, budgets.map((b) => (b.machine_id ? String(b.machine_id) : null)));
  const out = [];
  for (const b of budgets) {
    const costs = await periods.get(`${b.period_start}|${b.period_end}`)!.catch(() => null);
    if (!costs) continue;
    const column = b.category ? `${String(b.category)}_cents` : null;
    let spentCents = 0;
    for (const [machineId, row] of costs) {
      if (b.machine_id && machineId !== b.machine_id) continue;
      spentCents += column ? num((row as unknown as Record<string, unknown>)[column]) : num(row.total_cents);
    }
    const budgetCents = num(b.amount_cents);
    const elapsed = Math.min(1, Math.max(0, (daysBetween(String(b.period_start), on) + 1) / (daysBetween(String(b.period_start), String(b.period_end)) + 1)));
    const spentShare = budgetCents > 0 ? spentCents / budgetCents : 0;
    out.push({
      for: b.machine_id ? names.get(String(b.machine_id)) ?? "Machine" : "whole farm",
      category: b.category ?? "all costs",
      period: { type: b.period_type, from: b.period_start, to: b.period_end },
      budgetRand: rand(budgetCents) ?? 0,
      spentRand: rand(spentCents) ?? 0,
      remainingRand: rand(budgetCents - spentCents) ?? 0,
      spentPercent: Math.round(spentShare * 100),
      periodElapsedPercent: Math.round(elapsed * 100),
      status: spentCents > budgetCents ? "over budget" : spentShare > elapsed + 0.1 ? "spending ahead of time" : "on track",
      ...(b.note ? { note: String(b.note).slice(0, 80) } : {}),
    });
  }
  return { on, money: money(scope), budgets: out, ...(budgets.length === 0 ? { note: "No budget covers this day." } : {}) };
}

// == What a machine is worth and has cost =====================================

/** Book value and depreciation, and three years of running and capital costs, per machine. */
export async function machineValue(scope: FarmDataScope, input: { machine?: string | null }, today: string) {
  if (!scope.costsVisible) return { money: MONEY_HIDDEN };
  const picked = resolve(scope, input.machine);
  if ("error" in picked) return picked.error;
  const from = addDays(today, -1095);
  const [book, costs] = await Promise.all([
    scope.supabase.rpc("farm_book_values", { p_farm: scope.farmId, p_on: today }),
    runningCostsByMachine(scope, from, today, picked.machineId),
  ]);
  if (book.error) throw book.error;
  const machines = rows<Row>(book.data)
    .filter((m) => !picked.machineId || m.machine_id === picked.machineId)
    .map((m) => {
      const c = costs.get(String(m.machine_id));
      return {
        machine: m.name,
        ...(m.purchase_date ? { purchased: m.purchase_date } : {}),
        ...(m.purchase_price_cents != null ? { purchasePriceRand: rand(m.purchase_price_cents as number) } : {}),
        depreciation: m.method,
        ...(m.book_value_cents != null ? { bookValueRand: rand(m.book_value_cents as number), depreciatedRand: rand(m.depreciated_cents as number) } : {}),
        ...(m.months_held != null ? { monthsHeld: m.months_held } : {}),
        runningCostsLast3YearsRand: rand(running(c)) ?? 0,
        ...(c ? { breakdownLast3YearsRand: { fuel: rand(c.fuel_cents), parts: rand(c.parts_cents), labour: rand(c.labour_cents), workshopInvoices: rand(c.invoice_cents), other: rand(c.other_cents), purchase: rand(c.purchase_cents), finance: rand(c.finance_cents) } } : {}),
      };
    })
    .sort((a, b) => num(b.runningCostsLast3YearsRand) - num(a.runningCostsLast3YearsRand));
  return {
    asOf: today,
    money: money(scope),
    costsCover: `${from} to ${today}`,
    machines: machines.slice(0, 30),
    ...(machines.length > 30 ? { moreMachines: machines.length - 30 } : {}),
  };
}

// == Fault patterns ============================================================

/** Faults per machine in a period: how many, how many stopped it, how long they took to fix, and the commonest kinds. */
export async function faultStats(scope: FarmDataScope, input: { from?: string | null; to?: string | null }, today: string) {
  const period = normalisePeriod(input.from, input.to, today, 12);
  const { list, truncated } = await paged<Row>((a, b) =>
    scope.supabase
      .from("faults")
      .select("machine_id, category, urgency, status, created_at, resolved_at")
      .eq("farm_id", scope.farmId)
      .is("deleted_at", null)
      .gte("created_at", `${period.from}T00:00:00Z`)
      .lte("created_at", `${period.to}T23:59:59Z`)
      .order("created_at", { ascending: true })
      .range(a, b),
  2);
  const names = await machineNames(scope, list.map((f) => String(f.machine_id)));
  const perMachine = new Map<string, { faults: number; open: number; stopped: number; fixDays: number; fixed: number }>();
  const categories = new Map<string, number>();
  let fixDays = 0;
  let fixed = 0;
  for (const f of list) {
    const id = String(f.machine_id);
    const entry = perMachine.get(id) ?? { faults: 0, open: 0, stopped: 0, fixDays: 0, fixed: 0 };
    entry.faults += 1;
    if (f.status !== "resolved") entry.open += 1;
    if (f.urgency === "stopped") entry.stopped += 1;
    if (f.resolved_at) {
      const days = Math.max(0, (Date.parse(String(f.resolved_at)) - Date.parse(String(f.created_at))) / 86_400_000);
      entry.fixDays += days;
      entry.fixed += 1;
      fixDays += days;
      fixed += 1;
    }
    perMachine.set(id, entry);
    const category = String(f.category ?? "uncategorised");
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  return {
    period,
    faults: list.length,
    open: list.filter((f) => f.status !== "resolved").length,
    // Said outright when nothing has been fixed: left out, the model invented "5 days"
    // (evaluation, 2026-10-11).
    averageDaysToFix: fixed ? round(fixDays / fixed, 1) : "no fault in this period has been fixed yet, so there is no average",
    faultsFixed: fixed,
    byMachine: [...perMachine.entries()]
      .map(([id, v]) => ({
        machine: names.get(id) ?? "Machine",
        faults: v.faults,
        open: v.open,
        stoppedTheMachine: v.stopped,
        averageDaysToFix: v.fixed ? round(v.fixDays / v.fixed, 1) : "none fixed yet",
      }))
      .sort((a, b) => b.faults - a.faults)
      .slice(0, 30),
    commonestKinds: [...categories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([category, count]) => ({ category, count })),
    ...(truncated ? { truncated: true } : {}),
  };
}
