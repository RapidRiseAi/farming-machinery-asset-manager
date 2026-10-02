import Link from "next/link";
import { errorMessage } from "@/lib/errors";
import { Photo } from "@/components/ui/photo";
import { notFound } from "next/navigation";
import { currentPlan, effectiveFarmRole } from "@/lib/auth";
import { planAllows, requiredPlan } from "@/lib/entitlements";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { createClient } from "@/lib/supabase/server";
import { canViewFarmCosts, readMachineFinancials } from "@/lib/cost-visibility";
import { rands } from "@/lib/money";
import { summariseCosts, costPerMeter, COST_TYPES } from "@/lib/cost";
import {
  computeUtilisation, repairVsReplace, addDaysYmd, UTILISATION_WINDOW_DAYS,
  DEFAULT_HOURS_PER_DAY, DEFAULT_KM_PER_DAY, DEFAULT_REPAIR_REPLACE_PCT,
} from "@/lib/analytics";
import {
  budgetProgress, budgetTone, budgetPeriodLabel, budgetCategoryLabel,
  BUDGET_PERIODS, type Budget, type BudgetCostRow,
} from "@/lib/budgets";
import { computeConsumption, formatConsumption, activityLabel, latestInterval, FUEL_ACTIVITIES } from "@/lib/fuel";
import { addFuelIssue } from "@/app/(app)/fuel/actions";
import { FuelTrend } from "@/components/fuel-trend";
import { t } from "@/lib/i18n";
import { MACHINE_STATUSES, typeLabel, statusLabel, meterLabel } from "@/lib/machine-options";
import { MachineFields, type OperatorOption } from "@/components/machine-fields";
import { MachinePhotos } from "@/components/machine-photos";
import { DocumentPacks } from "@/components/machines/document-packs";
import { MeterGraph } from "./meter-graph";
import { updateMachine, returnMachineToService } from "../actions";
import { addReading, correctReading, replaceMeter } from "./reading-actions";
import { setWatchStatus } from "./watch-actions";
import { addServiceLine, updateServiceLine, deleteServiceLine, applyTemplate } from "./service-actions";
import { createServiceKit, deleteServiceKit, addKitItem, updateKitItem, deleteKitItem } from "./kit-actions";
import { addLicence, updateLicence, deleteLicence } from "./licence-actions";
import { addBudget, updateBudget, deleteBudget } from "./budget-actions";
import {
  warrantyStatus,
  dateExpiryStatus,
  expiryTone,
  expiryLabel,
  licenceTypeLabel,
  LICENCE_TYPES,
  DEFAULT_WARRANTY_LEAD_DAYS,
  DEFAULT_WARRANTY_HOURS_LEAD,
} from "@/lib/compliance";
import { fineStatusLabel, fineStatusTone, nominationPending, nominationDeadlineStatus, DEFAULT_AARTO_LEAD_DAYS } from "@/lib/fines";
import { auditPlaceLabel, auditDevice, isHumanChange, type AuditRow } from "@/lib/audit-context";
import { createJobCard } from "@/app/(app)/jobcards/actions";
import { OfflineForm } from "@/components/offline/offline-form";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Fact, FactList } from "@/components/ui/facts";
import { Disclosure } from "@/components/ui/disclosure";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { backHref } from "@/components/ui/back-href";
import { readTab } from "@/components/ui/tabs-url";
import { cn } from "@/components/ui/cn";
import { StatusPill, StatusBadge, Badge, type BadgeTone } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button, buttonVariants } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { EmptyState, GetStarted } from "@/components/ui/empty-state";
import { ActionMenu } from "@/components/ui/action-menu";
import { menuItemClass } from "@/components/ui/menu-item";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import {
  JobCardsIcon,
  FaultsIcon,
  MachinesIcon,
  BellIcon,
  PlusIcon,
  ChecklistIcon,
  WorkIcon,
  TrashIcon,
  CheckIcon,
  CloseIcon,
  PinIcon,
} from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { daysAgo, meterReading, meterUnit, num, relativeDate, shortDate, todayLocal } from "@/lib/format";
import { SETTING_NUMBERS } from "@/lib/settings";
import { serviceDueText, worstServiceLine } from "./service-due";
import { setMachineStatus } from "./status-actions";
import { Tabs } from "@/components/ui/tabs";
import { ExpiryStatus, FineStatus, WorkStatus, MachineStatus } from "@/components/ui/status";
import { createWorkRequest } from "@/app/(app)/work/actions";
import {
  WORK_KINDS, WORK_PRIORITIES, workKindLabel, workPriorityLabel,
  workStatusLabel, workStatusTone,
} from "@/lib/work";

type Machine = {
  id: string; farm_id: string; name: string; type: string; make: string | null; model: string | null;
  year: number | null; serial_no: string | null; reg_no: string | null; meter_type: string;
  current_reading: number | null; current_reading_date: string | null; status: string;
  purchase_date: string | null; purchase_price_cents: number | null; supplier: string | null;
  warranty_expiry_date: string | null; warranty_expiry_hours: number | null; location: string | null; notes: string | null;
  assigned_operator_id: string | null; cost_centre: string | null; department: string | null;
  primary_attachment_id: string | null;
  finance_provider: string | null; finance_total_cents: number | null; finance_monthly_cents: number | null;
  finance_term_months: number | null; finance_interest_bps: number | null;
};
type Reading = { id: string; reading: number; reading_date: string; source: string };
type Usage = { id: string; driver_user_id: string | null; driver_name: string | null; occurred_on: string; meter_reading: number | null; source: string };
type JobCard = { id: string; type: string; status: string; total_cents: number; date_out: string | null; created_at: string };
type Fault = { id: string; description: string | null; urgency: string | null; status: string; created_at: string };
type Watch = { id: string; text: string; status: string; created_at: string; source_job_card_id: string | null };
type PlanLine = {
  id: string; task: string; interval_hours: number | null; interval_months: number | null;
  last_done_reading: number | null; last_done_date: string | null;
  next_due_reading: number | null; next_due_date: string | null; status: string;
};
type Template = { id: string; name: string; machine_type: string | null };
type CataloguePart = { id: string; part_no: string; description: string | null; typical_cost_cents: number | null };
type KitItem = { id: string; part_no: string | null; description: string | null; qty: number | null; unit_cost_cents: number | null; part_catalogue_id: string | null };
type ServiceKit = { id: string; name: string; notes: string | null; items: KitItem[] };

type Licence = {
  id: string; type: string; number: string | null; expiry_date: string;
  reminder_lead_days: number; notes: string | null;
};
type MachineFine = {
  id: string; notice_number: string | null; authority: string | null; offence: string | null;
  offence_date: string | null; amount_cents: number | null; nomination_deadline: string | null;
  status: string; driver_user_id: string | null; driver_name: string | null;
};

const savedMsg: Record<string, string> = {
  // These two say what actually moved, because both change every service due date on the
  // machine and "Saved" would not tell anybody that.
  "meter-corrected": "machine.savedMeterCorrected",
  "meter-replaced": "machine.savedMeterReplaced",
  // Straight from the Add machine form.
  created: "machines.created",
  reading: "ui.saved", status: "ui.saved", watch: "ui.saved", service: "ui.saved", template: "ui.saved", licence: "ui.saved", kit: "ui.saved", checklist: "ui.saved", budget: "ui.saved", "1": "ui.saved",
};

