/**
 * Audit / sale / warranty document packs (FR-13.4) — the GATHERING half.
 *
 * Everything a pack contains already exists in this product: service history, licences,
 * warranty, checklists, faults and their resolutions, operator assignments, meter
 * readings, costs. This module reads those rows and hands them to src/lib/pdf/packs.ts,
 * which turns them into a document. There is NO SQL of its own — no function, no view,
 * no migration — because a pack is an assembly of records the farm already keeps.
 *
 * TENANCY. Every query below goes through the CALLER'S RLS client (`createClient()` from
 * src/lib/supabase/server), never the service role. That is the whole tenancy argument:
 * a pack cannot contain another farm's machine because the caller cannot SELECT another
 * farm's machine, and `supabase/tests/rls_isolation.sql` G32 proves exactly the query
 * set used here for a cross-farm user, an operator and a contractor.
 *
 * ROLES. Packs are restricted to the farm side — owner / manager / mechanic, and
 * rr_admin in support mode. Two deliberate exclusions:
 *
 *   * OPERATOR. A driver can see their assigned machine (F7), but a sale pack prints the
 *     purchase price and the lifetime cost breakdown, and a compliance pack prints the
 *     names of the other people who drive the farm's vehicles. Neither belongs to the
 *     driver's job, and the farm can already switch cost visibility off for operators
 *     (`cost_visible_to_operators`), so handing them a costed PDF would contradict a
 *     setting the farm has explicitly set.
 *
 *   * WORKSHOP (contractor). This closes a real leak. F16 (0400) narrowed a contractor
 *     to the vehicles it actually works on, and withheld the farm's cost ledger unless
 *     the `see_costs` grant is on — but `machines.purchase_price_cents` and
 *     `machines.supplier` live on the MACHINE row, which a contractor working on that
 *     machine can read. The sale-pack route as it shipped checked only `profile.active`,
 *     so any linked contractor could pull a sale pack for a machine they were servicing
 *     and read what the farm paid for it and who from. Contractors are refused here.
 *
 * The role is resolved with `effectiveFarmRole(farm_id)`, not `profile.role`: under
 * multi-site (F7) one person can be an owner on one farm and an operator on another, and
 * the pack must be judged against the farm whose records it is about.
 */
import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  type Profile,
  type Role,
  checkEntitlement,
  currentFarmId,
  effectiveFarmRole,
  getProfile,
} from "@/lib/auth";
import {
  DEFAULT_LICENCE_LEAD_DAYS,
  DEFAULT_WARRANTY_HOURS_LEAD,
  DEFAULT_WARRANTY_LEAD_DAYS,
} from "@/lib/compliance";
import {
  defaultIssuer,
  isOnHand,
  type ComplianceInput,
  type PackChecklist,
  type PackCost,
  type PackFault,
  type PackIssuer,
  type PackJobCard,
  type PackLicence,
  type PackMachine,
  type PackPhoto,
  type PackPlanLine,
  type PackReading,
  type PackUsage,
  type SaleInput,
  type WarrantyInput,
} from "./packs";

/** Farm-side roles that may produce a pack. rr_admin is handled separately. */
const PACK_ROLES: Role[] = ["owner", "manager", "mechanic"];

const MACHINE_COLUMNS =
  "id, farm_id, name, type, status, make, model, year, serial_no, reg_no, location, " +
  "meter_type, current_reading, current_reading_date, purchase_date, purchase_price_cents, " +
  "supplier, warranty_expiry_date, warranty_expiry_hours, assigned_operator_id, " +
  "primary_attachment_id";

const LICENCE_COLUMNS = "machine_id, type, number, expiry_date, reminder_lead_days, notes";
const PLAN_COLUMNS =
  "machine_id, task, interval_hours, interval_months, last_done_reading, last_done_date, " +
  "next_due_reading, next_due_date, status";
const FAULT_COLUMNS =
  "machine_id, description, urgency, status, created_at, resolved_at, job_card_id";
const CHECKLIST_COLUMNS =
  "machine_id, template_name, status, completed_at, created_at, performed_by, meter_reading, notes";
const USAGE_COLUMNS = "machine_id, driver_user_id, driver_name, occurred_on, meter_reading";
const JOBCARD_COLUMNS =
  "machine_id, type, status, date_in, date_out, meter_reading, work_performed, total_cents, created_at";
