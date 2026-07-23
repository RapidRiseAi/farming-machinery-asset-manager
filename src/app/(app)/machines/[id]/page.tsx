import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { summariseCosts, costPerMeter, COST_TYPES } from "@/lib/cost";
import { computeConsumption, formatConsumption, activityLabel, FUEL_ACTIVITIES } from "@/lib/fuel";
import { addFuelIssue } from "@/app/(app)/fuel/actions";
import { FuelTrend } from "@/components/fuel-trend";
import { t } from "@/lib/i18n";
import { MACHINE_STATUSES, typeLabel, statusLabel, meterLabel } from "@/lib/machine-options";
import { MachineFields, type OperatorOption } from "@/components/machine-fields";
import { MachinePhotos } from "@/components/machine-photos";
import { MeterGraph } from "./meter-graph";
import { updateMachine, returnMachineToService } from "../actions";
import { addReading } from "./reading-actions";
import { setWatchStatus } from "./watch-actions";
import { addServiceLine, updateServiceLine, deleteServiceLine, applyTemplate } from "./service-actions";
import { addLicence, updateLicence, deleteLicence } from "./licence-actions";
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
import { createJobCard } from "@/app/(app)/jobcards/actions";
import { OfflineForm } from "@/components/offline/offline-form";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { StatusPill, Badge, type BadgeTone } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button, buttonVariants } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ChevronLeftIcon,
  JobCardsIcon,
  FaultsIcon,
  MachinesIcon,
  BellIcon,
  PlusIcon,
} from "@/components/ui/icons";