export default async function MachineDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; usageDate?: string; tab?: string; from?: string }>;
}) {
  // Governing plan for entitlement gates (null = rr_admin/workshop bypass).
  const { profile, plan } = await currentPlan();
  const fuelAllowed = plan == null ? true : planAllows(plan, "fuel");   // Professional+
  const aartoAllowed = plan == null ? true : planAllows(plan, "aarto"); // Complete+
  const { id } = await params;
  const sp = await searchParams;
  const locale = profile.lang;
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);

  const supabase = await createClient();
  const { data } = await supabase
    .from("machines")
    .select("id, farm_id, name, type, make, model, year, serial_no, reg_no, meter_type, current_reading, current_reading_date, status, purchase_date, warranty_expiry_date, warranty_expiry_hours, location, cost_centre, department, notes, assigned_operator_id, primary_attachment_id")
    .eq("id", id)
    .maybeSingle();
  const machineBase = data as Omit<Machine, "purchase_price_cents" | "supplier" | "finance_provider" | "finance_total_cents" | "finance_monthly_cents" | "finance_term_months" | "finance_interest_bps"> | null;
  if (!machineBase) notFound();

  // Every action and disclosure is decided against the machine's farm. `profile.role`
  // belongs to the primary farm and is not authoritative for a multi-site resource.
  const resourceRole = profile.role === "workshop"
    ? "workshop"
    : await effectiveFarmRole(machineBase.farm_id, profile);
  const canEdit = resourceRole === "owner" || resourceRole === "manager";
  const canAddReading = resourceRole != null && ["owner", "manager", "mechanic", "operator"].includes(resourceRole);
  // The same rule /faults uses to offer this machine in its report dialog.
  const canReportFault = resourceRole != null &&
    (["rr_admin", "owner", "manager", "mechanic"].includes(resourceRole) ||
      (resourceRole === "operator" && machineBase.assigned_operator_id === profile.id));
  const canJob = resourceRole != null && ["owner", "manager", "mechanic", "workshop"].includes(resourceRole);
  const costsVisible = await canViewFarmCosts(supabase, machineBase.farm_id);
  const financials = costsVisible ? await readMachineFinancials(supabase, id) : null;
  const machine: Machine = {
    ...machineBase,
    purchase_price_cents: financials?.purchase_price_cents ?? null,
    supplier: financials?.supplier ?? null,
    finance_provider: financials?.finance_provider ?? null,
    finance_total_cents: financials?.finance_total_cents ?? null,
    finance_monthly_cents: financials?.finance_monthly_cents ?? null,
    finance_term_months: financials?.finance_term_months ?? null,
    finance_interest_bps: financials?.finance_interest_bps ?? null,
  };

  // Primary vehicle image (0280): resolve its storage path → signed URL for the header.
  let primaryPhotoUrl: string | null = null;
  if (machine.primary_attachment_id) {
    const { data: pa } = await supabase
      .from("attachments")
      .select("storage_path")
      .eq("id", machine.primary_attachment_id)
      .is("deleted_at", null)
      .maybeSingle();
    const storagePath = (pa as { storage_path: string | null } | null)?.storage_path ?? null;
    if (storagePath) {
      const { data: signed } = await supabase.storage.from("machine-photos").createSignedUrl(storagePath, 3600);
      primaryPhotoUrl = signed?.signedUrl ?? null;
    }
  }

  const [readingsRes, jcRes, faultsRes, watchRes, planRes, tplRes, usageRes, opRes, costRes, fuelRes, fuelTankRes, licenceRes, farmRes, kitRes, catalogueRes, checklistRes, budgetRes, dimsRes] = await Promise.all([
    supabase.from("meter_readings").select("id, reading, reading_date, source").eq("machine_id", id).is("deleted_at", null).order("reading_date", { ascending: false }).limit(24),
    supabase.from("job_cards_visible").select("id, type, status, total_cents, date_out, created_at").eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("faults").select("id, description, urgency, status, created_at").eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("watch_items").select("id, text, status, created_at, source_job_card_id").eq("machine_id", id).order("created_at", { ascending: false }),
    supabase.from("service_plan_lines").select("id, task, interval_hours, interval_months, last_done_reading, last_done_date, next_due_reading, next_due_date, status").eq("machine_id", id).is("deleted_at", null).order("created_at"),
    supabase.from("service_templates").select("id, name, machine_type").is("deleted_at", null).or(`machine_type.eq.${machine.type},machine_type.is.null`),
    supabase.from("usage_logs").select("id, driver_user_id, driver_name, occurred_on, meter_reading, source").eq("machine_id", id).is("deleted_at", null).order("occurred_on", { ascending: false }).limit(20),
    supabase.from("users").select("id, name").eq("active", true).is("deleted_at", null).order("name"),
    costsVisible
      ? supabase.from("cost_entries").select("type, amount_cents, occurred_on, machine_id").eq("machine_id", id).is("deleted_at", null)
      : Promise.resolve({ data: [] }),
    supabase.from("fuel_issues_visible").select("id, date, litres, meter_reading, cost_cents, activity, anomaly_notified_at").eq("machine_id", id).is("deleted_at", null).order("date", { ascending: false }).limit(200),
    supabase.from("fuel_tanks").select("id, name").is("deleted_at", null).order("name"),
    supabase.from("licences").select("id, type, number, expiry_date, reminder_lead_days, notes").eq("machine_id", id).is("deleted_at", null).order("expiry_date"),
    supabase.from("farms").select("settings").eq("id", machine.farm_id).maybeSingle(),
    // Service kits (F9): this machine's part BOMs + their items.
    supabase.from("service_kits").select("id, name, notes").eq("machine_id", id).is("deleted_at", null).order("created_at"),
    // Catalogue parts visible to this user (global + own farm) for the kit-item picker.
    supabase.from("parts_catalogue_visible").select("id, part_no, description, typical_cost_cents").is("deleted_at", null).order("part_no"),
    // Vehicle checklists (F11): filled inspections/sign-offs/condition reports for this machine.
    supabase.from("checklist_instances").select("id, template_name, status, completed_at, created_at").eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }).limit(20),
    // Budgets (G1): this machine's spend targets → budget-vs-actual.
    costsVisible
      ? supabase.from("budgets").select("id, machine_id, category, period_type, period_start, period_end, amount_cents, note").eq("machine_id", id).is("deleted_at", null).order("period_start", { ascending: false })
      : Promise.resolve({ data: [] }),
    // The values the farm already uses, as the Edit dialog's suggestions (same as Add machine).
    supabase.from("machines").select("cost_centre, department, location").eq("farm_id", machine.farm_id).is("deleted_at", null),
  ]);
  const dims = (dimsRes.data as { cost_centre: string | null; department: string | null; location: string | null }[] | null) ?? [];
  const distinctValues = (values: (string | null)[]) =>
    [...new Set(values.map((v) => v?.trim() ?? "").filter((v) => v !== ""))].sort((a, b) => a.localeCompare(b));

  const readings = (readingsRes.data as Reading[] | null) ?? [];
  const jobCards = (jcRes.data as JobCard[] | null) ?? [];
  const faults = (faultsRes.data as Fault[] | null) ?? [];
  const watchAll = (watchRes.data as Watch[] | null) ?? [];
  const planLines = (planRes.data as PlanLine[] | null) ?? [];
  const templates = (tplRes.data as Template[] | null) ?? [];
  const usage = (usageRes.data as Usage[] | null) ?? [];
  const operators = (opRes.data as OperatorOption[] | null) ?? [];
  const operatorName = new Map(operators.map((o) => [o.id, o.name]));
  const openWatch = watchAll.filter((w) => w.status === "open");

  // Fuel & consumption (F4). L/hr or L/100km from this machine's metered draws (0242).
  type FuelDraw = { id: string; date: string; litres: number | null; meter_reading: number | null; cost_cents: number | null; activity: string | null; anomaly_notified_at: string | null };
  const fuelDraws = (fuelRes.data as FuelDraw[] | null) ?? [];
  const fuelTanks = (fuelTankRes.data as { id: string; name: string }[] | null) ?? [];
  const fuelConsumption = computeConsumption(fuelDraws, machine.meter_type);
  const canFuel = resourceRole != null && ["owner", "manager", "mechanic", "operator"].includes(resourceRole);

  // Driver-on-date lookup (AARTO nomination basis, FR-13.1): usage on a chosen date.
  const usageDate = sp.usageDate && /^\d{4}-\d{2}-\d{2}$/.test(sp.usageDate) ? sp.usageDate : null;
  // Asked of the database, not of the 20 rows the log below shows: a fine arrives weeks
  // later, and "no usage recorded" for a date past that window was simply wrong.
  const { data: usageDayData } = usageDate
    ? await supabase.from("usage_logs").select("id, driver_user_id, driver_name, occurred_on, meter_reading, source").eq("machine_id", id).eq("occurred_on", usageDate).is("deleted_at", null)
    : { data: [] };
  const usageOnDate = (usageDayData as Usage[] | null) ?? [];
  const driverLabel = (u: Usage) =>
    (u.driver_user_id ? operatorName.get(u.driver_user_id) : null) ?? u.driver_name ?? t("machine.unknownDriver", locale);
  const isOutOfService = machine.status === "out_of_service";
  const assignedOperatorName = machine.assigned_operator_id ? operatorName.get(machine.assigned_operator_id) : null;

  // AARTO fines on this vehicle (G2, FR-13.2). Only fetched when the plan unlocks AARTO.
  let machineFines: MachineFine[] = [];
  if (aartoAllowed) {
    const { data: fineData } = await supabase
      .from("fines")
      .select("id, notice_number, authority, offence, offence_date, amount_cents, nomination_deadline, status, driver_user_id, driver_name")
      .eq("machine_id", id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(12);
    machineFines = (fineData as MachineFine[] | null) ?? [];
  }
  const fineDriverLabel = (f: MachineFine) =>
    (f.driver_user_id ? operatorName.get(f.driver_user_id) : null) ?? f.driver_name ?? t("fines.driverUnknown", locale);

  // Compliance (F6): warranty (on machines) + licences/renewals. Status ok/expiring/expired
  // uses the same thresholds as the nightly expiry engine (0263).
  const licences = (licenceRes.data as Licence[] | null) ?? [];

  // Service kits (F9). Only owner/manager/mechanic edit the parts BOM.
  const canKit = resourceRole != null && ["owner", "manager", "mechanic"].includes(resourceRole);
  const catalogue = (catalogueRes.data as CataloguePart[] | null) ?? [];
  const kitHeaders = (kitRes.data ?? []) as { id: string; name: string; notes: string | null }[];
  const { data: kitItemsData } = kitHeaders.length
    ? await supabase.from("service_kit_items_visible")
      .select("id, service_kit_id, part_no, description, qty, unit_cost_cents, part_catalogue_id")
      .in("service_kit_id", kitHeaders.map((kit) => kit.id)).is("deleted_at", null)
    : { data: [] };
  const kitItems = (kitItemsData ?? []) as (KitItem & { service_kit_id: string })[];
  const kits: ServiceKit[] = kitHeaders.map((kit) => ({
    ...kit,
    items: kitItems.filter((item) => item.service_kit_id === kit.id),
  }));
  const farmSettings = ((farmRes.data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const warrantyLeadDays = Number(farmSettings.warranty_lead_days) || DEFAULT_WARRANTY_LEAD_DAYS;
  const warrantyHoursLead = Number(farmSettings.warranty_hours_lead) || DEFAULT_WARRANTY_HOURS_LEAD;
  const aartoLeadDays = Number(farmSettings.aarto_nomination_lead_days) || DEFAULT_AARTO_LEAD_DAYS;
  const hasWarranty = machine.warranty_expiry_date != null || machine.warranty_expiry_hours != null;
  const wStatus = warrantyStatus(machine, warrantyLeadDays, warrantyHoursLead);

  // Lifetime stats. TCO = every cost_entry for this asset (purchase + finance + fuel +
  // parts + labour + invoices + other). cost-per-hour / cost-per-km are TCO ÷ lifetime
  // meter on a consistent basis (fixes D-2/D-3); the same helper drives the reports page.
  const costRows = (costRes.data as BudgetCostRow[] | null) ?? [];
  const { total: tco, breakdown } = summariseCosts(costRows);
  const totalSpend = jobCards.reduce((a, j) => a + (j.total_cents || 0), 0);
  const perMeter =
    machine.meter_type === "hours" || machine.meter_type === "km"
      ? costPerMeter(tco, machine.current_reading)
      : null;
  const perMeterLabel = machine.meter_type === "km" ? t("machine.costPerKm", locale) : t("machine.costPerHour", locale);

  // Analytics (G1), utilisation, downtime + repair-vs-replace over a trailing window.
  // Capacity + threshold are farm-configurable (settings); downtime is reconstructed from
  // the audit-log status trail server-side (0361 rpc). Retired/sold machines are excluded
  // from fleet reports, but the per-machine detail still shows these for the asset itself.
  const todayYmd = todayLocal();
  const winFrom = addDaysYmd(todayYmd, -UTILISATION_WINDOW_DAYS);
  const hoursPerDay = Number(farmSettings.utilisation_hours_per_day) || DEFAULT_HOURS_PER_DAY;
  const kmPerDay = Number(farmSettings.utilisation_km_per_day) || DEFAULT_KM_PER_DAY;
  const repairPct = Number(farmSettings.repair_replace_pct) || DEFAULT_REPAIR_REPLACE_PCT;
  const utilisation = computeUtilisation(readings, machine.meter_type, winFrom, todayYmd, hoursPerDay, kmPerDay);
  const repair = repairVsReplace(breakdown, machine.purchase_price_cents, repairPct);
  const { data: downtimeData } = await supabase.rpc("machine_downtime_days", { p_machine: id, p_from: winFrom, p_to: todayYmd });
  const downtimeDays = Number(downtimeData ?? 0);

  // Budgets (G1), budget-vs-actual for this machine (actual summed from cost_entries).
  const budgets = (budgetRes.data as Budget[] | null) ?? [];
  const budgetRows = budgets.map((b) => budgetProgress(costRows, b));
  const canBudget = resourceRole === "owner" || resourceRole === "manager";
  const hasFinance =
    machine.finance_provider != null ||
    machine.finance_total_cents != null ||
    machine.finance_monthly_cents != null ||
    machine.finance_term_months != null ||
    machine.finance_interest_bps != null;
  const openFaultCount = faults.filter((f) => f.status !== "resolved").length;

  // Vehicle checklists (F11): completed/draft inspections + sign-offs for this machine.
  type ChecklistRow = { id: string; template_name: string; status: string; completed_at: string | null; created_at: string };
  const checklists = (checklistRes.data as ChecklistRow[] | null) ?? [];
  const canFill = resourceRole != null && ["owner", "manager", "mechanic", "workshop", "operator"].includes(resourceRole);
  const checklistStatusLabel = (s: string) =>
    s === "completed" ? t("checklists.statusCompleted", locale) : t("checklists.statusDraft", locale);

  // Work requests (F12b): this machine's contractor requests + the farm's linked
  // contractors (RLS returns workshops linked to farms the user can access).
  const canWorkReq = resourceRole != null && ["owner", "manager", "mechanic"].includes(resourceRole);
  type WR = { id: string; kind: string; status: string; priority: string; title: string | null; workshop_id: string | null; quote_amount_cents: number | null; invoice_amount_cents: number | null; updated_at: string };
  const [workReqRes, workshopRes] = await Promise.all([
    supabase.from("work_requests_visible").select("id, kind, status, priority, title, workshop_id, quote_amount_cents, invoice_amount_cents, updated_at").eq("machine_id", id).is("deleted_at", null).order("updated_at", { ascending: false }),
    supabase.from("workshops").select("id, name, kind"),
  ]);
  const workRequests = (workReqRes.data as WR[] | null) ?? [];
  const linkedWorkshops = (workshopRes.data as { id: string; name: string; kind: string }[] | null) ?? [];
  const workshopNameById = new Map(linkedWorkshops.map((w) => [w.id, w.name]));

  // Changes to the vehicle RECORD itself, with where they came from (FR-1.4, 0510).
  // `audit_log` is farm-scoped by its own RLS policy (0101), so this needs no filter
  // beyond the machine. The engine own writes are dropped by `isHumanChange`, because
  // every meter reading updates `machines` and without that the one row somebody is
  // looking for sits under fifty automatic ones.
  //
  // Twenty-five rows is a deliberate trade: `diff` carries the whole row before and
  // after, so this is the heaviest query on the page per row. Postgres cannot be asked
  // "only rows that changed something a person chose" without reading the diff, so the
  // filtering happens here and the window is kept small enough to pay for.
  const { data: auditData } = await supabase
    .from("audit_log")
    .select("id, user_id, action, at, diff, ip, geo_country, geo_region, geo_city, user_agent")
    .eq("entity", "machines")
    .eq("entity_id", id)
    .order("at", { ascending: false })
    .limit(25);
  const recordChanges = ((auditData as AuditRow[] | null) ?? []).filter((row) => isHumanChange(row)).slice(0, 8);
  const changeActorIds = [...new Set(recordChanges.map((r) => r.user_id).filter(Boolean) as string[])];
  const { data: changeActors } = changeActorIds.length
    ? await supabase.from("users").select("id, name").in("id", changeActorIds)
    : { data: [] };
  const changeActorName = new Map(
    ((changeActors as { id: string; name: string }[] | null) ?? []).map((u) => [u.id, u.name])
  );

  // Timeline (merge + sort desc).
  type Ev = { date: string; kind: "jobcard" | "fault" | "watch" | "checklist" | "work" | "audit"; title: string; sub: string; href?: string; count?: number };
  const events: Ev[] = [];
  for (const c of recordChanges) {
    // Who, when, and now where. The place is a signal a human reads, never evidence:
    // it comes from request headers and can be forged (see 0510's threat model).
    const who = (c.user_id && changeActorName.get(c.user_id)) || t("machine.evAuditSystem", locale);
    const place = auditPlaceLabel(c, locale);
    const device = auditDevice(c, locale);
    events.push({
      date: c.at.slice(0, 10),
      kind: "audit",
      title: t(`machine.evAudit${c.action === "insert" ? "Added" : c.action === "delete" ? "Removed" : "Edited"}`, locale),
      sub: [who, place, device].filter(Boolean).join(" · "),
    });
  }
  for (const j of jobCards)
    events.push({
      date: j.date_out ?? j.created_at.slice(0, 10),
      kind: "jobcard",
      title: `${t(`jobType.${j.type}`, locale)} · ${t(`jobStatus.${j.status}`, locale)}`,
      sub: costsVisible ? rands(j.total_cents) : "",
      href: `/jobcards/${j.id}`,
    });
  for (const f of faults)
    events.push({
      date: f.created_at.slice(0, 10),
      kind: "fault",
      title: f.description ?? t("machine.evFault", locale),
      sub: `${f.urgency ? t(`urgency.${f.urgency}`, locale) : ""}${f.urgency ? " · " : ""}${t(`faultStatus.${f.status}`, locale)}`,
      href: `/faults#fault-${f.id}`,
    });
  for (const w of watchAll)
    events.push({
      date: w.created_at.slice(0, 10),
      kind: "watch",
      title: w.text,
      sub: t(`watchStatus.${w.status}`, locale),
      href: w.source_job_card_id ? `/jobcards/${w.source_job_card_id}` : undefined,
    });
  for (const c of checklists)
    events.push({
      date: (c.completed_at ?? c.created_at).slice(0, 10),
      kind: "checklist",
      title: c.template_name,
      sub: checklistStatusLabel(c.status),
      href: `/machines/${machine.id}/checklists/${c.id}`,
    });
  // Contractor work requests (F12b) + their quotes/invoices (F13) on the timeline.
  for (const w of workRequests) {
    const amountLabel =
      costsVisible && w.invoice_amount_cents != null
        ? `${t("work.invoice", locale)}: ${rands(w.invoice_amount_cents)}`
        : costsVisible && w.quote_amount_cents != null
          ? `${t("work.quote", locale)}: ${rands(w.quote_amount_cents)}`
          : w.workshop_id
            ? (workshopNameById.get(w.workshop_id) ?? t("work.unassigned", locale))
            : t("work.unassigned", locale);
    events.push({
      date: w.updated_at.slice(0, 10),
      kind: "work",
      title: `${workKindLabel(w.kind, locale)} · ${workStatusLabel(w.status, locale)}`,
      sub: amountLabel,
      href: `/work/${w.id}`,
    });
  }
  events.sort((a, b) => b.date.localeCompare(a.date));

  // Several record edits on one day are one thing to a reader ("changed 3 times"), not
  // three identical rows. Only neighbouring audit rows on the same day fold together.
  const timeline: Ev[] = [];
  for (const e of events) {
    const prev = timeline[timeline.length - 1];
    if (e.kind === "audit" && prev?.kind === "audit" && prev.date === e.date) {
      prev.count = (prev.count ?? 1) + 1;
      prev.title = t("machine.evAuditMany", locale).replace("{n}", String(prev.count));
      continue;
    }
    timeline.push({ ...e });
  }
  const TIMELINE_ROWS = 15;
  const timelineRecent = timeline.slice(0, TIMELINE_ROWS);
  const timelineOlder = timeline.slice(TIMELINE_ROWS);

  const evIcon = (k: Ev["kind"]) =>
    k === "jobcard" ? <JobCardsIcon /> : k === "fault" ? <FaultsIcon /> : k === "checklist" ? <ChecklistIcon /> : k === "work" ? <WorkIcon /> : k === "audit" ? <PinIcon /> : <BellIcon />;
  const renderEvent = (e: Ev, i: number) => {
    const body = (
      <div className="flex gap-3 py-2.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sand-100 text-base text-sand-500">
          {evIcon(e.kind)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium text-sand-900">{e.title}</span>
            <span className="shrink-0 text-xs tabular-nums text-sand-500">{shortDate(e.date, locale)}</span>
          </div>
          {e.sub ? <p className="truncate text-sm text-sand-500">{e.sub}</p> : null}
        </div>
      </div>
    );
    return (
      <li key={i} className="border-b border-sand-100 last:border-0">
        {e.href ? <Link href={e.href} className="focus-ring block rounded-md">{body}</Link> : body}
      </li>
    );
  };

  // Service-line progress (0..1) and status colour.
  const today = new Date();
  const lineProgress = (l: PlanLine): number => {
    let p = 0;
    if (l.interval_hours && l.last_done_reading != null && l.next_due_reading != null && machine.current_reading != null) {
      const span = l.next_due_reading - l.last_done_reading;
      if (span > 0) p = Math.max(p, (machine.current_reading - l.last_done_reading) / span);
    }
    if (l.interval_months && l.last_done_date && l.next_due_date) {
      const start = new Date(l.last_done_date).getTime();
      const end = new Date(l.next_due_date).getTime();
      if (end > start) p = Math.max(p, (today.getTime() - start) / (end - start));
    }
    return Math.min(1, Math.max(0, p));
  };
  const statusBar: Record<string, string> = { ok: "bg-status-ok", due_soon: "bg-status-due", overdue: "bg-status-overdue" };
  const statusPillLabel = (s: string) => t(`ui.status${s === "due_soon" ? "DueSoon" : s === "overdue" ? "Overdue" : "Ok"}`, locale);

  const staleSetting = Number(farmSettings.stale_reading_days);
  const staleDays = Number.isFinite(staleSetting) && staleSetting > 0
    ? Math.round(staleSetting)
    : SETTING_NUMBERS.stale_reading_days;
  const isStale = machine.meter_type !== "none" &&
    (!machine.current_reading_date || (daysAgo(machine.current_reading_date) ?? Number.POSITIVE_INFINITY) > staleDays);
  const urgencyTone = (u: string | null): BadgeTone => {
    const s = (u ?? "").toLowerCase();
    if (s.includes("stop")) return "danger";
    if (s.includes("limp")) return "warning";
    return "neutral";
  };
  const isKm = machine.meter_type === "km";
  const intervalUnit = isKm ? t("machine.kmShort", locale) : t("machine.hrs", locale);
  const intervalLabel = isKm ? t("machine.intervalKm", locale) : t("machine.intervalHours", locale);
  const intervalText = (l: PlanLine) => {
    const parts: string[] = [];
    if (l.interval_hours) parts.push(`${num(l.interval_hours)} ${intervalUnit}`);
    if (l.interval_months) parts.push(`${l.interval_months} ${t("machine.mo", locale)}`);
    return `${t("machine.every", locale)} ${parts.join(" / ")}`;
  };
  const lastDoneText = (l: PlanLine) =>
    [
      l.last_done_reading != null ? meterReading(l.last_done_reading, machine.meter_type, locale) : null,
      l.last_done_date ? shortDate(l.last_done_date, locale) : null,
    ].filter(Boolean).join(" · ") || "-";
  const dueTone: Record<string, string> = { overdue: "text-status-overdue", due_soon: "text-status-due" };

  // Where a reading came from, in the reader's language (the column holds "manual").
  const sourceLabel = (src: string) => {
    const key = `meterSource.${src}`;
    const label = t(key, locale);
    return label === key ? src : label;
  };
  const readingText = (value: number | null | undefined) => meterReading(value, machine.meter_type, locale);

  // The header's "Next service": the plan line that needs attention first.
  const nextLine = worstServiceLine(planLines, machine.current_reading);
  const nextLineText = nextLine ? serviceDueText(nextLine, machine.current_reading, machine.meter_type, locale) : null;

  // The tab to open on: ?tab= from a save or a link, or History for a driver lookup.
  const tabKeys = ["overview", "servicing", ...(costsVisible ? ["costs"] : []), "history", "papers"];
  const initialTab = usageDate ? "history" : readTab(sp.tab, tabKeys);

  // The number to beat (the server refuses a reading below it). `min` is also the base of
  // the input's 0.1 step, so a reading stored with more decimals than that would make
  // every whole number "invalid": only use it when it sits on the step.
  const cr = machine.current_reading;
  const readingMin = cr != null && Math.abs(cr * 10 - Math.round(cr * 10)) < 1e-6 ? Math.round(cr * 10) / 10 : 0;

  // The meter-reading form: today in SA, and the operator logging their own shift.
  const defaultDriver =
    resourceRole === "operator" && operators.some((o) => o.id === profile.id)
      ? profile.id
      : machine.assigned_operator_id ?? "";

  // One edit dialog, two doors: the header's More menu and the Details card.
  const editMachineDialog = (look: "menuItem" | "button") => (
    <DialogForm
      triggerLook={look}
      trigger={look === "menuItem" ? t("machine.editMachine", locale) : t("common.edit", locale)}
      triggerVariant="secondary"
      triggerSize="sm"
      title={t("machine.editMachine", locale)}
      description={machine.name}
      closeLabel={closeLabel}
    >
      <form action={updateMachine} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={machine.id} />
        {/* The Details card lives on Papers, so an edit made there returns to Papers. */}
        {look === "button" ? <input type="hidden" name="return_tab" value="papers" /> : null}
        {/* Above the fields: MachineFields ends in collapsed optional sections, and a
            status below them was the one setting nobody found. */}
        <Field label={t("machines.status", locale)} htmlFor="status">
          <Select id="status" name="status" defaultValue={machine.status}>
            {MACHINE_STATUSES.map((s) => (
              <option key={s} value={s}>{statusLabel(s, locale)}</option>
            ))}
          </Select>
        </Field>
        <MachineFields
          machine={machine}
          operators={operators}
          locale={locale}
          costCentres={distinctValues(dims.map((d) => d.cost_centre))}
          departments={distinctValues(dims.map((d) => d.department))}
          locations={distinctValues(dims.map((d) => d.location))}
        />
        <DialogActions cancelLabel={cancelLabel}>
          <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  // The machine's own record, stated (it could only be read inside the edit form).
  const details: { label: string; value: string }[] = [
    { label: t("machines.regNo", locale), value: machine.reg_no ?? "" },
    { label: t("machines.serialNo", locale), value: machine.serial_no ?? "" },
    { label: t("machines.make", locale), value: machine.make ?? "" },
    { label: t("machines.model", locale), value: machine.model ?? "" },
    { label: t("machines.year", locale), value: machine.year ? String(machine.year) : "" },
    { label: t("machines.purchaseDate", locale), value: machine.purchase_date ? shortDate(machine.purchase_date, locale) : "" },
    { label: t("machines.supplier", locale), value: costsVisible ? machine.supplier ?? "" : "" },
    { label: t("machine.purchasePrice", locale), value: costsVisible && machine.purchase_price_cents != null ? rands(machine.purchase_price_cents) : "" },
    { label: t("machines.location", locale), value: machine.location ?? "" },
    { label: t("machines.costCentre", locale), value: machine.cost_centre ?? "" },
    { label: t("machines.department", locale), value: machine.department ?? "" },
    { label: t("machines.assignedOperator", locale), value: assignedOperatorName ?? "" },
    { label: t("machines.notes", locale), value: machine.notes ?? "" },
  ].filter((d) => d.value !== "");


  const typeTemplate = templates.find((tp) => tp.machine_type === machine.type) ?? null;
  const applyTemplateDialog = templates.length > 0 ? (
    <DialogForm
      trigger={planLines.length === 0 && typeTemplate
        ? t("machine.useTemplatePlan", locale).replace("{template}", typeTemplate.name)
        : t("machine.applyTemplate", locale)}
      triggerVariant="secondary"
      triggerSize="sm"
      title={t("machine.applyTemplate", locale)}
      closeLabel={closeLabel}
      size="md"
    >
      <form action={applyTemplate}>
        <input type="hidden" name="machine_id" value={machine.id} />
        <input type="hidden" name="farm_id" value={machine.farm_id} />
        <DialogFields columns={1}>
          <Field label={t("machine.template", locale)} htmlFor="sl-template" required>
            <Select id="sl-template" name="template_id" required defaultValue={typeTemplate?.id ?? ""}>
              <option value="" disabled>{t("machine.template", locale)}</option>
              {templates.map((tp) => (
                <option key={tp.id} value={tp.id}>{tp.name}</option>
              ))}
            </Select>
          </Field>
        </DialogFields>
        <DialogActions cancelLabel={cancelLabel}>
          <SubmitButton variant="primary">{t("machine.apply", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  ) : null;
  const addLineDialog = (
    <DialogForm
      trigger={t("machine.addServiceLine", locale)}
      triggerIcon={<PlusIcon />}
      triggerVariant="secondary"
      triggerSize="sm"
      title={t("machine.addServiceLine", locale)}
      closeLabel={closeLabel}
    >
      <form action={addServiceLine}>
        <input type="hidden" name="machine_id" value={machine.id} />
        <input type="hidden" name="farm_id" value={machine.farm_id} />
        <DialogFields>
          <div className="sm:col-span-2">
            <Field label={t("machine.task", locale)} htmlFor="sl-new-task" required>
              <Input id="sl-new-task" name="task" required />
            </Field>
          </div>
          <Field label={intervalLabel} htmlFor="sl-new-ih">
            <Input id="sl-new-ih" name="interval_hours" type="number" step="0.1" min={0} />
          </Field>
          <Field label={t("machine.intervalMonths", locale)} htmlFor="sl-new-im">
            <Input id="sl-new-im" name="interval_months" type="number" min={0} />
          </Field>
          <Field label={t("machine.lastDone", locale)} htmlFor="sl-new-lr">
            <Input id="sl-new-lr" name="last_done_reading" type="number" step="0.1" min={0} />
          </Field>
          <Field label={t("machine.lastDoneDate", locale)} htmlFor="sl-new-ld">
            <Input id="sl-new-ld" name="last_done_date" type="date" max={todayYmd} />
          </Field>
        </DialogFields>
        <DialogActions cancelLabel={cancelLabel}>
          <SubmitButton variant="primary">{t("common.add", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  return (
    <PageContainer>
      <PageHeader
        back={{ href: backHref(sp.from, "/machines"), label: t("machines.title", locale) }}
        title={machine.name}
        badge={<MachineStatus value={machine.status} locale={locale} size="md" />}
        meta={[
          typeLabel(machine.type, locale),
          machine.make ? `${machine.make} ${machine.model ?? ""}`.trim() : null,
          machine.reg_no,
          machine.year ? String(machine.year) : null,
          machine.location,
        ].filter(Boolean).join(" · ")}
      />

      {/*
        What the machine is doing, and the things people came here to do. On a phone this
        was a 132px empty photo box, a three-line subtitle, two numbers, three buttons over
        two rows and a separate out-of-service card, so the tabs began about 890px down.
        Now: a small photo beside the numbers that matter (meter, cost, next service), one
        action row, and everything else about the machine in its More menu.
      */}
      <section aria-label={machine.name} className="rounded-2xl border border-sand-200 bg-surface p-4 shadow-card">
        <div className="min-w-0">
          <div className="flex min-w-0 items-start gap-3 sm:gap-5">
            {/* Above the fold and the subject of the page, so it loads eagerly -
                lazy-loading the LCP image only delays it. */}
            <Photo
              src={primaryPhotoUrl}
              alt={machine.name}
              size="detail"
              priority
              className="h-16 w-16 shrink-0 rounded-xl ring-1 ring-sand-200 sm:h-24 sm:w-24"
              placeholder={<MachinesIcon className="text-2xl" />}
            />
            <div className="min-w-0 flex-1">
              <dl className="flex flex-wrap gap-x-8 gap-y-3">
                {machine.meter_type !== "none" ? (
                  <div>
                    <dt className="text-xs text-sand-500">{meterLabel(machine.meter_type, locale)}</dt>
                    <dd className="text-xl font-bold tabular-nums leading-tight text-sand-950">
                      {machine.current_reading != null ? readingText(machine.current_reading) : "-"}
                    </dd>
                    <dd className={`text-xs ${isStale ? "font-medium text-status-due" : "text-sand-500"}`}>
                      {machine.current_reading_date
                        ? t("machine.lastRead", locale).replace("{when}", relativeDate(machine.current_reading_date, locale))
                        : t("machines.neverRead", locale)}
                    </dd>
                  </div>
                ) : null}
                {costsVisible && perMeter != null ? (
                  <div>
                    <dt className="text-xs text-sand-500">{perMeterLabel}</dt>
                    <dd className="text-xl font-bold tabular-nums leading-tight text-sand-950">{rands(perMeter)}</dd>
                  </div>
                ) : null}
                {/* The column people scan on the list; it was only on the Servicing tab. */}
                {nextLine ? (
                  <div className="min-w-0">
                    <dt className="text-xs text-sand-500">{t("machines.nextService", locale)}</dt>
                    <dd>
                      <Link
                        href={`/machines/${machine.id}?tab=servicing`}
                        className="focus-ring -mx-1 inline-flex min-h-12 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1 sm:min-h-9"
                      >
                        <StatusPill status={nextLine.status as "ok" | "due_soon" | "overdue"} label={statusPillLabel(nextLine.status)} />
                        <span className="min-w-0 break-words text-sm font-medium text-sand-900">{nextLine.task}</span>
                      </Link>
                    </dd>
                    {nextLineText ? (
                      <dd className={cn("text-xs", dueTone[nextLine.status] ?? "text-sand-500")}>{nextLineText}</dd>
                    ) : null}
                  </div>
                ) : canEdit ? (
                  <div>
                    <dt className="text-xs text-sand-500">{t("machines.nextService", locale)}</dt>
                    <dd className="mt-1">
                      <Link
                        href={`/machines/${machine.id}?tab=servicing`}
                        className="focus-ring inline-flex min-h-12 items-center rounded-lg border border-dashed border-sand-300 px-3 text-sm font-medium text-sand-600 sm:min-h-9"
                      >
                        {t("machines.setUpPlan", locale)}
                      </Link>
                    </dd>
                  </div>
                ) : null}
                {openFaultCount > 0 ? (
                  <div>
                    <dt className="text-xs text-sand-500">{t("machine.openFaults", locale)}</dt>
                    <dd className="text-xl font-bold tabular-nums leading-tight text-status-overdue">{openFaultCount}</dd>
                  </div>
                ) : null}
              </dl>
              {/* The pill above already says "Out of service"; this says why and what next. */}
              {isOutOfService ? (
                <p className="mt-3 text-sm text-sand-700">{t("machine.outOfServiceHint", locale)}</p>
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {canJob ? (
              <form action={createJobCard}>
                <input type="hidden" name="machine_id" value={machine.id} />
                <input type="hidden" name="farm_id" value={machine.farm_id} />
                <input type="hidden" name="type" value="repair" />
                <SubmitButton variant="primary" leftIcon={<JobCardsIcon />}>
                  {t("machine.makeJobCard", locale)}
                </SubmitButton>
              </form>
            ) : null}
            {isOutOfService && canEdit ? (
              <form action={returnMachineToService}>
                <input type="hidden" name="id" value={machine.id} />
                <SubmitButton variant="secondary">{t("machine.returnToService", locale)}</SubmitButton>
              </form>
            ) : null}
            {/* The machine's own actions, in one menu titled with the machine. "View all"
                opened a one-item menu, while Edit machine was the last card on the fifth
                tab and a status change meant the 26-field edit form. */}
            <ActionMenu
              title={machine.name}
              label={t("nav.more", locale)}
              closeLabel={closeLabel}
              trigger={t("nav.more", locale)}
            >
              {canEdit ? editMachineDialog("menuItem") : null}
              {canEdit ? (
                <DialogForm
                  triggerLook="menuItem"
                  trigger={t("machine.changeStatus", locale)}
                  title={t("machine.changeStatus", locale)}
                  description={machine.name}
                  closeLabel={closeLabel}
                  size="md"
                >
                  <form action={setMachineStatus}>
                    <input type="hidden" name="id" value={machine.id} />
                    <DialogFields columns={1}>
                      <Field label={t("machines.status", locale)} htmlFor="ms-status" hint={t("machine.changeStatusHint", locale)}>
                        <Select id="ms-status" name="status" defaultValue={machine.status}>
                          {MACHINE_STATUSES.map((s) => (
                            <option key={s} value={s}>{statusLabel(s, locale)}</option>
                          ))}
                        </Select>
                      </Field>
                    </DialogFields>
                    <DialogActions cancelLabel={cancelLabel}>
                      <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                    </DialogActions>
                  </form>
                </DialogForm>
              ) : null}
              {canFill ? (
                <Link href={`/machines/${machine.id}/checklists/new`} className={menuItemClass()}>
                  {t("checklists.newChecklist", locale)}
                </Link>
              ) : null}
              {canReportFault ? (
                // Opens the report dialog on /faults with this machine already chosen.
                <Link href={`/faults?report=1&machine=${machine.id}`} className={menuItemClass()}>
                  {t("faults.report", locale)}
                </Link>
              ) : null}
              <Link href={`/machines/${machine.id}/qr`} className={menuItemClass()}>
                {t("machine.qrSticker", locale)}
              </Link>
              <a href={`/machines/${machine.id}/file.pdf`} className={menuItemClass()}>
                {t("machine.machineFile", locale)}
              </a>
            </ActionMenu>
          </div>
        </div>
      </section>

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t(savedMsg[sp.saved] ?? "ui.saved", locale) : undefined} />

      {/*
        Twenty cards on one scroll, all the same size, all always open, in schema order.
        Grouped, not removed, into the five things someone actually comes here for.
        Every section still runs the same query and the same server actions.
      */}
      <Tabs
        param="tab"
        defaultTab={initialTab}
        tabs={[
            {
              key: "overview",
              label: t("machine.tabOverview", locale),
              content: (
                <div className="flex flex-col gap-4">
              {/* A machine with no plan yet: the two jobs that make it useful, until done. */}
              {canEdit && planLines.length === 0 ? (
                <GetStarted
                  title={t("machine.setupTitle", locale)}
                  hint={t("machine.setupHint", locale)}
                  action={
                    <Link href={`/machines/${machine.id}?tab=servicing`} className={buttonVariants({ variant: "primary" })}>
                      {t("machine.setupPlanCta", locale)}
                    </Link>
                  }
                  secondaryAction={
                    <Link href={`/machines/${machine.id}/qr`} className={buttonVariants({ variant: "secondary" })}>
                      {t("machine.setupQrCta", locale)}
                    </Link>
                  }
                />
              ) : null}
              {/* Meter history */}
              {machine.meter_type !== "none" ? (
                <Card id="meter-reading" className="scroll-mt-24">
                  <CardHeader><CardTitle>{t("machine.meterHistory", locale)}</CardTitle></CardHeader>
                  <MeterGraph readings={readings} unit={machine.meter_type} title={t("machine.meterHistory", locale)} locale={locale} />
                  {canAddReading ? (
                    <OfflineForm action={addReading} type="log_reading" scope="app" locale={locale} className="mt-3 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="machine_id" value={machine.id} />
                      <input type="hidden" name="farm_id" value={machine.farm_id} />
                      <Field
                        label={`${t("machine.newReading", locale)} (${meterUnit(machine.meter_type, locale)})`}
                        htmlFor="reading"
                        className="w-full sm:w-64"
                        hint={machine.current_reading != null
                          ? t("machine.lastReadingHint", locale)
                            .replace("{reading}", readingText(machine.current_reading))
                            .replace("{date}", machine.current_reading_date ? shortDate(machine.current_reading_date, locale) : "-")
                          : undefined}
                      >
                        <Input id="reading" name="reading" type="number" inputMode="decimal" step="0.1" min={readingMin} required />
                      </Field>
                      <Field label={t("machine.date", locale)} htmlFor="reading_date">
                        <Input id="reading_date" name="reading_date" type="date" defaultValue={todayYmd} max={todayYmd} />
                      </Field>
                      {operators.length > 0 ? (
                        <Field label={t("machine.driver", locale)} htmlFor="driver_user_id">
                          <Select id="driver_user_id" name="driver_user_id" defaultValue={defaultDriver}>
                            <option value="">{t("machines.noOperator", locale)}</option>
                            {operators.map((op) => (
                              <option key={op.id} value={op.id}>{op.name}</option>
                            ))}
                          </Select>
                        </Field>
                      ) : null}
                      <SubmitButton variant="primary">
                        {t(machine.meter_type === "km" ? "machines.logKm" : "machines.logHours", locale)}
                      </SubmitButton>
                    </OfflineForm>
                  ) : null}
                  {readings.length > 0 ? (
                    <ul className="mt-3 flex flex-col divide-y divide-sand-100 text-sm">
                      {readings.slice(0, 8).map((r) => (
                        <li key={r.id} className="flex flex-wrap justify-between gap-x-3 py-1.5">
                          <span className="tabular-nums">{readingText(r.reading)}</span>
                          <span className="text-sand-500">{shortDate(r.reading_date, locale)} · {sourceLabel(r.source)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="mt-3 text-sm text-sand-400">{t("machine.noReadings", locale)}</p>}

                  {/* == When the number is wrong, or the meter itself changed =====
                      A reading only ever moves forward, so one mistyped figure used to
                      block every true reading after it for the life of the machine, and a
                      replaced hour meter, which is routine on an older tractor, did the
                      same. Both are the farm office's to fix, so this is owner/manager
                      only and stays shut until it is needed. */}
                  {/* Two separate fixes, so two separate dialogs. They were stacked in
                      one `<details>` divided by a hairline rule, which is how somebody
                      corrects a typo in the form meant for a physically new meter. */}
                  {canEdit ? (
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-sand-200 pt-3">
                      <span className="mr-auto text-sm font-medium text-sand-700">
                        {t("machine.meterFixTitle", locale)}
                      </span>

                      {readings.length > 0 ? (
                        <DialogForm
                          trigger={t("machine.correctReadingSubmit", locale)}
                          triggerVariant="secondary"
                          triggerSize="sm"
                          title={t("machine.correctReadingSubmit", locale)}
                          description={t("machine.correctReadingHint", locale)}
                          closeLabel={closeLabel}
                          size="md"
                        >
                          <form action={correctReading}>
                            <input type="hidden" name="machine_id" value={machine.id} />
                            <input type="hidden" name="farm_id" value={machine.farm_id} />
                            <DialogFields columns={1}>
                              <Field
                                label={t("machine.correctReadingLabel", locale)}
                                htmlFor="reading_id"
                                hint={t("machine.correctReadingHint", locale)}
                              >
                                <Select id="reading_id" name="reading_id" required defaultValue="">
                                  <option value="" disabled>
                                    {t("machine.correctReadingPick", locale)}
                                  </option>
                                  {readings.slice(0, 8).map((r) => (
                                    <option key={r.id} value={r.id}>
                                      {readingText(r.reading)} · {shortDate(r.reading_date, locale)} · {sourceLabel(r.source)}
                                    </option>
                                  ))}
                                </Select>
                              </Field>
                              <Field label={t("machine.correctReasonLabel", locale)} htmlFor="reason">
                                <Input id="reason" name="reason" maxLength={500} />
                              </Field>
                            </DialogFields>
                            <DialogActions cancelLabel={cancelLabel}>
                              <SubmitButton variant="primary">
                                {t("machine.correctReadingSubmit", locale)}
                              </SubmitButton>
                            </DialogActions>
                          </form>
                        </DialogForm>
                      ) : null}

                      <DialogForm
                        trigger={t("machine.meterReplacedSubmit", locale)}
                        triggerVariant="secondary"
                        triggerSize="sm"
                        title={t("machine.meterReplacedSubmit", locale)}
                        description={t("machine.meterReplacedHint", locale)}
                        closeLabel={closeLabel}
                        size="md"
                      >
                        <form action={replaceMeter}>
                          <input type="hidden" name="machine_id" value={machine.id} />
                          <input type="hidden" name="farm_id" value={machine.farm_id} />
                          <DialogFields>
                            <Field
                              label={t("machine.meterReplacedReading", locale)}
                              htmlFor="new_reading"
                              hint={t("machine.meterReplacedHint", locale)}
                            >
                              <Input id="new_reading" name="new_reading" type="number" inputMode="decimal" step="0.1" min={0} required />
                            </Field>
                            <Field label={t("machine.meterReplacedOn", locale)} htmlFor="replaced_on">
                              <Input id="replaced_on" name="replaced_on" type="date" defaultValue={todayYmd} max={todayYmd} />
                            </Field>
                            <div className="sm:col-span-2">
                              <Field label={t("machine.meterReplacedNote", locale)} htmlFor="note">
                                <Input id="note" name="note" maxLength={500} />
                              </Field>
                            </div>
                          </DialogFields>
                          <DialogActions cancelLabel={cancelLabel}>
                            <SubmitButton variant="primary">
                              {t("machine.meterReplacedSubmit", locale)}
                            </SubmitButton>
                          </DialogActions>
                        </form>
                      </DialogForm>
                    </div>
                  ) : null}
                </Card>
              ) : null}

              {/* Watch items */}
              {openWatch.length > 0 ? (
                <Card>
                  <CardHeader><CardTitle>{t("machine.watchItems", locale)}</CardTitle></CardHeader>
                  <ul className="flex flex-col gap-2 text-sm">
                    {openWatch.map((w) => (
                      <li key={w.id} className="flex items-start justify-between gap-2">
                        <span className="min-w-0 text-sand-800">{w.text}</span>
                        {canAddReading ? (
                          <span className="flex shrink-0 gap-1">
                            <form action={setWatchStatus}>
                              <input type="hidden" name="id" value={w.id} />
                              <input type="hidden" name="machine_id" value={machine.id} />
                              <input type="hidden" name="status" value="done" />
                              <SubmitButton variant="secondary" size="sm">
                                <CheckIcon />
                                {t("machine.done", locale)}
                              </SubmitButton>
                            </form>
                            <form action={setWatchStatus}>
                              <input type="hidden" name="id" value={w.id} />
                              <input type="hidden" name="machine_id" value={machine.id} />
                              <input type="hidden" name="status" value="dismissed" />
                              <SubmitButton variant="ghost" size="sm">
                                <CloseIcon />
                                {t("machine.dismiss", locale)}
                              </SubmitButton>
                            </form>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}

              {/* Fuel & consumption (F4), Professional+ (F5 entitlement gate) */}
              {fuelAllowed ? (
              <Card>
                <CardHeader
                  action={canFuel && fuelTanks.length > 0 ? (
                    <DialogForm
                      trigger={t("machine.logFuel", locale)}
                      triggerIcon={<PlusIcon />}
                      triggerVariant="secondary"
                      triggerSize="sm"
                      title={t("machine.logFuel", locale)}
                      description={machine.name}
                      closeLabel={closeLabel}
                    >
                      {/* Queueable: a diesel draw is captured at the bowser, which is where
                          the signal is worst. Offline, OfflineForm queues it and says so
                          inside this dialog. The form always names a machine, which is how
                          the replay finds the farm; the farm-level draw on /fuel stays online. */}
                      <OfflineForm action={addFuelIssue} type="log_fuel" scope="app" locale={locale}>
                        <input type="hidden" name="machine_id" value={machine.id} />
                        <input type="hidden" name="redirect_to" value={`/machines/${machine.id}`} />
                        <DialogFields>
                          <Field label={t("fuel.tank", locale)} htmlFor="f_tank">
                            <Select id="f_tank" name="tank_id" required defaultValue={fuelTanks[0]?.id ?? ""}>
                              {fuelTanks.map((tk) => (
                                <option key={tk.id} value={tk.id}>{tk.name}</option>
                              ))}
                            </Select>
                          </Field>
                          <Field label={t("fuel.litres", locale)} htmlFor="f_litres" required>
                            <Input id="f_litres" name="litres" type="number" inputMode="decimal" step="0.1" min={0} required />
                          </Field>
                          {machine.meter_type !== "none" ? (
                            <Field label={`${t("fuel.meter", locale)} (${meterUnit(machine.meter_type, locale)})`} htmlFor="f_meter">
                              <Input id="f_meter" name="meter_reading" type="number" inputMode="decimal" step="0.1" defaultValue={machine.current_reading ?? ""} />
                            </Field>
                          ) : null}
                          {costsVisible ? (
                            <Field label={t("fuel.cost", locale)} htmlFor="f_cost">
                              <Input id="f_cost" name="cost" inputMode="decimal" placeholder="R" />
                            </Field>
                          ) : null}
                          <Field label={t("fuel.activityLabel", locale)} htmlFor="f_activity">
                            <Select id="f_activity" name="activity" defaultValue="">
                              <option value="">-</option>
                              {FUEL_ACTIVITIES.map((a) => (
                                <option key={a} value={a}>{activityLabel(a, locale)}</option>
                              ))}
                            </Select>
                          </Field>
                          {operators.length > 0 ? (
                            <Field label={t("fuel.driver", locale)} htmlFor="f_driver">
                              <Select id="f_driver" name="driver_user_id" defaultValue={defaultDriver}>
                                <option value="">{t("machines.noOperator", locale)}</option>
                                {operators.map((op) => (
                                  <option key={op.id} value={op.id}>{op.name}</option>
                                ))}
                              </Select>
                            </Field>
                          ) : null}
                        </DialogFields>
                        <DialogActions cancelLabel={cancelLabel}>
                          <SubmitButton variant="primary">{t("machine.logFuel", locale)}</SubmitButton>
                        </DialogActions>
                      </OfflineForm>
                    </DialogForm>
                  ) : undefined}
                >
                  <CardTitle>{t("machine.fuelTitle", locale)}</CardTitle>
                </CardHeader>
                {fuelConsumption.display != null ? (
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className="text-xs text-sand-500">{t("machine.fuelConsumption", locale)}</p>
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="text-2xl font-bold tabular-nums text-sand-900">{formatConsumption(fuelConsumption, locale)}</span>
                        {/* The same rule as the sparkline's last bar, so the two never disagree. */}
                        {latestInterval(fuelConsumption.trend)?.high ? (
                          <StatusBadge tone="danger" shape="triangle" label={t("fuel.highLatest", locale)} />
                        ) : null}
                      </p>
                      {fuelConsumption.intervals > 0 ? (
                        <p className="text-xs text-sand-500">{t("machine.fuelIntervals", locale).replace("{n}", String(fuelConsumption.intervals))}</p>
                      ) : null}
                    </div>
                    {fuelConsumption.trend.length > 1 ? (
                      <div className="w-40">
                        <FuelTrend trend={fuelConsumption.trend} unit={machine.meter_type === "km" ? t("fuel.perKm", locale) : t("fuel.perHr", locale)} title={t("fuel.trend", locale)} locale={locale} />
                      </div>
                    ) : null}
                  </div>
                ) : (
                  // No bold "-" over the hint: until two metered draws exist there is no number.
                  <p className="text-sm text-sand-500">{t("fuel.needMoreData", locale)}</p>
                )}

                {fuelDraws.length > 0 ? (
                  <ul className="mt-3 flex flex-col divide-y divide-sand-100 text-sm">
                    {fuelDraws.slice(0, 8).map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-2 py-1.5">
                        <span className="min-w-0 truncate">
                          <span className="font-medium text-sand-800">{num(d.litres)} {t("fuel.litresShort", locale)}</span>
                          {d.activity ? <span className="text-sand-500"> · {activityLabel(d.activity, locale)}</span> : null}
                          {d.meter_reading != null ? <span className="text-sand-500"> · {readingText(d.meter_reading)}</span> : null}
                        </span>
                        <span className="flex shrink-0 items-center gap-2 text-xs text-sand-500">
                          {costsVisible && d.cost_cents != null ? <span className="tabular-nums">{rands(d.cost_cents)}</span> : null}
                          {d.anomaly_notified_at ? <Badge tone="danger">{t("fuel.flagged", locale)}</Badge> : null}
                          <span className="tabular-nums">{shortDate(d.date, locale)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-sand-500">{t("machine.noFuel", locale)}</p>
                )}
              </Card>
              ) : (
                <Card>
                  <CardHeader><CardTitle>{t("machine.fuelTitle", locale)}</CardTitle></CardHeader>
                  <UpgradeNotice feature="fuel" requiredPlan={requiredPlan("fuel")} currentPlan={plan} locale={locale} compact />
                </Card>
              )}

              {/* Utilisation & downtime (§23), trailing window. */}
              <Card>
                <CardHeader><CardTitle>{t("machine.utilisationTitle", locale)}</CardTitle></CardHeader>
                <p className="mb-2 text-xs text-sand-500">{t("machine.utilisationWindow", locale).replace("{n}", String(UTILISATION_WINDOW_DAYS))}</p>
                <StatGrid columns={4}>
                  <Stat
                    size="md"
                    label={t("machine.utilisation", locale)}
                    value={utilisation.pct != null ? `${utilisation.pct.toFixed(0)}%` : "-"}
                  />
                  <Stat
                    size="md"
                    label={`${machine.meter_type === "km" ? t("machine.kmUsed", locale) : t("machine.hoursUsed", locale)}`}
                    value={utilisation.used != null ? num(utilisation.used, isKm ? 0 : 1) : "-"}
                  />
                  <Stat
                    size="md"
                    label={`${t("machine.idle", locale)} (${isKm ? t("machine.kmShort", locale) : meterUnit("hours", locale)})`}
                    value={utilisation.idle != null ? num(utilisation.idle, isKm ? 0 : 1) : "-"}
                  />
                  <Stat
                    size="md"
                    label={t("machine.downtime", locale)}
                    value={`${num(downtimeDays)} ${t("machine.daysShort", locale)}`}
                    tone={downtimeDays > 0 ? "overdue" : "default"}
                  />
                </StatGrid>
                {utilisation.pct != null ? (
                  <div className="mt-3">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-sand-100">
                      <div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.min(100, Math.round(utilisation.pct))}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-sand-400">
                      {t("machine.utilisationBasis", locale)
                        .replace("{cap}", String(machine.meter_type === "km" ? kmPerDay : hoursPerDay))
                        .replace("{unit}", machine.meter_type === "km" ? t("machine.kmShort", locale) : t("machine.hrs", locale))}
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-sand-400">{t("machine.utilisationNoMeter", locale)}</p>
                )}
              </Card>

              {/* Photos */}
              <Card>
                <MachinePhotos farmId={machine.farm_id} machineId={machine.id} canEdit={canEdit} primaryAttachmentId={machine.primary_attachment_id} locale={locale} />
              </Card>

                </div>
              ),
            },
            {
              key: "servicing",
              label: t("machine.tabServicing", locale),
              content: (
                <div className="flex flex-col gap-4">
              {/* Service plan */}
              <Card>
                <CardHeader
                  action={canJob ? (
                    <form action={createJobCard} className="flex items-center gap-1">
                      <input type="hidden" name="machine_id" value={machine.id} />
                      <input type="hidden" name="farm_id" value={machine.farm_id} />
                      <input type="hidden" name="type" value="scheduled_service" />
                      <Button type="submit" variant="ghost" size="sm">{t("machine.newJobCard", locale)}</Button>
                    </form>
                  ) : undefined}
                >
                  <CardTitle>{t("machine.servicePlan", locale)}</CardTitle>
                </CardHeader>
                {planLines.length === 0 ? (
                  <p className="text-sm text-sand-500">{t("machine.noServiceLines", locale)}</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {planLines.map((l) => {
                      // Worked out, so nobody subtracts 3 500 from 4 000 under an Overdue pill.
                      const due = serviceDueText(l, machine.current_reading, machine.meter_type, locale);
                      return (
                        <li key={l.id} className="rounded-lg border border-sand-200 p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-medium text-sand-900">{l.task}</p>
                              <p className="text-xs text-sand-500">{intervalText(l)}</p>
                            </div>
                            <StatusPill status={l.status as "ok" | "due_soon" | "overdue"} label={statusPillLabel(l.status)} />
                          </div>
                          {due ? (
                            <p className={cn("mt-2 text-sm font-medium", dueTone[l.status] ?? "text-sand-800")}>{due}</p>
                          ) : null}
                          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sand-100">
                            <div className={`h-full rounded-full ${statusBar[l.status] ?? "bg-status-ok"}`} style={{ width: `${Math.round(lineProgress(l) * 100)}%` }} />
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                            <p className="min-w-0 text-xs text-sand-500">
                              {t("machine.lastDone", locale)}: {lastDoneText(l)}
                            </p>
                            {/*
                              Mark done, edit and delete, behind one labelled trigger on the
                              line's last row (it was a full-width button on a row of its own).
                              Mark done sends the task and intervals back unchanged, because
                              updateServiceLine rewrites them from the form.
                            */}
                            {canEdit ? (
                              <ActionMenu
                                title={l.task}
                                label={t("common.actions", locale)}
                                closeLabel={closeLabel}
                                trigger={t("common.actions", locale)}
                              >
                                <DialogForm
                                  triggerLook="menuItem"
                                  trigger={t("machine.markDone", locale)}
                                  title={t("machine.markDone", locale)}
                                  description={l.task}
                                  closeLabel={closeLabel}
                                  size="md"
                                >
                                  <form action={updateServiceLine}>
                                    <input type="hidden" name="id" value={l.id} />
                                    <input type="hidden" name="machine_id" value={machine.id} />
                                    <input type="hidden" name="task" value={l.task} />
                                    <input type="hidden" name="interval_hours" value={l.interval_hours ?? ""} />
                                    <input type="hidden" name="interval_months" value={l.interval_months ?? ""} />
                                    <DialogFields>
                                      {machine.meter_type !== "none" ? (
                                        <Field label={`${t("machine.doneAtReading", locale)} (${meterUnit(machine.meter_type, locale)})`} htmlFor={`sl-dr-${l.id}`}>
                                          <Input id={`sl-dr-${l.id}`} name="last_done_reading" type="number" inputMode="decimal" step="0.1" min={0} defaultValue={machine.current_reading ?? ""} />
                                        </Field>
                                      ) : null}
                                      <Field label={t("machine.lastDoneDate", locale)} htmlFor={`sl-dd-${l.id}`}>
                                        <Input id={`sl-dd-${l.id}`} name="last_done_date" type="date" defaultValue={todayYmd} max={todayYmd} />
                                      </Field>
                                    </DialogFields>
                                    <DialogActions cancelLabel={cancelLabel}>
                                      <SubmitButton variant="primary">{t("machine.markDone", locale)}</SubmitButton>
                                    </DialogActions>
                                  </form>
                                </DialogForm>

                                <DialogForm
                                  triggerLook="menuItem"
                                  trigger={t("machine.editServiceLine", locale)}
                                  title={t("machine.editServiceLine", locale)}
                                  description={l.task}
                                  closeLabel={closeLabel}
                                >
                                  <form action={updateServiceLine}>
                                    <input type="hidden" name="id" value={l.id} />
                                    <input type="hidden" name="machine_id" value={machine.id} />
                                    <DialogFields>
                                      <div className="sm:col-span-2">
                                        <Field label={t("machine.task", locale)} htmlFor={`sl-task-${l.id}`} required>
                                          <Input id={`sl-task-${l.id}`} name="task" defaultValue={l.task} required />
                                        </Field>
                                      </div>
                                      <Field label={intervalLabel} htmlFor={`sl-ih-${l.id}`}>
                                        <Input id={`sl-ih-${l.id}`} name="interval_hours" type="number" step="0.1" min={0} defaultValue={l.interval_hours ?? ""} />
                                      </Field>
                                      <Field label={t("machine.intervalMonths", locale)} htmlFor={`sl-im-${l.id}`}>
                                        <Input id={`sl-im-${l.id}`} name="interval_months" type="number" min={0} defaultValue={l.interval_months ?? ""} />
                                      </Field>
                                      <Field label={t("machine.lastDone", locale)} htmlFor={`sl-lr-${l.id}`}>
                                        <Input id={`sl-lr-${l.id}`} name="last_done_reading" type="number" step="0.1" min={0} defaultValue={l.last_done_reading ?? ""} />
                                      </Field>
                                      <Field label={t("machine.lastDoneDate", locale)} htmlFor={`sl-ld-${l.id}`}>
                                        <Input id={`sl-ld-${l.id}`} name="last_done_date" type="date" defaultValue={l.last_done_date ?? ""} />
                                      </Field>
                                    </DialogFields>
                                    <DialogActions cancelLabel={cancelLabel}>
                                      <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                                    </DialogActions>
                                  </form>
                                </DialogForm>

                                <ConfirmDialog
                                  action={deleteServiceLine}
                                  triggerLook="menuItem"
                                  triggerIcon={<TrashIcon />}
                                  triggerLabel={t("machine.delete", locale)}
                                  title={t("confirm.deleteServiceLineTitle", locale).replace("{task}", l.task)}
                                  intro={t("confirm.deleteServiceLineIntro", locale).replace("{machine}", machine.name)}
                                  consequencesTitle={t("confirm.whatHappens", locale)}
                                  consequences={[
                                    t("confirm.deleteServiceLineEffect1", locale),
                                    t("confirm.deleteServiceLineEffect2", locale),
                                  ]}
                                  footnote={t("confirm.softDeleteNote", locale)}
                                  confirmLabel={t("confirm.deleteServiceLineYes", locale)}
                                  cancelLabel={t("confirm.keepIt", locale)}
                                  closeLabel={closeLabel}
                                >
                                  <input type="hidden" name="id" value={l.id} />
                                  <input type="hidden" name="machine_id" value={machine.id} />
                                </ConfirmDialog>
                              </ActionMenu>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {canEdit ? (
                  // An empty plan leads with the plan for this machine type.
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-sand-100 pt-3">
                    {planLines.length === 0 ? applyTemplateDialog : addLineDialog}
                    {planLines.length === 0 ? addLineDialog : applyTemplateDialog}
                  </div>
                ) : null}
              </Card>

              {/* Service kit, parts BOM (F9): the exact oils/filters/part numbers a service needs */}
              <Card>
                <CardHeader><CardTitle>{t("machine.serviceKit", locale)}</CardTitle></CardHeader>
                <p className="mb-2 text-xs text-sand-500">{t("machine.serviceKitHint", locale)}</p>
                {kits.length === 0 ? (
                  <p className="text-sm text-sand-500">{t("machine.noServiceKit", locale)}</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {kits.map((kit) => (
                      <li key={kit.id} className="rounded-lg border border-sand-200 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-medium text-sand-900">{kit.name}</p>
                            {kit.notes ? <p className="text-xs text-sand-500">{kit.notes}</p> : null}
                          </div>
                          {/* One menu per kit and per part, like every other row on the page
                              (they were loose red trash buttons and an Edit on a second line). */}
                          {canKit ? (
                            <ActionMenu
                              title={kit.name}
                              label={t("common.actions", locale)}
                              closeLabel={closeLabel}
                              trigger={t("common.actions", locale)}
                            >
                              <DialogForm
                                triggerLook="menuItem"
                                trigger={t("machine.addKitItem", locale)}
                                title={t("machine.addKitItem", locale)}
                                description={kit.name}
                                closeLabel={closeLabel}
                              >
                                <form action={addKitItem}>
                                  <input type="hidden" name="machine_id" value={machine.id} />
                                  <input type="hidden" name="farm_id" value={machine.farm_id} />
                                  <input type="hidden" name="service_kit_id" value={kit.id} />
                                  <DialogFields>
                                    {catalogue.length > 0 ? (
                                      <div className="sm:col-span-2">
                                        <Field label={t("machine.kitFromCatalogue", locale)} htmlFor={`ka-cat-${kit.id}`}>
                                          <Select id={`ka-cat-${kit.id}`} name="part_catalogue_id" defaultValue="">
                                            <option value="">{t("machine.kitFromCatalogue", locale)}</option>
                                            {catalogue.map((c) => (
                                              <option key={c.id} value={c.id}>{c.part_no}{c.description ? `, ${c.description}` : ""}</option>
                                            ))}
                                          </Select>
                                        </Field>
                                      </div>
                                    ) : null}
                                    <Field label={t("machine.kitPartNo", locale)} htmlFor={`ka-no-${kit.id}`}>
                                      <Input id={`ka-no-${kit.id}`} name="part_no" />
                                    </Field>
                                    <Field label={t("machine.kitQty", locale)} htmlFor={`ka-qty-${kit.id}`}>
                                      <Input id={`ka-qty-${kit.id}`} name="qty" type="number" step="0.01" min={0} defaultValue="1" />
                                    </Field>
                                    <div className="sm:col-span-2">
                                      <Field label={t("machine.kitPartDesc", locale)} htmlFor={`ka-desc-${kit.id}`}>
                                        <Input id={`ka-desc-${kit.id}`} name="description" />
                                      </Field>
                                    </div>
                                    <Field label={t("machine.kitUnitCost", locale)} htmlFor={`ka-cost-${kit.id}`}>
                                      <Input id={`ka-cost-${kit.id}`} name="unit_cost" inputMode="decimal" placeholder="R" />
                                    </Field>
                                  </DialogFields>
                                  <DialogActions cancelLabel={cancelLabel}>
                                    <SubmitButton variant="primary">{t("common.add", locale)}</SubmitButton>
                                  </DialogActions>
                                </form>
                              </DialogForm>
                              <ConfirmDialog
                                action={deleteServiceKit}
                                triggerLook="menuItem"
                                triggerIcon={<TrashIcon />}
                                triggerLabel={t("machine.deleteKit", locale)}
                                title={t("confirm.deleteKitTitle", locale).replace("{kit}", kit.name)}
                                intro={t("confirm.deleteKitIntro", locale).replace("{machine}", machine.name)}
                                consequencesTitle={t("confirm.whatHappens", locale)}
                                consequences={[
                                  t("confirm.deleteKitEffect1", locale).replace("{n}", String(kit.items.length)),
                                  t("confirm.deleteKitEffect2", locale),
                                ]}
                                footnote={t("confirm.softDeleteNote", locale)}
                                confirmLabel={t("confirm.deleteKitYes", locale)}
                                cancelLabel={t("confirm.keepIt", locale)}
                                closeLabel={closeLabel}
                              >
                                <input type="hidden" name="id" value={kit.id} />
                                <input type="hidden" name="machine_id" value={machine.id} />
                              </ConfirmDialog>
                            </ActionMenu>
                          ) : null}
                        </div>
                        {kit.items.length === 0 ? (
                          <p className="mt-2 text-xs text-sand-500">{t("machine.noKitItems", locale)}</p>
                        ) : (
                          <ul className="mt-2 flex flex-col divide-y divide-sand-100 text-sm">
                            {kit.items.map((item) => {
                              const partName = item.part_no ?? item.description ?? "-";
                              return (
                                <li key={item.id} className="flex items-center justify-between gap-2 py-1.5">
                                  <span className="min-w-0 truncate">
                                    <span className="font-medium text-sand-800">{partName}</span>
                                    {item.part_no && item.description ? <span className="text-sand-500"> · {item.description}</span> : null}
                                    <span className="text-sand-500"> · {t("machine.qtyShort", locale)} {num(item.qty ?? 1, 2)}</span>
                                  </span>
                                  <span className="flex shrink-0 items-center gap-2">
                                    {costsVisible ? (
                                      <span className="tabular-nums text-sand-500">{item.unit_cost_cents != null ? rands(item.unit_cost_cents) : "-"}</span>
                                    ) : null}
                                    {canKit ? (
                                      <ActionMenu
                                        title={partName}
                                        label={t("common.actions", locale)}
                                        closeLabel={closeLabel}
                                        trigger={t("common.edit", locale)}
                                      >
                                        <DialogForm
                                          triggerLook="menuItem"
                                          trigger={t("common.edit", locale)}
                                          title={t("common.edit", locale)}
                                          description={partName}
                                          closeLabel={closeLabel}
                                          size="md"
                                        >
                                          <form action={updateKitItem}>
                                            <input type="hidden" name="id" value={item.id} />
                                            <input type="hidden" name="machine_id" value={machine.id} />
                                            <DialogFields>
                                              <Field label={t("machine.kitPartNo", locale)} htmlFor={`ki-no-${item.id}`}>
                                                <Input id={`ki-no-${item.id}`} name="part_no" defaultValue={item.part_no ?? ""} />
                                              </Field>
                                              <Field label={t("machine.kitQty", locale)} htmlFor={`ki-qty-${item.id}`}>
                                                <Input id={`ki-qty-${item.id}`} name="qty" type="number" step="0.01" min={0} defaultValue={item.qty ?? 1} />
                                              </Field>
                                              <div className="sm:col-span-2">
                                                <Field label={t("machine.kitPartDesc", locale)} htmlFor={`ki-desc-${item.id}`}>
                                                  <Input id={`ki-desc-${item.id}`} name="description" defaultValue={item.description ?? ""} />
                                                </Field>
                                              </div>
                                              <Field label={t("machine.kitUnitCost", locale)} htmlFor={`ki-cost-${item.id}`}>
                                                <Input id={`ki-cost-${item.id}`} name="unit_cost" inputMode="decimal" defaultValue={item.unit_cost_cents != null ? (item.unit_cost_cents / 100).toFixed(2) : ""} />
                                              </Field>
                                            </DialogFields>
                                            <DialogActions cancelLabel={cancelLabel}>
                                              <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                                            </DialogActions>
                                          </form>
                                        </DialogForm>
                                        <ConfirmDialog
                                          action={deleteKitItem}
                                          triggerLook="menuItem"
                                          triggerIcon={<TrashIcon />}
                                          triggerLabel={t("machine.removeItem", locale)}
                                          title={t("confirm.deleteKitItemTitle", locale).replace("{part}", partName)}
                                          intro={t("confirm.deleteKitItemIntro", locale).replace("{kit}", kit.name)}
                                          confirmLabel={t("confirm.deleteKitItemYes", locale)}
                                          cancelLabel={t("confirm.keepIt", locale)}
                                          closeLabel={closeLabel}
                                        >
                                          <input type="hidden" name="id" value={item.id} />
                                          <input type="hidden" name="machine_id" value={machine.id} />
                                        </ConfirmDialog>
                                      </ActionMenu>
                                    ) : null}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {canKit ? (
                  <div className="mt-3 flex border-t border-sand-100 pt-3">
                    <DialogForm
                      trigger={t("machine.addServiceKit", locale)}
                      triggerIcon={<PlusIcon />}
                      triggerVariant="secondary"
                      triggerSize="sm"
                      title={t("machine.addServiceKit", locale)}
                      closeLabel={closeLabel}
                      size="md"
                    >
                      <form action={createServiceKit}>
                        <input type="hidden" name="machine_id" value={machine.id} />
                        <input type="hidden" name="farm_id" value={machine.farm_id} />
                        <DialogFields columns={1}>
                          <Field label={t("machine.kitName", locale)} htmlFor="kit-name" required>
                            <Input id="kit-name" name="name" required />
                          </Field>
                          <Field label={t("machines.notes", locale)} htmlFor="kit-notes">
                            <Input id="kit-notes" name="notes" />
                          </Field>
                        </DialogFields>
                        <DialogActions cancelLabel={cancelLabel}>
                          <SubmitButton variant="primary">{t("common.add", locale)}</SubmitButton>
                        </DialogActions>
                      </form>
                    </DialogForm>
                  </div>
                ) : null}
              </Card>

                </div>
              ),
            },
            ...(costsVisible ? [{
              key: "costs",
              label: t("machine.tabCosts", locale),
              content: (
                <div className="flex flex-col gap-4">
              {/* Lifetime stats */}
              <Card>
                <CardHeader><CardTitle>{t("machine.lifetimeStats", locale)}</CardTitle></CardHeader>
                {/* Three money tiles, one per row on a phone: `rands` is one unbreakable
                    token, so "R1 500 000,00" in a two-column tile at 360px forced the page
                    wider. The two counts that sat here (job cards, open faults) are not
                    costs: job cards are on History, open faults are in the header. */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Stat size="md" label={t("machine.tco", locale)} value={rands(tco)} valueClassName="text-xl" />
                  <Stat size="md" label={perMeterLabel} value={perMeter != null ? rands(perMeter) : "-"} valueClassName="text-xl" />
                  <Stat size="md" label={t("machine.maintenanceSpend", locale)} value={rands(totalSpend)} valueClassName="text-xl" />
                </div>
                {tco > 0 ? (
                  <ul className="mt-3 flex flex-col divide-y divide-sand-100 border-t border-sand-100 pt-3 text-sm">
                    {COST_TYPES.filter((ct) => breakdown[ct] > 0).map((ct) => (
                      <li key={ct} className="flex justify-between py-1">
                        <span className="text-sand-600">{t(`costType.${ct}`, locale)}</span>
                        <span className="font-medium tabular-nums text-sand-900">{rands(breakdown[ct])}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {/* Repair-vs-replace indicator (FR-10.5): lifetime repair spend ÷ purchase price. */}
                {repair.ratioPct != null ? (
                  <div className="mt-3 border-t border-sand-100 pt-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-sand-600">{t("machine.repairRatio", locale)}</span>
                      <span className={`text-sm font-semibold tabular-nums ${repair.flagged ? "text-status-overdue" : "text-sand-900"}`}>
                        {repair.ratioPct.toFixed(0)}%
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-sand-400">{t("machine.repairRatioHint", locale).replace("{pct}", String(repair.thresholdPct))}</p>
                    {repair.flagged ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-callout-danger-bg p-2.5">
                        <Badge tone="danger">{t("machine.considerReplacing", locale)}</Badge>
                        <span className="text-xs text-sand-600">{t("machine.considerReplacingHint", locale)}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </Card>

              {/* Finance */}
              {hasFinance ? (
                <Card>
                  <CardHeader><CardTitle>{t("machine.finance", locale)}</CardTitle></CardHeader>
                  <FactList>
                    {machine.finance_provider ? (
                      <Fact label={t("machines.financeProvider", locale)} value={machine.finance_provider} />
                    ) : null}
                    {machine.finance_total_cents != null ? (
                      <Fact label={t("machines.financeTotal", locale)} value={rands(machine.finance_total_cents)} />
                    ) : null}
                    {machine.finance_monthly_cents != null ? (
                      <Fact label={t("machines.financeMonthly", locale)} value={rands(machine.finance_monthly_cents)} />
                    ) : null}
                    {machine.finance_term_months != null ? (
                      <Fact label={t("machines.financeTerm", locale)} value={num(machine.finance_term_months)} />
                    ) : null}
                    {machine.finance_interest_bps != null ? (
                      <Fact label={t("machines.financeInterest", locale)} value={`${num(machine.finance_interest_bps / 100, 2)}%`} />
                    ) : null}
                  </FactList>
                </Card>
              ) : null}

              {/* Budgets & budget-vs-actual (FR-10.4) */}
              <Card>
                <CardHeader><CardTitle>{t("budget.title", locale)}</CardTitle></CardHeader>
                <p className="mb-2 text-xs text-sand-500">{t("budget.hint", locale)}</p>
                {budgetRows.length === 0 ? (
                  <p className="text-sm text-sand-500">{t("budget.none", locale)}</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {budgetRows.map((bp) => (
                      <li key={bp.budget.id} className="rounded-lg border border-sand-200 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-medium text-sand-900">
                              {budgetCategoryLabel(bp.budget.category, locale)}
                              <span className="text-sand-500"> · {budgetPeriodLabel(bp.budget.period_type, locale)}</span>
                            </p>
                            <p className="text-xs tabular-nums text-sand-500">
                              {t("machine.periodRange", locale)
                                .replace("{start}", shortDate(bp.budget.period_start, locale))
                                .replace("{end}", shortDate(bp.budget.period_end, locale))}
                            </p>
                            {bp.budget.note ? <p className="mt-0.5 text-xs text-sand-500">{bp.budget.note}</p> : null}
                          </div>
                          <Badge tone={budgetTone(bp.status)}>{bp.status === "over" ? t("budget.over", locale) : t("budget.under", locale)}</Badge>
                        </div>
                        <div className="mt-2 flex items-center justify-between text-sm">
                          <span className="text-sand-600">{t("budget.actual", locale)}: <span className="font-medium tabular-nums text-sand-900">{rands(bp.actual)}</span></span>
                          <span className="text-sand-600">{t("budget.budget", locale)}: <span className="font-medium tabular-nums text-sand-900">{rands(bp.budget.amount_cents)}</span></span>
                        </div>
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-sand-100">
                          <div className={`h-full rounded-full ${bp.status === "over" ? "bg-status-overdue" : bp.status === "warning" ? "bg-status-due" : "bg-status-ok"}`} style={{ width: `${bp.pct != null ? Math.min(100, Math.round(bp.pct)) : 0}%` }} />
                        </div>
                        <p className="mt-1 text-xs tabular-nums text-sand-500">
                          {bp.variance > 0
                            ? t("budget.overBy", locale).replace("{amt}", rands(bp.variance))
                            : t("budget.remaining", locale).replace("{amt}", rands(bp.remaining))}
                          {bp.pct != null ? ` · ${bp.pct.toFixed(0)}%` : ""}
                        </p>
                        {canBudget ? (
                          <div className="mt-2 flex">
                            <ActionMenu
                              title={bp.budget.category ? t(`costType.${bp.budget.category}`, locale) : t("budget.allCategories", locale)}
                              label={t("common.actions", locale)}
                              closeLabel={closeLabel}
                              trigger={t("common.edit", locale)}
                            >
                              <DialogForm
                                triggerLook="menuItem"
                                trigger={t("common.edit", locale)}
                                title={t("common.edit", locale)}
                                description={rands(bp.budget.amount_cents)}
                                closeLabel={closeLabel}
                              >
                                <form action={updateBudget}>
                                  <input type="hidden" name="id" value={bp.budget.id} />
                                  <input type="hidden" name="machine_id" value={machine.id} />
                                  <DialogFields>
                                    <Field label={t("budget.category", locale)} htmlFor={`bu-cat-${bp.budget.id}`}>
                                      <Select id={`bu-cat-${bp.budget.id}`} name="category" defaultValue={bp.budget.category ?? ""}>
                                        <option value="">{t("budget.allCategories", locale)}</option>
                                        {COST_TYPES.map((ct) => <option key={ct} value={ct}>{t(`costType.${ct}`, locale)}</option>)}
                                      </Select>
                                    </Field>
                                    <Field label={t("budget.period", locale)} htmlFor={`bu-per-${bp.budget.id}`}>
                                      <Select id={`bu-per-${bp.budget.id}`} name="period_type" defaultValue={bp.budget.period_type}>
                                        {BUDGET_PERIODS.map((p) => <option key={p} value={p}>{budgetPeriodLabel(p, locale)}</option>)}
                                      </Select>
                                    </Field>
                                    <Field label={t("budget.anchor", locale)} htmlFor={`bu-anc-${bp.budget.id}`}>
                                      <Input id={`bu-anc-${bp.budget.id}`} name="anchor" type="date" defaultValue={bp.budget.period_start} />
                                    </Field>
                                    <Field label={t("budget.amount", locale)} htmlFor={`bu-amt-${bp.budget.id}`}>
                                      <Input id={`bu-amt-${bp.budget.id}`} name="amount" inputMode="decimal" defaultValue={(bp.budget.amount_cents / 100).toFixed(2)} />
                                    </Field>
                                    <div className="sm:col-span-2">
                                      <Field label={t("machines.notes", locale)} htmlFor={`bu-note-${bp.budget.id}`}>
                                        <Input id={`bu-note-${bp.budget.id}`} name="note" defaultValue={bp.budget.note ?? ""} />
                                      </Field>
                                    </div>
                                  </DialogFields>
                                  <DialogActions cancelLabel={cancelLabel}>
                                    <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                                  </DialogActions>
                                </form>
                              </DialogForm>

                              <ConfirmDialog
                                action={deleteBudget}
                                triggerLook="menuItem"
                                triggerIcon={<TrashIcon />}
                                triggerLabel={t("common.delete", locale)}
                                title={t("confirm.deleteBudgetTitle", locale)}
                                intro={t("confirm.deleteBudgetIntro", locale).replace("{machine}", machine.name)}
                                facts={[
                                  {
                                    label: t("budget.amount", locale),
                                    value: rands(bp.budget.amount_cents),
                                  },
                                ]}
                                consequencesTitle={t("confirm.whatHappens", locale)}
                                consequences={[
                                  t("confirm.deleteBudgetEffect1", locale),
                                  t("confirm.deleteBudgetEffect2", locale),
                                ]}
                                footnote={t("confirm.softDeleteNote", locale)}
                                confirmLabel={t("confirm.deleteBudgetYes", locale)}
                                cancelLabel={t("confirm.keepIt", locale)}
                                closeLabel={closeLabel}
                              >
                                <input type="hidden" name="id" value={bp.budget.id} />
                                <input type="hidden" name="machine_id" value={machine.id} />
                              </ConfirmDialog>
                            </ActionMenu>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                {canBudget ? (
                  <div className="mt-3 flex border-t border-sand-100 pt-3">
                    <DialogForm
                      trigger={t("budget.add", locale)}
                      triggerIcon={<PlusIcon />}
                      triggerVariant="secondary"
                      triggerSize="sm"
                      title={t("budget.add", locale)}
                      closeLabel={closeLabel}
                    >
                      <form action={addBudget}>
                        <input type="hidden" name="machine_id" value={machine.id} />
                        <input type="hidden" name="farm_id" value={machine.farm_id} />
                        <DialogFields>
                          <Field label={t("budget.category", locale)} htmlFor="b_category">
                            <Select id="b_category" name="category" defaultValue="">
                              <option value="">{t("budget.allCategories", locale)}</option>
                              {COST_TYPES.map((ct) => <option key={ct} value={ct}>{t(`costType.${ct}`, locale)}</option>)}
                            </Select>
                          </Field>
                          <Field label={t("budget.period", locale)} htmlFor="b_period">
                            <Select id="b_period" name="period_type" defaultValue="month">
                              {BUDGET_PERIODS.map((p) => <option key={p} value={p}>{budgetPeriodLabel(p, locale)}</option>)}
                            </Select>
                          </Field>
                          <Field label={t("budget.anchor", locale)} htmlFor="b_anchor">
                            <Input id="b_anchor" name="anchor" type="date" defaultValue={todayYmd} />
                          </Field>
                          <Field label={t("budget.amount", locale)} htmlFor="b_amount">
                            <Input id="b_amount" name="amount" inputMode="decimal" placeholder="R" />
                          </Field>
                        </DialogFields>
                        <DialogActions cancelLabel={cancelLabel}>
                          <SubmitButton variant="primary">{t("common.add", locale)}</SubmitButton>
                        </DialogActions>
                      </form>
                    </DialogForm>
                  </div>
                ) : null}
              </Card>

                </div>
              ),
            }] : []),
            {
              key: "history",
              label: t("machine.tabHistory", locale),
              content: (
                <div className="flex flex-col gap-4">
              {/* Timeline */}
              <Card>
                <CardHeader><CardTitle>{t("machine.timeline", locale)}</CardTitle></CardHeader>
                {timeline.length === 0 ? (
                  <EmptyState title={t("machine.noTimeline", locale)} />
                ) : (
                  <>
                    <ol className="flex flex-col">{timelineRecent.map(renderEvent)}</ol>
                    {timelineOlder.length > 0 ? (
                      <Disclosure
                        variant="inline"
                        summary={t("machine.timelineOlder", locale).replace("{n}", String(timelineOlder.length))}
                        className="mt-2"
                      >
                        <ol className="flex flex-col">{timelineOlder.map((e, i) => renderEvent(e, i + TIMELINE_ROWS))}</ol>
                      </Disclosure>
                    ) : null}
                  </>
                )}
              </Card>

              {/* Job cards */}
              <Card>
                <CardHeader
                  action={canJob ? (
                    <form action={createJobCard} className="flex items-center gap-1">
                      <input type="hidden" name="machine_id" value={machine.id} />
                      <input type="hidden" name="farm_id" value={machine.farm_id} />
                      <input type="hidden" name="type" value="repair" />
                      <Button type="submit" variant="ghost" size="sm"><PlusIcon className="text-base" />{t("machine.newJobCard", locale)}</Button>
                    </form>
                  ) : undefined}
                >
                  <CardTitle>{t("machine.jobCards", locale)}</CardTitle>
                </CardHeader>
                {jobCards.length === 0 ? (
                  <p className="text-sm text-sand-500">{t("machine.none", locale)}</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-sand-100 text-sm">
                    {jobCards.slice(0, 6).map((j) => (
                      <li key={j.id}>
                        <Link href={`/jobcards/${j.id}`} className="focus-ring flex min-h-12 items-center justify-between gap-2 rounded-md py-1.5 sm:min-h-0">
                          <span className="min-w-0 truncate">
                            <span className="font-medium text-sand-800">{t(`jobType.${j.type}`, locale)}</span>
                            <span className="text-sand-500"> · {t(`jobStatus.${j.status}`, locale)}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2 text-xs text-sand-500">
                            {costsVisible ? <span className="tabular-nums">{rands(j.total_cents)}</span> : null}
                            <span className="tabular-nums">{shortDate(j.date_out ?? j.created_at, locale)}</span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {/* Vehicle checklists (F11), pre-use inspections, service sign-offs, condition reports */}
              <Card>
                <CardHeader
                  action={canFill ? (
                    <Link href={`/machines/${machine.id}/checklists/new`} className="focus-ring inline-flex items-center gap-1 rounded-md text-sm font-medium text-brand-ink">
                      <PlusIcon className="text-base" />{t("checklists.newChecklist", locale)}
                    </Link>
                  ) : undefined}
                >
                  <CardTitle>{t("machine.checklists", locale)}</CardTitle>
                </CardHeader>
                {checklists.length === 0 ? (
                  <p className="text-sm text-sand-500">{t("machine.noChecklists", locale)}</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-sand-100 text-sm">
                    {checklists.slice(0, 6).map((c) => (
                      <li key={c.id}>
                        <Link href={`/machines/${machine.id}/checklists/${c.id}`} className="focus-ring flex items-center justify-between gap-2 rounded-md py-1.5">
                          <span className="min-w-0 truncate text-sand-800">{c.template_name}</span>
                          <span className="flex shrink-0 items-center gap-2 text-xs text-sand-400">
                            <Badge tone={c.status === "completed" ? "ok" : "warning"}>{checklistStatusLabel(c.status)}</Badge>
                            <span className="tabular-nums">{relativeDate(c.completed_at ?? c.created_at, locale)}</span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {/* Get something done, contractor work requests (F12b) */}
              <Card>
                <CardHeader><CardTitle>{t("work.getSomethingDone", locale)}</CardTitle></CardHeader>
                {workRequests.length > 0 ? (
                  <ul className="mb-3 flex flex-col divide-y divide-sand-100 text-sm">
                    {workRequests.slice(0, 6).map((w) => (
                      <li key={w.id}>
                        <Link href={`/work/${w.id}`} className="focus-ring flex items-center justify-between gap-2 rounded-md py-1.5">
                          <span className="min-w-0 truncate">
                            <span className="font-medium text-sand-800">{w.title || workKindLabel(w.kind, locale)}</span>
                            {w.workshop_id ? <span className="text-sand-400"> · {workshopNameById.get(w.workshop_id) ?? ""}</span> : null}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {costsVisible && (w.invoice_amount_cents ?? w.quote_amount_cents) != null ? (
                              <span className="tabular-nums text-sand-500">{rands(w.invoice_amount_cents ?? w.quote_amount_cents)}</span>
                            ) : null}
                            <WorkStatus value={w.status} locale={locale} />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mb-2 text-sm text-sand-500">{t("work.machineNone", locale)}</p>
                )}
                {canWorkReq ? (
                  linkedWorkshops.length > 0 ? (
                    <div className="flex border-t border-sand-100 pt-3">
                      <DialogForm
                        trigger={t("work.getSomethingDone", locale)}
                        triggerIcon={<PlusIcon />}
                        triggerVariant="secondary"
                        triggerSize="sm"
                        title={t("work.getSomethingDone", locale)}
                        description={machine.name}
                        closeLabel={closeLabel}
                      >
                        <form action={createWorkRequest}>
                          <input type="hidden" name="machine_id" value={machine.id} />
                          <input type="hidden" name="farm_id" value={machine.farm_id} />
                          <DialogFields>
                            <div className="sm:col-span-2">
                              <Field label={t("work.contractor", locale)} htmlFor="wr_workshop">
                                <Select id="wr_workshop" name="workshop_id" defaultValue={linkedWorkshops[0]?.id ?? ""}>
                                  {linkedWorkshops.map((w) => (
                                    <option key={w.id} value={w.id}>{w.name}</option>
                                  ))}
                                </Select>
                              </Field>
                            </div>
                            <Field label={t("work.kind", locale)} htmlFor="wr_kind">
                              <Select id="wr_kind" name="kind" defaultValue="repair">
                                {WORK_KINDS.map((k) => (
                                  <option key={k} value={k}>{workKindLabel(k, locale)}</option>
                                ))}
                              </Select>
                            </Field>
                            <Field label={t("work.priority", locale)} htmlFor="wr_priority">
                              <Select id="wr_priority" name="priority" defaultValue="normal">
                                {WORK_PRIORITIES.map((p) => (
                                  <option key={p} value={p}>{workPriorityLabel(p, locale)}</option>
                                ))}
                              </Select>
                            </Field>
                            <div className="sm:col-span-2">
                              <Field label={t("work.titleField", locale)} htmlFor="wr_title">
                                <Input id="wr_title" name="title" placeholder={t("work.titlePlaceholder", locale)} />
                              </Field>
                            </div>
                            <div className="sm:col-span-2">
                              <Field label={t("work.description", locale)} htmlFor="wr_desc">
                                <Input id="wr_desc" name="description" placeholder={t("work.descPlaceholder", locale)} />
                              </Field>
                            </div>
                          </DialogFields>
                          <DialogActions cancelLabel={cancelLabel}>
                            <SubmitButton variant="primary">{t("work.send", locale)}</SubmitButton>
                          </DialogActions>
                        </form>
                      </DialogForm>
                    </div>
                  ) : (
                    <p className="border-t border-sand-100 pt-3 text-sm text-sand-500">
                      {t("work.noContractors", locale)}{" "}
                      <Link href="/partners" className="focus-ring rounded text-brand-ink">{t("nav.partners", locale)} →</Link>
                    </p>
                  )
                ) : null}
              </Card>

              {/* Who operated / when, AARTO driver-usage log (FR-13.1), Complete+ (F5 gate) */}
              {aartoAllowed ? (
              <Card>
                <CardHeader><CardTitle>{t("machine.whoOperated", locale)}</CardTitle></CardHeader>

                {/* Driver-on-date lookup (the AARTO nomination question). A GET form, so it
                    sits in a dialog rather than on the page at rest; it reloads onto this tab
                    (tab=history) and the answer is stated below as a fact. */}
                <div className="mb-3 flex">
                  <DialogForm
                    trigger={t("machine.whoWasDriving", locale)}
                    triggerVariant="secondary"
                    triggerSize="sm"
                    title={t("machine.whoWasDriving", locale)}
                    description={machine.name}
                    closeLabel={closeLabel}
                    size="md"
                  >
                    <form method="get">
                      <input type="hidden" name="tab" value="history" />
                      <DialogFields columns={1}>
                        <Field label={t("machine.driverOnDate", locale)} htmlFor="usageDate">
                          <Input id="usageDate" name="usageDate" type="date" defaultValue={usageDate ?? todayYmd} max={todayYmd} required />
                        </Field>
                      </DialogFields>
                      <DialogActions cancelLabel={cancelLabel}>
                        <Button type="submit" variant="primary">{t("machine.check", locale)}</Button>
                      </DialogActions>
                    </form>
                  </DialogForm>
                </div>
                {usageDate ? (
                  <FactList className="mb-3 rounded-lg bg-sand-50 px-3">
                    <Fact
                      label={t("machine.operatedOn", locale).replace("{date}", shortDate(usageDate, locale))}
                      value={usageOnDate.length > 0 ? usageOnDate.map(driverLabel).join(", ") : t("machine.noDriverOn", locale)}
                      muted={usageOnDate.length === 0}
                    />
                  </FactList>
                ) : null}

                {usage.length === 0 ? (
                  <p className="text-sm text-sand-500">{t("machine.noUsage", locale)}</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-sand-100 text-sm">
                    {usage.slice(0, 12).map((u) => (
                      <li key={u.id} className="flex items-center justify-between gap-3 py-1.5">
                        <span className="min-w-0 truncate font-medium text-sand-800">{driverLabel(u)}</span>
                        <span className="flex shrink-0 items-center gap-2 text-xs text-sand-500">
                          {u.meter_reading != null ? <span className="tabular-nums">{readingText(u.meter_reading)}</span> : null}
                          <span>{sourceLabel(u.source)}</span>
                          <span className="tabular-nums">{shortDate(u.occurred_on, locale)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {/* AARTO fines on this vehicle (FR-13.2), capture lives on the fines workflow,
                    pre-selecting this vehicle. */}
                <div className="mt-4 border-t border-sand-100 pt-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-sand-400">{t("machine.finesTitle", locale)}</p>
                    {canEdit ? (
                      <Link href={`/fines?sm=${machine.id}`} className="focus-ring rounded text-xs font-medium text-brand-ink">
                        {t("machine.recordFine", locale)} →
                      </Link>
                    ) : null}
                  </div>
                  {machineFines.length === 0 ? (
                    <p className="text-sm text-sand-400">{t("machine.noFines", locale)}</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {machineFines.map((f) => {
                        const ds = nominationDeadlineStatus(f.nomination_deadline, f.status, aartoLeadDays);
                        return (
                          <li key={f.id} className="rounded-lg border border-sand-200 p-2.5">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-sand-800">
                                  {f.offence || t("fines.noOffence", locale)}
                                  {f.notice_number ? <span className="text-sand-400"> · {f.notice_number}</span> : null}
                                </p>
                                <p className="text-xs text-sand-500">
                                  {t("fines.driver", locale)}: {fineDriverLabel(f)}
                                  {f.offence_date ? <span className="text-sand-500"> · {shortDate(f.offence_date, locale)}</span> : null}
                                  {costsVisible && f.amount_cents != null ? <span className="tabular-nums"> · {rands(f.amount_cents)}</span> : null}
                                </p>
                                {f.nomination_deadline && nominationPending(f.status) ? (
                                  <p className="text-xs text-sand-500">
                                    {t("fines.deadline", locale)}: <span className="tabular-nums">{shortDate(f.nomination_deadline, locale)}</span>
                                    {ds ? <> · <ExpiryStatus value={ds} locale={locale} /></> : null}
                                  </p>
                                ) : null}
                              </div>
                              <FineStatus value={f.status} locale={locale} />
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </Card>
              ) : (
                <Card>
                  <CardHeader><CardTitle>{t("machine.whoOperated", locale)}</CardTitle></CardHeader>
                  <UpgradeNotice feature="aarto" requiredPlan={requiredPlan("aarto")} currentPlan={plan} locale={locale} compact />
                </Card>
              )}
                </div>
              ),
            },
            {
              key: "papers",
              label: t("machine.tabPapers", locale),
              content: (
                <div className="flex flex-col gap-4">
              {/* The machine's own record, stated as facts. Reg no, purchase, supplier and
                  notes could only be read inside the edit form's input boxes. */}
              {details.length > 0 || canEdit ? (
                <Card>
                  <CardHeader action={canEdit ? editMachineDialog("button") : undefined}>
                    <CardTitle>{t("machines.identityCard", locale)}</CardTitle>
                  </CardHeader>
                  {details.length > 0 ? (
                    <FactList>
                      {details.map((d) => (
                        <Fact key={d.label} label={d.label} value={<span className="break-words">{d.value}</span>} />
                      ))}
                    </FactList>
                  ) : (
                    <p className="text-sm text-sand-500">{t("machine.noDetails", locale)}</p>
                  )}
                </Card>
              ) : null}

              {/* Compliance, warranty + licences (F6) */}
              <Card>
                <CardHeader><CardTitle>{t("compliance.title", locale)}</CardTitle></CardHeader>

                {/* Warranty (stored on the machine) */}
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-medium uppercase tracking-wide text-sand-400">{t("compliance.warranty", locale)}</p>
                  {hasWarranty ? (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-sand-700">
                      {machine.warranty_expiry_date ? (
                        <span>{t("compliance.warrantyDate", locale)}: <span className="font-medium tabular-nums text-sand-900">{shortDate(machine.warranty_expiry_date, locale)}</span></span>
                      ) : null}
                      {machine.warranty_expiry_hours != null ? (
                        <span>{t("compliance.warrantyHours", locale)}: <span className="font-medium tabular-nums text-sand-900">{readingText(machine.warranty_expiry_hours)}</span></span>
                      ) : null}
                      <ExpiryStatus value={wStatus} locale={locale} />
                    </div>
                  ) : (
                    <p className="text-sm text-sand-400">{t("compliance.noWarranty", locale)}</p>
                  )}
                </div>

                {/* Licences / renewals */}
                <div className="mt-4 border-t border-sand-100 pt-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-sand-400">{t("compliance.licences", locale)}</p>
                  {licences.length === 0 ? (
                    <p className="mt-1 text-sm text-sand-400">{t("compliance.noLicences", locale)}</p>
                  ) : (
                    <ul className="mt-2 flex flex-col gap-2">
                      {licences.map((l) => {
                        const s = dateExpiryStatus(l.expiry_date, l.reminder_lead_days);
                        return (
                          <li key={l.id} className="rounded-lg border border-sand-200 p-3">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="font-medium text-sand-900">
                                  {licenceTypeLabel(l.type, locale)}
                                  {l.number ? <span className="text-sand-500"> · {l.number}</span> : null}
                                </p>
                                <p className="text-xs text-sand-500">
                                  {t("compliance.expires", locale)}: <span className="tabular-nums">{shortDate(l.expiry_date, locale)}</span> · {t("compliance.leadDays", locale)}: {l.reminder_lead_days}
                                </p>
                                {l.notes ? <p className="mt-0.5 text-xs text-sand-500">{l.notes}</p> : null}
                              </div>
                              <ExpiryStatus value={s} locale={locale} />
                            </div>
                            {canEdit ? (
                              <div className="mt-2 flex">
                                <ActionMenu
                                  title={licenceTypeLabel(l.type, locale)}
                                  label={t("common.actions", locale)}
                                  closeLabel={closeLabel}
                                  trigger={t("common.edit", locale)}
                                >
                                  <DialogForm
                                    triggerLook="menuItem"
                                    trigger={t("common.edit", locale)}
                                    title={t("common.edit", locale)}
                                    description={licenceTypeLabel(l.type, locale)}
                                    closeLabel={closeLabel}
                                  >
                                    <form action={updateLicence}>
                                      <input type="hidden" name="id" value={l.id} />
                                      <input type="hidden" name="machine_id" value={machine.id} />
                                      <DialogFields>
                                        <Field label={t("compliance.type", locale)} htmlFor={`lc-type-${l.id}`}>
                                          <Select id={`lc-type-${l.id}`} name="type" defaultValue={l.type}>
                                            {LICENCE_TYPES.map((lt) => <option key={lt} value={lt}>{licenceTypeLabel(lt, locale)}</option>)}
                                          </Select>
                                        </Field>
                                        <Field label={t("compliance.number", locale)} htmlFor={`lc-no-${l.id}`}>
                                          <Input id={`lc-no-${l.id}`} name="number" defaultValue={l.number ?? ""} />
                                        </Field>
                                        <Field label={t("compliance.expires", locale)} htmlFor={`lc-exp-${l.id}`} required>
                                          <Input id={`lc-exp-${l.id}`} name="expiry_date" type="date" defaultValue={l.expiry_date} required />
                                        </Field>
                                        <Field label={t("compliance.leadDays", locale)} htmlFor={`lc-lead-${l.id}`}>
                                          <Input id={`lc-lead-${l.id}`} name="reminder_lead_days" type="number" min={0} defaultValue={l.reminder_lead_days} />
                                        </Field>
                                        <div className="sm:col-span-2">
                                          <Field label={t("machines.notes", locale)} htmlFor={`lc-note-${l.id}`}>
                                            <Input id={`lc-note-${l.id}`} name="notes" defaultValue={l.notes ?? ""} />
                                          </Field>
                                        </div>
                                      </DialogFields>
                                      <DialogActions cancelLabel={cancelLabel}>
                                        <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                                      </DialogActions>
                                    </form>
                                  </DialogForm>

                                  <ConfirmDialog
                                    action={deleteLicence}
                                    triggerLook="menuItem"
                                    triggerIcon={<TrashIcon />}
                                    triggerLabel={t("common.delete", locale)}
                                    title={t("confirm.deleteLicenceTitle", locale).replace(
                                      "{type}",
                                      licenceTypeLabel(l.type, locale),
                                    )}
                                    intro={t("confirm.deleteLicenceIntro", locale).replace("{machine}", machine.name)}
                                    consequencesTitle={t("confirm.whatHappens", locale)}
                                    consequences={[
                                      t("confirm.deleteLicenceEffect1", locale),
                                      t("confirm.deleteLicenceEffect2", locale),
                                    ]}
                                    footnote={t("confirm.softDeleteNote", locale)}
                                    confirmLabel={t("confirm.deleteLicenceYes", locale)}
                                    cancelLabel={t("confirm.keepIt", locale)}
                                    closeLabel={closeLabel}
                                  >
                                    <input type="hidden" name="id" value={l.id} />
                                    <input type="hidden" name="machine_id" value={machine.id} />
                                  </ConfirmDialog>
                                </ActionMenu>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {canEdit ? (
                    <div className="mt-3 flex">
                      <DialogForm
                        trigger={t("compliance.addLicence", locale)}
                        triggerIcon={<PlusIcon />}
                        triggerVariant="secondary"
                        triggerSize="sm"
                        title={t("compliance.addLicence", locale)}
                        closeLabel={closeLabel}
                      >
                        <form action={addLicence}>
                          <input type="hidden" name="machine_id" value={machine.id} />
                          <input type="hidden" name="farm_id" value={machine.farm_id} />
                          <DialogFields>
                            <Field label={t("compliance.type", locale)} htmlFor="lc-new-type">
                              <Select id="lc-new-type" name="type" defaultValue="vehicle_licence">
                                {LICENCE_TYPES.map((lt) => <option key={lt} value={lt}>{licenceTypeLabel(lt, locale)}</option>)}
                              </Select>
                            </Field>
                            <Field label={t("compliance.number", locale)} htmlFor="lc-new-no">
                              <Input id="lc-new-no" name="number" />
                            </Field>
                            <Field label={t("compliance.expires", locale)} htmlFor="lc-new-exp" required>
                              <Input id="lc-new-exp" name="expiry_date" type="date" required />
                            </Field>
                            <Field label={t("compliance.leadDays", locale)} htmlFor="lc-new-lead">
                              <Input id="lc-new-lead" name="reminder_lead_days" type="number" min={0} defaultValue={30} />
                            </Field>
                            <div className="sm:col-span-2">
                              <Field label={t("machines.notes", locale)} htmlFor="lc-new-note">
                                <Input id="lc-new-note" name="notes" />
                              </Field>
                            </div>
                          </DialogFields>
                          <DialogActions cancelLabel={cancelLabel}>
                            <SubmitButton variant="primary">{t("common.add", locale)}</SubmitButton>
                          </DialogActions>
                        </form>
                      </DialogForm>
                    </div>
                  ) : null}
                </div>
              </Card>

              {/*
                Audit / sale / warranty packs (FR-13.4), the papers, as one PDF.

                This sat above the tabs, so it spent roughly 150px of phone screen on every
                visit to every machine for a job a farmer does a few times a year, at an
                audit, or a sale. "Papers & licence" is already the warranty-and-licences
                tab, which is what the packs are made of, so it is where somebody looks.

                Hidden from operators and contractors: `authorizeMachinePack` refuses both
                with a 403 before any query, so for them the card was a button that always
                failed. The route is still what refuses, this is presentation only.
              */}
              <DocumentPacks machineId={machine.id} locale={locale} role={resourceRole ?? profile.role} />
                </div>
              ),
            },
        ]}
      />
    </PageContainer>
  );
}