const READING_COLUMNS = "machine_id, reading, reading_date, source";

type MachineRow = PackMachine & { farm_id: string; primary_attachment_id: string | null };

/**
 * How much history a pack carries. A pack is evidence, not an archive; a buyer wants a
 * readable meter trail, not four hundred rows. Job cards and faults are deliberately NOT
 * capped — those are the record itself, and a truncated service history would be exactly
 * the silent omission this feature exists to avoid.
 */
const READING_LIMIT = 40;
const USAGE_LIMIT = 200;

export type PackDenial = { status: number; reason: string };
export type PackAuth = { profile: Profile; farmId: string; role: Role };
export type MachinePackAuth = PackAuth & { machine: MachineRow };

function intSetting(settings: Record<string, unknown>, key: string, fallback: number): number {
  const raw = Number(settings?.[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * The farm-side identity a pack is issued under, plus the settings that decide when an
 * expiry counts as "expiring soon" — read from the farm so the pack and the notification
 * engine (0263) agree about what is urgent.
 */
async function loadIssuer(
  supabase: Awaited<ReturnType<typeof createClient>>,
  farmId: string,
  profile: Profile,
): Promise<PackIssuer> {
  const [{ data: farm }, { data: people }] = await Promise.all([
    supabase.from("farms").select("name, settings").eq("id", farmId).maybeSingle(),
    supabase.from("users").select("id, name").eq("farm_id", farmId),
  ]);
  const f = farm as { name: string; settings: Record<string, unknown> | null } | null;
  const settings = f?.settings ?? {};
  return defaultIssuer({
    farmName: f?.name ?? "",
    personName: profile.name,
    warrantyLeadDays: intSetting(settings, "warranty_lead_days", DEFAULT_WARRANTY_LEAD_DAYS),
    warrantyHoursLead: intSetting(settings, "warranty_hours_lead", DEFAULT_WARRANTY_HOURS_LEAD),
    licenceLeadDays: intSetting(settings, "licence_lead_days", DEFAULT_LICENCE_LEAD_DAYS),
    peopleById: new Map(
      ((people as { id: string; name: string }[] | null) ?? []).map((u) => [u.id, u.name]),
    ),
    generatedAt: new Date(),
  });
}

/**
 * Who may produce a FLEET pack, and for which farm.
 *
 * An rr_admin must be in support mode: `currentFarmId` returns the pinned farm only then,
 * and a fleet compliance pack spanning every customer is not a document that means
 * anything. Refusing is better than emitting one silently blended.
 */
export async function authorizeFleetPack(): Promise<PackAuth | PackDenial> {
  const profile = await getProfile();
  if (!profile || !profile.active) return { status: 401, reason: "unauthenticated" };
  if (profile.role === "workshop") return { status: 403, reason: "contractor" };
  if (profile.role === "operator") return { status: 403, reason: "operator" };
  const farmId = await currentFarmId(profile);
  if (!farmId) {
    return { status: 403, reason: profile.role === "rr_admin" ? "no-support-farm" : "no-farm" };
  }
  if (profile.role === "rr_admin") return { profile, farmId, role: "rr_admin" };
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !PACK_ROLES.includes(role)) return { status: 403, reason: "role" };
  return { profile, farmId, role };
}

/**
 * Who may produce a pack about ONE machine. The machine is resolved through RLS first,
 * so a cross-farm id is a 404 before any role question is asked.
 */
export async function authorizeMachinePack(
  machineId: string,
): Promise<MachinePackAuth | PackDenial> {
  const profile = await getProfile();
  if (!profile || !profile.active) return { status: 401, reason: "unauthenticated" };
  if (profile.role === "workshop") return { status: 403, reason: "contractor" };
  if (profile.role === "operator") return { status: 403, reason: "operator" };
  if (!/^[0-9a-f-]{36}$/i.test(machineId)) return { status: 404, reason: "not-found" };

  const supabase = await createClient();
  const { data } = await supabase
    .from("machines")
    .select(MACHINE_COLUMNS)
    .eq("id", machineId)
    .is("deleted_at", null)
    .maybeSingle();
  const machine = data as MachineRow | null;
  // RLS answered this, not a farm filter written by hand: another farm's machine is
  // simply not there.
  if (!machine) return { status: 404, reason: "not-found" };

  if (profile.role === "rr_admin") {
    return { profile, farmId: machine.farm_id, role: "rr_admin", machine };
  }
  const role = await effectiveFarmRole(machine.farm_id, profile);
  if (!role || !PACK_ROLES.includes(role)) return { status: 403, reason: "role" };
  return { profile, farmId: machine.farm_id, role, machine };
}

export function isDenial(v: PackAuth | MachinePackAuth | PackDenial): v is PackDenial {
  return typeof (v as PackDenial).status === "number";
}

// ── Fleet / per-machine compliance ───────────────────────────────────────────

export async function gatherFleetCompliance(
  auth: PackAuth,
): Promise<ComplianceInput & { excludedCount: number }> {
  const supabase = await createClient();
  const { farmId, profile } = auth;

  // Every child query is farm-filtered as well as RLS-scoped. The filter is for
  // MULTI-SITE (F7) — a person who reaches three farms must get the farm they are acting
  // in, not all three blended — and never as the isolation mechanism, which is RLS.
  const [issuer, machinesRes, licRes, planRes, faultRes, chkRes, usageRes] = await Promise.all([
    loadIssuer(supabase, farmId, profile),
    supabase.from("machines").select(MACHINE_COLUMNS)
      .eq("farm_id", farmId).is("deleted_at", null).order("name"),
    supabase.from("licences").select(LICENCE_COLUMNS)
      .eq("farm_id", farmId).is("deleted_at", null).order("expiry_date"),
    supabase.from("service_plan_lines").select(PLAN_COLUMNS)
      .eq("farm_id", farmId).is("deleted_at", null).order("task"),
    supabase.from("faults").select(FAULT_COLUMNS)
      .eq("farm_id", farmId).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("checklist_instances").select(CHECKLIST_COLUMNS)
      .eq("farm_id", farmId).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("usage_logs").select(USAGE_COLUMNS)
      .eq("farm_id", farmId).is("deleted_at", null)
      .order("occurred_on", { ascending: false }).limit(USAGE_LIMIT),
  ]);

  const all = (machinesRes.data as MachineRow[] | null) ?? [];
  // Retired and sold are out of every fleet compliance figure (Scope 4.1 / C8) — but the
  // NUMBER excluded is carried through and printed, because a total nobody can reconcile
  // against the farm's own machine list is a total an auditor will query.
  const machines = all.filter(isOnHand);
  const ids = new Set(machines.map((m) => m.id));
  const keep = <T extends { machine_id: string }>(rows: T[] | null) =>
    (rows ?? []).filter((r) => ids.has(r.machine_id));

  return {
    machines,
    excludedCount: all.length - machines.length,
    licences: keep(licRes.data as PackLicence[] | null),
    plan: keep(planRes.data as PackPlanLine[] | null),
    faults: keep(faultRes.data as PackFault[] | null),
    checklists: keep(chkRes.data as PackChecklist[] | null),
    usage: keep(usageRes.data as PackUsage[] | null),
    issuer,
  };
}

export async function gatherMachineCompliance(
  auth: MachinePackAuth,
): Promise<ComplianceInput & { singleMachine: true }> {
  const supabase = await createClient();
  const { farmId, profile, machine } = auth;
  const id = machine.id;

  const [issuer, licRes, planRes, faultRes, chkRes, usageRes] = await Promise.all([
    loadIssuer(supabase, farmId, profile),
    supabase.from("licences").select(LICENCE_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null).order("expiry_date"),
    supabase.from("service_plan_lines").select(PLAN_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null).order("task"),
    supabase.from("faults").select(FAULT_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("checklist_instances").select(CHECKLIST_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("usage_logs").select(USAGE_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null)
      .order("occurred_on", { ascending: false }).limit(USAGE_LIMIT),
  ]);

  return {
    // Named explicitly, so its status is irrelevant: a retired machine still has a
    // compliance record and you asked for THIS one.
    machines: [machine],
    singleMachine: true,
    licences: (licRes.data as PackLicence[] | null) ?? [],
    plan: (planRes.data as PackPlanLine[] | null) ?? [],
    faults: (faultRes.data as PackFault[] | null) ?? [],
    checklists: (chkRes.data as PackChecklist[] | null) ?? [],
    usage: (usageRes.data as PackUsage[] | null) ?? [],
    issuer,
  };
}

// ── Sale ─────────────────────────────────────────────────────────────────────

export async function gatherSale(auth: MachinePackAuth): Promise<SaleInput> {
  const supabase = await createClient();
  const { farmId, profile, machine } = auth;
  const id = machine.id;

  // The cost section is the F5 `tco` feature wherever it appears. Denied does not mean
  // absent — packs.ts prints a sentence saying the figures are a Professional feature,
  // because a missing cost section on a sale document reads as a machine that cost
  // nothing.
  const [issuer, gate, licRes, planRes, jcRes, faultRes, readRes, photoRes] = await Promise.all([
    loadIssuer(supabase, farmId, profile),
    checkEntitlement("tco", profile),
    supabase.from("licences").select(LICENCE_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null).order("expiry_date"),
    supabase.from("service_plan_lines").select(PLAN_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null).order("task"),
    supabase.from("job_cards").select(JOBCARD_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("faults").select(FAULT_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("meter_readings").select(READING_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null)
      .order("reading_date", { ascending: false }).limit(READING_LIMIT),
    supabase.from("attachments").select("id, kind, created_at")
      .eq("parent_type", "machine").eq("parent_id", id).is("deleted_at", null).order("created_at"),
  ]);

  const costsAllowed = gate.allowed;
  let costs: PackCost[] = [];
  if (costsAllowed) {
    const { data } = await supabase
      .from("cost_entries")
      .select("type, amount_cents")
      .eq("machine_id", id)
      .is("deleted_at", null);
    costs = (data as PackCost[] | null) ?? [];
  }

  const photos: PackPhoto[] = (
    (photoRes.data as { id: string; kind: string; created_at: string }[] | null) ?? []
  ).map((a) => ({
    machine_id: id,
    kind: a.kind,
    created_at: a.created_at,
    is_primary: a.id === machine.primary_attachment_id,
  }));

  return {
    machine,
    licences: (licRes.data as PackLicence[] | null) ?? [],
    plan: (planRes.data as PackPlanLine[] | null) ?? [],
    jobCards: (jcRes.data as PackJobCard[] | null) ?? [],
    faults: (faultRes.data as PackFault[] | null) ?? [],
    readings: (readRes.data as PackReading[] | null) ?? [],
    photos,
    costs,
    costsAllowed,
    issuer,
  };
}

// ── Warranty ─────────────────────────────────────────────────────────────────

export async function gatherWarranty(auth: MachinePackAuth): Promise<WarrantyInput> {
  const supabase = await createClient();
  const { farmId, profile, machine } = auth;
  const id = machine.id;

  const [issuer, planRes, jcRes, faultRes, readRes] = await Promise.all([
    loadIssuer(supabase, farmId, profile),
    supabase.from("service_plan_lines").select(PLAN_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null).order("task"),
    supabase.from("job_cards").select(JOBCARD_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("faults").select(FAULT_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("meter_readings").select(READING_COLUMNS)
      .eq("machine_id", id).is("deleted_at", null)
      .order("reading_date", { ascending: false }).limit(READING_LIMIT),
  ]);

  return {
    machine,
    plan: (planRes.data as PackPlanLine[] | null) ?? [],
    jobCards: (jcRes.data as PackJobCard[] | null) ?? [],
    faults: (faultRes.data as PackFault[] | null) ?? [],
    readings: (readRes.data as PackReading[] | null) ?? [],
    issuer,
  };
}

/**
 * A denial rendered as a response — plain text, no redirect, because the caller asked for
 * a PDF and a 302 to HTML hands them a "PDF" full of markup (the lesson 0492 wrote into
 * the VAT routes).
 */
export function denialResponse(d: PackDenial): Response {
  const body = d.status === 401 ? "Unauthorized" : d.status === 404 ? "Not found" : "Forbidden";
  return new Response(`${body} (${d.reason})`, {
    status: d.status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** A pack filename: readable, ASCII, and never longer than a filesystem likes. */
export function packFilename(prefix: string, name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "fleetwise";
  return `${prefix}-${slug}.pdf`;
}