type Machine = {
  id: string; farm_id: string; name: string; type: string; make: string | null; model: string | null;
  year: number | null; serial_no: string | null; reg_no: string | null; meter_type: string;
  current_reading: number | null; current_reading_date: string | null; status: string;
  purchase_date: string | null; purchase_price_cents: number | null; supplier: string | null;
  warranty_expiry_date: string | null; warranty_expiry_hours: number | null; location: string | null; notes: string | null;
  assigned_operator_id: string | null;
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

type Licence = {
  id: string; type: string; number: string | null; expiry_date: string;
  reminder_lead_days: number; notes: string | null;
};

const savedMsg: Record<string, string> = {
  reading: "ui.saved", watch: "ui.saved", service: "ui.saved", template: "ui.saved", licence: "ui.saved", "1": "ui.saved",
};

export default async function MachineDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; usageDate?: string }>;
}) {
  const profile = await requireProfile();
  const { id } = await params;
  const sp = await searchParams;
  const locale = profile.language;
  const canEdit = profile.role === "owner" || profile.role === "manager";
  const canAddReading = ["owner", "manager", "mechanic"].includes(profile.role);
  const canJob = ["owner", "manager", "mechanic", "workshop"].includes(profile.role);

  const supabase = await createClient();
  const { data } = await supabase
    .from("machines")
    .select("id, farm_id, name, type, make, model, year, serial_no, reg_no, meter_type, current_reading, current_reading_date, status, purchase_date, purchase_price_cents, supplier, warranty_expiry_date, warranty_expiry_hours, location, notes, assigned_operator_id, finance_provider, finance_total_cents, finance_monthly_cents, finance_term_months, finance_interest_bps")
    .eq("id", id)
    .maybeSingle();
  const machine = data as Machine | null;
  if (!machine) notFound();

  const [readingsRes, jcRes, faultsRes, watchRes, planRes, tplRes, usageRes, opRes, costRes, fuelRes, fuelTankRes, licenceRes, farmRes] = await Promise.all([
    supabase.from("meter_readings").select("id, reading, reading_date, source").eq("machine_id", id).is("deleted_at", null).order("reading_date", { ascending: false }).limit(24),
    supabase.from("job_cards").select("id, type, status, total_cents, date_out, created_at").eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("faults").select("id, description, urgency, status, created_at").eq("machine_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("watch_items").select("id, text, status, created_at, source_job_card_id").eq("machine_id", id).order("created_at", { ascending: false }),
    supabase.from("service_plan_lines").select("id, task, interval_hours, interval_months, last_done_reading, last_done_date, next_due_reading, next_due_date, status").eq("machine_id", id).is("deleted_at", null).order("created_at"),
    supabase.from("service_templates").select("id, name, machine_type").is("deleted_at", null).or(`machine_type.eq.${machine.type},machine_type.is.null`),
    supabase.from("usage_logs").select("id, driver_user_id, driver_name, occurred_on, meter_reading, source").eq("machine_id", id).is("deleted_at", null).order("occurred_on", { ascending: false }).limit(20),
    supabase.from("users").select("id, name").eq("active", true).is("deleted_at", null).order("name"),
    supabase.from("cost_entries").select("type, amount_cents").eq("machine_id", id).is("deleted_at", null),
    supabase.from("fuel_issues").select("id, date, litres, meter_reading, cost_cents, activity, anomaly_notified_at").eq("machine_id", id).is("deleted_at", null).order("date", { ascending: false }).limit(200),
    supabase.from("fuel_tanks").select("id, name").is("deleted_at", null).order("name"),
    supabase.from("licences").select("id, type, number, expiry_date, reminder_lead_days, notes").eq("machine_id", id).is("deleted_at", null).order("expiry_date"),
    supabase.from("farms").select("settings").eq("id", machine.farm_id).maybeSingle(),
  ]);

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
  const canFuel = ["owner", "manager", "mechanic", "operator"].includes(profile.role);

  // Driver-on-date lookup (AARTO nomination basis, FR-13.1): usage on a chosen date.
  const usageDate = sp.usageDate && /^\d{4}-\d{2}-\d{2}$/.test(sp.usageDate) ? sp.usageDate : null;
  const usageOnDate = usageDate ? usage.filter((u) => u.occurred_on === usageDate) : [];
  const driverLabel = (u: Usage) =>
    (u.driver_user_id ? operatorName.get(u.driver_user_id) : null) ?? u.driver_name ?? t("machine.unknownDriver", locale);
  const isOutOfService = machine.status === "out_of_service";
  const assignedOperatorName = machine.assigned_operator_id ? operatorName.get(machine.assigned_operator_id) : null;

  // Compliance (F6): warranty (on machines) + licences/renewals. Status ok/expiring/expired
  // uses the same thresholds as the nightly expiry engine (0263).
  const licences = (licenceRes.data as Licence[] | null) ?? [];
  const farmSettings = ((farmRes.data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const warrantyLeadDays = Number(farmSettings.warranty_lead_days) || DEFAULT_WARRANTY_LEAD_DAYS;
  const warrantyHoursLead = Number(farmSettings.warranty_hours_lead) || DEFAULT_WARRANTY_HOURS_LEAD;
  const hasWarranty = machine.warranty_expiry_date != null || machine.warranty_expiry_hours != null;
  const wStatus = warrantyStatus(machine, warrantyLeadDays, warrantyHoursLead);

  // Lifetime stats. TCO = every cost_entry for this asset (purchase + finance + fuel +
  // parts + labour + invoices + other). cost-per-hour / cost-per-km are TCO ÷ lifetime
  // meter on a consistent basis (fixes D-2/D-3); the same helper drives the reports page.
  const costRows = (costRes.data as { type: string; amount_cents: number | null }[] | null) ?? [];
  const { total: tco, breakdown } = summariseCosts(costRows);
  const totalSpend = jobCards.reduce((a, j) => a + (j.total_cents || 0), 0);
  const perMeter =
    machine.meter_type === "hours" || machine.meter_type === "km"
      ? costPerMeter(tco, machine.current_reading)
      : null;
  const perMeterLabel = machine.meter_type === "km" ? t("machine.costPerKm", locale) : t("machine.costPerHour", locale);
  const hasFinance =
    machine.finance_provider != null ||
    machine.finance_total_cents != null ||
    machine.finance_monthly_cents != null ||
    machine.finance_term_months != null ||
    machine.finance_interest_bps != null;
  const openFaultCount = faults.filter((f) => f.status !== "resolved").length;

  // Timeline (merge + sort desc).
  type Ev = { date: string; kind: "jobcard" | "fault" | "reading" | "watch"; title: string; sub: string; href?: string };
  const events: Ev[] = [];
  for (const j of jobCards)
    events.push({
      date: j.date_out ?? j.created_at.slice(0, 10),
      kind: "jobcard",
      title: `${t(`jobType.${j.type}`, locale)} · ${t(`jobStatus.${j.status}`, locale)}`,
      sub: rands(j.total_cents),
      href: `/jobcards/${j.id}`,
    });
  for (const f of faults)
    events.push({
      date: f.created_at.slice(0, 10),
      kind: "fault",
      title: f.description ?? t("machine.evFault", locale),
      sub: `${f.urgency ? t(`urgency.${f.urgency}`, locale) : ""}${f.urgency ? " · " : ""}${t(`faultStatus.${f.status}`, locale)}`,
      href: "/faults",
    });
  for (const r of readings.slice(0, 10))
    events.push({
      date: r.reading_date,
      kind: "reading",
      title: `${r.reading} ${machine.meter_type}`,
      sub: r.source,
    });
  for (const w of watchAll)
    events.push({
      date: w.created_at.slice(0, 10),
      kind: "watch",
      title: w.text,
      sub: t(`watchStatus.${w.status}`, locale),
      href: w.source_job_card_id ? `/jobcards/${w.source_job_card_id}` : undefined,
    });
  events.sort((a, b) => b.date.localeCompare(a.date));

  const evIcon = (k: Ev["kind"]) =>
    k === "jobcard" ? <JobCardsIcon /> : k === "fault" ? <FaultsIcon /> : k === "reading" ? <MachinesIcon /> : <BellIcon />;

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

  const staleCut = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const isStale = machine.meter_type !== "none" && (!machine.current_reading_date || machine.current_reading_date < staleCut);
  const urgencyTone = (u: string | null): BadgeTone => {
    const s = (u ?? "").toLowerCase();
    if (s.includes("stop")) return "danger";
    if (s.includes("limp")) return "warning";
    return "neutral";
  };
  const intervalText = (l: PlanLine) => {
    const parts: string[] = [];
    if (l.interval_hours) parts.push(`${l.interval_hours}${t("machine.hrs", locale)}`);
    if (l.interval_months) parts.push(`${l.interval_months}${t("machine.mo", locale)}`);
    return `${t("machine.every", locale)} ${parts.join(" / ")}`;
  };

  const inputCls = "rounded-lg border border-sand-300 px-3 py-2 text-sm";

  return (
    <div className="flex flex-col gap-4">
      <Link href="/machines" className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-sm text-sand-500">
        <ChevronLeftIcon className="text-[1rem]" />
        {t("machines.title", locale)}
      </Link>

      {/* Identity card */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-sand-900">{machine.name}</h1>
            <p className="mt-0.5 text-sm text-sand-500">
              {typeLabel(machine.type, locale)}
              {machine.make ? ` · ${machine.make} ${machine.model ?? ""}` : ""}
              {machine.year ? ` · ${machine.year}` : ""}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-sand-600">
              <Badge tone={isOutOfService ? "danger" : "neutral"} className="capitalize">{statusLabel(machine.status, locale)}</Badge>
              <span>
                {meterLabel(machine.meter_type, locale)}
                {machine.current_reading != null ? `: ${machine.current_reading}` : ""}
                {machine.current_reading_date ? ` (${machine.current_reading_date})` : ""}
              </span>
              {isStale ? <Badge tone="warning">{t("machines.stale", locale)}</Badge> : null}
            </div>
            {assignedOperatorName ? (
              <p className="mt-1.5 text-sm text-sand-600">
                {t("machines.assignedOperator", locale)}: <span className="font-medium text-sand-800">{assignedOperatorName}</span>
              </p>
            ) : null}
          </div>
          <div className="flex flex-col items-end gap-1 text-sm">
            <Link href={`/machines/${machine.id}/qr`} className="focus-ring rounded-md text-brand-700">{t("machine.qrCode", locale)} →</Link>
            <a href={`/machines/${machine.id}/file.pdf`} className="focus-ring rounded-md text-brand-700">{t("machine.machineFile", locale)} →</a>
          </div>
        </div>
      </Card>

      {/* Out-of-service banner (active-but-down) — owner/manager can revert. */}
      {isOutOfService ? (
        <Card className="border-status-overdue bg-red-50">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold text-status-overdue">{t("machine.outOfServiceTitle", locale)}</p>
              <p className="mt-0.5 text-sm text-sand-700">{t("machine.outOfServiceHint", locale)}</p>
            </div>
            {canEdit ? (
              <form action={returnMachineToService}>
                <input type="hidden" name="id" value={machine.id} />
                <SubmitButton variant="secondary" size="sm">{t("machine.returnToService", locale)}</SubmitButton>
              </form>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t(savedMsg[sp.saved] ?? "ui.saved", locale) : undefined} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Main column */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          {/* Meter history */}
          {machine.meter_type !== "none" ? (
            <Card>
              <CardHeader><CardTitle>{t("machine.meterHistory", locale)}</CardTitle></CardHeader>
              <MeterGraph readings={readings} unit={machine.meter_type} title={t("machine.meterHistory", locale)} />
              {canAddReading ? (
                <OfflineForm action={addReading} type="log_reading" scope="app" locale={locale} className="mt-3 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="machine_id" value={machine.id} />
                  <input type="hidden" name="farm_id" value={machine.farm_id} />
                  <Field label={t("machine.newReading", locale)} htmlFor="reading" className="flex-1">
                    <Input id="reading" name="reading" type="number" inputMode="decimal" step="0.1" required />
                  </Field>
                  <Field label={t("machine.date", locale)} htmlFor="reading_date">
                    <Input id="reading_date" name="reading_date" type="date" />
                  </Field>
                  {operators.length > 0 ? (
                    <Field label={t("machine.driver", locale)} htmlFor="driver_user_id">
                      <Select id="driver_user_id" name="driver_user_id" defaultValue={machine.assigned_operator_id ?? ""}>
                        <option value="">{t("machines.noOperator", locale)}</option>
                        {operators.map((op) => (
                          <option key={op.id} value={op.id}>{op.name}</option>
                        ))}
                      </Select>
                    </Field>
                  ) : null}
                  <SubmitButton variant="primary">{t("machine.log", locale)}</SubmitButton>
                </OfflineForm>
              ) : null}
              {readings.length > 0 ? (
                <ul className="mt-3 flex flex-col divide-y divide-sand-100 text-sm">
                  {readings.slice(0, 8).map((r) => (
                    <li key={r.id} className="flex justify-between py-1.5">
                      <span>{r.reading} {machine.meter_type}</span>
                      <span className="text-sand-500">{r.reading_date} · {r.source}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-3 text-sm text-sand-400">{t("machine.noReadings", locale)}</p>}
            </Card>
          ) : null}

          {/* Fuel & consumption (F4) */}
          <Card>
            <CardHeader><CardTitle>{t("machine.fuelTitle", locale)}</CardTitle></CardHeader>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-sand-400">{t("machine.fuelConsumption", locale)}</p>
                <p className="text-2xl font-bold tabular-nums text-sand-900">
                  {fuelConsumption.display != null ? formatConsumption(fuelConsumption, locale) : "—"}
                </p>
                {fuelConsumption.intervals > 0 ? (
                  <p className="text-xs text-sand-500">{t("machine.fuelIntervals", locale).replace("{n}", String(fuelConsumption.intervals))}</p>
                ) : (
                  <p className="text-xs text-sand-400">{t("fuel.needMoreData", locale)}</p>
                )}
              </div>
              {fuelConsumption.trend.length > 1 ? (
                <div className="w-40">
                  <FuelTrend trend={fuelConsumption.trend} unit={machine.meter_type === "km" ? t("fuel.perKm", locale) : t("fuel.perHr", locale)} title={t("fuel.trend", locale)} />
                </div>
              ) : null}
            </div>

            {canFuel && fuelTanks.length > 0 ? (
              <form action={addFuelIssue} className="mt-3 flex flex-wrap items-end gap-2 border-t border-sand-100 pt-3">
                <input type="hidden" name="machine_id" value={machine.id} />
                <input type="hidden" name="redirect_to" value={`/machines/${machine.id}`} />
                <Field label={t("fuel.tank", locale)} htmlFor="f_tank">
                  <Select id="f_tank" name="tank_id" required defaultValue={fuelTanks[0]?.id ?? ""}>
                    {fuelTanks.map((tk) => (
                      <option key={tk.id} value={tk.id}>{tk.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("fuel.litres", locale)} htmlFor="f_litres">
                  <Input id="f_litres" name="litres" type="number" inputMode="decimal" step="0.1" required className="w-24" />
                </Field>
                {machine.meter_type !== "none" ? (
                  <Field label={t("fuel.meter", locale)} htmlFor="f_meter">
                    <Input id="f_meter" name="meter_reading" type="number" inputMode="decimal" step="0.1" className="w-28" defaultValue={machine.current_reading ?? ""} />
                  </Field>
                ) : null}
                <Field label={t("fuel.cost", locale)} htmlFor="f_cost">
                  <Input id="f_cost" name="cost" inputMode="decimal" placeholder="R" className="w-24" />
                </Field>
                <Field label={t("fuel.activityLabel", locale)} htmlFor="f_activity">
                  <Select id="f_activity" name="activity" defaultValue="">
                    <option value="">—</option>
                    {FUEL_ACTIVITIES.map((a) => (
                      <option key={a} value={a}>{activityLabel(a, locale)}</option>
                    ))}
                  </Select>
                </Field>
                {operators.length > 0 ? (
                  <Field label={t("fuel.driver", locale)} htmlFor="f_driver">
                    <Select id="f_driver" name="driver_user_id" defaultValue={machine.assigned_operator_id ?? ""}>
                      <option value="">{t("machines.noOperator", locale)}</option>
                      {operators.map((op) => (
                        <option key={op.id} value={op.id}>{op.name}</option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                <SubmitButton variant="primary">{t("machine.logFuel", locale)}</SubmitButton>
              </form>
            ) : null}

            {fuelDraws.length > 0 ? (
              <ul className="mt-3 flex flex-col divide-y divide-sand-100 text-sm">
                {fuelDraws.slice(0, 8).map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-sand-800">{d.litres} {t("fuel.litresShort", locale)}</span>
                      {d.activity ? <span className="text-sand-500"> · {activityLabel(d.activity, locale)}</span> : null}
                      {d.meter_reading != null ? <span className="text-sand-400"> · {d.meter_reading} {machine.meter_type}</span> : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-sand-400">
                      {d.cost_cents != null ? <span className="tabular-nums text-sand-500">{rands(d.cost_cents)}</span> : null}
                      {d.anomaly_notified_at ? <Badge tone="danger">{t("fuel.flagged", locale)}</Badge> : null}
                      <span className="tabular-nums">{d.date}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-sand-400">{t("machine.noFuel", locale)}</p>
            )}
          </Card>

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
                {planLines.map((l) => (
                  <li key={l.id} className="rounded-lg border border-sand-200 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-sand-900">{l.task}</p>
                        <p className="text-xs text-sand-500">{intervalText(l)}</p>
                      </div>
                      <StatusPill status={l.status as "ok" | "due_soon" | "overdue"} label={statusPillLabel(l.status)} />
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sand-100">
                      <div className={`h-full rounded-full ${statusBar[l.status] ?? "bg-status-ok"}`} style={{ width: `${Math.round(lineProgress(l) * 100)}%` }} />
                    </div>
                    <div className="mt-1.5 flex justify-between text-xs text-sand-500">
                      <span>{t("machine.lastDone", locale)}: {l.last_done_reading ?? "—"}{l.last_done_date ? ` · ${l.last_done_date}` : ""}</span>
                      <span>{t("machine.nextDue", locale)}: {l.next_due_reading ?? "—"}{l.next_due_date ? ` · ${l.next_due_date}` : ""}</span>
                    </div>
                    {canEdit ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-medium text-brand-700">{t("machine.editServiceLine", locale)}</summary>
                        <form action={updateServiceLine} className="mt-2 flex flex-wrap gap-2">
                          <input type="hidden" name="id" value={l.id} />
                          <input type="hidden" name="machine_id" value={machine.id} />
                          <input name="task" defaultValue={l.task} placeholder={t("machine.task", locale)} className={`${inputCls} flex-1`} required />
                          <input name="interval_hours" type="number" step="0.1" defaultValue={l.interval_hours ?? ""} placeholder={t("machine.intervalHours", locale)} className={`${inputCls} w-28`} />
                          <input name="interval_months" type="number" defaultValue={l.interval_months ?? ""} placeholder={t("machine.intervalMonths", locale)} className={`${inputCls} w-28`} />
                          <input name="last_done_reading" type="number" step="0.1" defaultValue={l.last_done_reading ?? ""} placeholder={t("machine.lastDone", locale)} className={`${inputCls} w-28`} />
                          <input name="last_done_date" type="date" defaultValue={l.last_done_date ?? ""} className={`${inputCls}`} />
                          <SubmitButton variant="secondary" size="sm">{t("common.save", locale)}</SubmitButton>
                        </form>
                        <form action={deleteServiceLine} className="mt-1">
                          <input type="hidden" name="id" value={l.id} />
                          <input type="hidden" name="machine_id" value={machine.id} />
                          <button className="text-xs text-status-overdue">{t("machine.delete", locale)}</button>
                        </form>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canEdit ? (
              <div className="mt-3 flex flex-col gap-2 border-t border-sand-100 pt-3">
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-brand-700">{t("machine.addServiceLine", locale)}</summary>
                  <form action={addServiceLine} className="mt-2 flex flex-wrap gap-2">
                    <input type="hidden" name="machine_id" value={machine.id} />
                    <input type="hidden" name="farm_id" value={machine.farm_id} />
                    <input name="task" placeholder={t("machine.task", locale)} className={`${inputCls} flex-1`} required />
                    <input name="interval_hours" type="number" step="0.1" placeholder={t("machine.intervalHours", locale)} className={`${inputCls} w-28`} />
                    <input name="interval_months" type="number" placeholder={t("machine.intervalMonths", locale)} className={`${inputCls} w-28`} />
                    <input name="last_done_reading" type="number" step="0.1" placeholder={t("machine.lastDone", locale)} className={`${inputCls} w-28`} />
                    <input name="last_done_date" type="date" className={`${inputCls}`} />
                    <SubmitButton variant="primary" size="sm">{t("common.add", locale)}</SubmitButton>
                  </form>
                </details>
                {templates.length > 0 ? (
                  <details>
                    <summary className="cursor-pointer text-sm font-medium text-brand-700">{t("machine.applyTemplate", locale)}</summary>
                    <form action={applyTemplate} className="mt-2 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="machine_id" value={machine.id} />
                      <input type="hidden" name="farm_id" value={machine.farm_id} />
                      <select name="template_id" className={`${inputCls} flex-1`} required defaultValue="">
                        <option value="" disabled>{t("machine.template", locale)}</option>
                        {templates.map((tp) => (
                          <option key={tp.id} value={tp.id}>{tp.name}</option>
                        ))}
                      </select>
                      <SubmitButton variant="secondary" size="sm">{t("machine.apply", locale)}</SubmitButton>
                    </form>
                  </details>
                ) : null}
              </div>
            ) : null}
          </Card>

          {/* Compliance — warranty + licences (F6) */}
          <Card>
            <CardHeader><CardTitle>{t("compliance.title", locale)}</CardTitle></CardHeader>

            {/* Warranty (stored on the machine) */}
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-sand-400">{t("compliance.warranty", locale)}</p>
              {hasWarranty ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-sand-700">
                  {machine.warranty_expiry_date ? (
                    <span>{t("compliance.warrantyDate", locale)}: <span className="font-medium tabular-nums text-sand-900">{machine.warranty_expiry_date}</span></span>
                  ) : null}
                  {machine.warranty_expiry_hours != null ? (
                    <span>{t("compliance.warrantyHours", locale)}: <span className="font-medium tabular-nums text-sand-900">{machine.warranty_expiry_hours}{machine.meter_type === "hours" ? " h" : ""}</span></span>
                  ) : null}
                  <Badge tone={expiryTone(wStatus)}>{expiryLabel(wStatus, locale)}</Badge>
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
                              {t("compliance.expires", locale)}: <span className="tabular-nums">{l.expiry_date}</span> · {t("compliance.leadDays", locale)}: {l.reminder_lead_days}
                            </p>
                            {l.notes ? <p className="mt-0.5 text-xs text-sand-500">{l.notes}</p> : null}
                          </div>
                          <Badge tone={expiryTone(s)}>{expiryLabel(s, locale)}</Badge>
                        </div>
                        {canEdit ? (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-xs font-medium text-brand-700">{t("common.edit", locale)}</summary>
                            <form action={updateLicence} className="mt-2 flex flex-wrap gap-2">
                              <input type="hidden" name="id" value={l.id} />
                              <input type="hidden" name="machine_id" value={machine.id} />
                              <select name="type" defaultValue={l.type} className={`${inputCls} w-40`}>
                                {LICENCE_TYPES.map((lt) => <option key={lt} value={lt}>{licenceTypeLabel(lt, locale)}</option>)}
                              </select>
                              <input name="number" defaultValue={l.number ?? ""} placeholder={t("compliance.number", locale)} className={`${inputCls} w-32`} />
                              <input name="expiry_date" type="date" defaultValue={l.expiry_date} className={inputCls} required />
                              <input name="reminder_lead_days" type="number" min={0} defaultValue={l.reminder_lead_days} className={`${inputCls} w-24`} />
                              <input name="notes" defaultValue={l.notes ?? ""} placeholder={t("machines.notes", locale)} className={`${inputCls} flex-1`} />
                              <SubmitButton variant="secondary" size="sm">{t("common.save", locale)}</SubmitButton>
                            </form>
                            <form action={deleteLicence} className="mt-1">
                              <input type="hidden" name="id" value={l.id} />
                              <input type="hidden" name="machine_id" value={machine.id} />
                              <button className="text-xs text-status-overdue">{t("common.delete", locale)}</button>
                            </form>
                          </details>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {canEdit ? (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium text-brand-700">{t("compliance.addLicence", locale)}</summary>
                  <form action={addLicence} className="mt-2 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="machine_id" value={machine.id} />
                    <input type="hidden" name="farm_id" value={machine.farm_id} />
                    <select name="type" defaultValue="vehicle_licence" className={`${inputCls} w-40`}>
                      {LICENCE_TYPES.map((lt) => <option key={lt} value={lt}>{licenceTypeLabel(lt, locale)}</option>)}
                    </select>
                    <input name="number" placeholder={t("compliance.number", locale)} className={`${inputCls} w-32`} />
                    <input name="expiry_date" type="date" className={inputCls} required />
                    <input name="reminder_lead_days" type="number" min={0} defaultValue={30} className={`${inputCls} w-24`} />
                    <input name="notes" placeholder={t("machines.notes", locale)} className={`${inputCls} flex-1`} />
                    <SubmitButton variant="primary" size="sm">{t("common.add", locale)}</SubmitButton>
                  </form>
                </details>
              ) : null}
            </div>
          </Card>

          {/* Timeline */}
          <Card>
            <CardHeader><CardTitle>{t("machine.timeline", locale)}</CardTitle></CardHeader>
            {events.length === 0 ? (
              <EmptyState title={t("machine.noTimeline", locale)} />
            ) : (
              <ol className="flex flex-col">
                {events.map((e, i) => {
                  const body = (
                    <div className="flex gap-3 py-2.5">
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sand-100 text-[1.05rem] text-sand-500">
                        {evIcon(e.kind)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium text-sand-900">{e.title}</span>
                          <span className="shrink-0 text-xs tabular-nums text-sand-400">{e.date}</span>
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
                })}
              </ol>
            )}
          </Card>

          {/* Who operated / when — AARTO driver-usage log (FR-13.1) */}
          <Card>
            <CardHeader><CardTitle>{t("machine.whoOperated", locale)}</CardTitle></CardHeader>

            {/* Driver-on-date lookup (the AARTO nomination question). */}
            <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
              <Field label={t("machine.driverOnDate", locale)} htmlFor="usageDate">
                <Input id="usageDate" name="usageDate" type="date" defaultValue={usageDate ?? ""} />
              </Field>
              <SubmitButton variant="secondary" size="sm">{t("machine.check", locale)}</SubmitButton>
            </form>
            {usageDate ? (
              usageOnDate.length > 0 ? (
                <p className="mb-3 rounded-lg bg-sand-50 p-3 text-sm text-sand-800">
                  {t("machine.operatedBy", locale)}:{" "}
                  <span className="font-medium">{usageOnDate.map(driverLabel).join(", ")}</span>
                  <span className="text-sand-400"> · {usageDate}</span>
                </p>
              ) : (
                <p className="mb-3 rounded-lg bg-sand-50 p-3 text-sm text-sand-500">{t("machine.noDriverOn", locale)}</p>
              )
            ) : null}

            {usage.length === 0 ? (
              <p className="text-sm text-sand-500">{t("machine.noUsage", locale)}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-sand-100 text-sm">
                {usage.slice(0, 12).map((u) => (
                  <li key={u.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="min-w-0 truncate font-medium text-sand-800">{driverLabel(u)}</span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-sand-400">
                      {u.meter_reading != null ? <span className="tabular-nums">{u.meter_reading} {machine.meter_type !== "none" ? machine.meter_type : ""}</span> : null}
                      <span>{t(`meterSource.${u.source}`, locale)}</span>
                      <span className="tabular-nums">{u.occurred_on}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-4">
          {/* Lifetime stats */}
          <Card>
            <CardHeader><CardTitle>{t("machine.lifetimeStats", locale)}</CardTitle></CardHeader>
            <div className="grid grid-cols-2 gap-3">
              <Stat label={t("machine.tco", locale)} value={rands(tco)} />
              <Stat label={perMeterLabel} value={perMeter != null ? rands(perMeter) : "—"} />
              <Stat label={t("machine.maintenanceSpend", locale)} value={rands(totalSpend)} />
              <Stat label={t("machine.jobCardCount", locale)} value={jobCards.length} />
              <Stat label={t("machine.openFaults", locale)} value={openFaultCount} tone={openFaultCount > 0 ? "overdue" : "default"} />
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
          </Card>

          {/* Finance */}
          {hasFinance ? (
            <Card>
              <CardHeader><CardTitle>{t("machine.finance", locale)}</CardTitle></CardHeader>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                {machine.finance_provider ? (
                  <div className="col-span-2"><dt className="text-sand-500">{t("machines.financeProvider", locale)}</dt><dd className="font-medium text-sand-900">{machine.finance_provider}</dd></div>
                ) : null}
                {machine.finance_total_cents != null ? (
                  <div><dt className="text-sand-500">{t("machines.financeTotal", locale)}</dt><dd className="font-medium text-sand-900">{rands(machine.finance_total_cents)}</dd></div>
                ) : null}
                {machine.finance_monthly_cents != null ? (
                  <div><dt className="text-sand-500">{t("machines.financeMonthly", locale)}</dt><dd className="font-medium text-sand-900">{rands(machine.finance_monthly_cents)}</dd></div>
                ) : null}
                {machine.finance_term_months != null ? (
                  <div><dt className="text-sand-500">{t("machines.financeTerm", locale)}</dt><dd className="font-medium text-sand-900">{machine.finance_term_months}</dd></div>
                ) : null}
                {machine.finance_interest_bps != null ? (
                  <div><dt className="text-sand-500">{t("machines.financeInterest", locale)}</dt><dd className="font-medium text-sand-900">{(machine.finance_interest_bps / 100).toFixed(2)}%</dd></div>
                ) : null}
              </dl>
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
                          <button className="rounded border border-sand-300 px-2 py-0.5 text-xs hover:bg-sand-50">{t("machine.done", locale)}</button>
                        </form>
                        <form action={setWatchStatus}>
                          <input type="hidden" name="id" value={w.id} />
                          <input type="hidden" name="machine_id" value={machine.id} />
                          <input type="hidden" name="status" value="dismissed" />
                          <button className="rounded border border-sand-300 px-2 py-0.5 text-xs hover:bg-sand-50">{t("machine.dismiss", locale)}</button>
                        </form>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {/* Job cards */}
          <Card>
            <CardHeader
              action={canJob ? (
                <form action={createJobCard} className="flex items-center gap-1">
                  <input type="hidden" name="machine_id" value={machine.id} />
                  <input type="hidden" name="farm_id" value={machine.farm_id} />
                  <input type="hidden" name="type" value="repair" />
                  <Button type="submit" variant="ghost" size="sm"><PlusIcon className="text-[1rem]" />{t("machine.newJobCard", locale)}</Button>
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
                    <Link href={`/jobcards/${j.id}`} className="focus-ring flex items-center justify-between rounded-md py-1.5">
                      <span>{t(`jobType.${j.type}`, locale)}</span>
                      <span className="text-sand-500">{rands(j.total_cents)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Photos */}
          <Card>
            <MachinePhotos farmId={machine.farm_id} machineId={machine.id} canEdit={canEdit} />
          </Card>

          {/* Edit */}
          {canEdit ? (
            <Card>
              <details>
                <summary className="cursor-pointer font-semibold text-sand-900">{t("machine.editMachine", locale)}</summary>
                <form action={updateMachine} className="mt-3 flex flex-col gap-4">
                  <input type="hidden" name="id" value={machine.id} />
                  <MachineFields machine={machine} operators={operators} locale={locale} />
                  <Field label={t("machines.status", locale)} htmlFor="status">
                    <Select id="status" name="status" defaultValue={machine.status}>
                      {MACHINE_STATUSES.map((s) => (
                        <option key={s} value={s}>{statusLabel(s, locale)}</option>
                      ))}
                    </Select>
                  </Field>
                  <SubmitButton variant="primary" fullWidth>{t("common.save", locale)}</SubmitButton>
                </form>
              </details>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
