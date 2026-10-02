import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { accessibleFarms, checkEntitlement, currentFarmId, effectiveFarmRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { canViewFarmCosts } from "@/lib/cost-visibility";
import { rands } from "@/lib/money";
import { t, type Lang } from "@/lib/i18n";
import { errorMessage } from "@/lib/errors";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { ReportFaultDialog } from "@/components/report-fault-dialog";
// Import from specific modules (not the barrel) so this Server Component stays
// free of the kit's client chunk, see src/components/ui/README.md.
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Flash } from "@/components/ui/flash";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { AllClear, GetStarted } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { ActionMenu } from "@/components/ui/action-menu";
import { menuItemClass } from "@/components/ui/menu-item";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { withTab } from "@/components/ui/tabs-url";
import { ChevronRightIcon, MachinesIcon, WarningIcon, PlusIcon, SettingsIcon } from "@/components/ui/icons";
import { daysAgo, meterReading, num, relativeDate, shortDate } from "@/lib/format";
import { shortMonth, weekdayDayMonth } from "@/lib/month-names";
import { DASH_COOKIE, parseDashPrefs, type DashSection } from "@/lib/dashboard-prefs";
import { setupSteps } from "@/lib/setup-steps";
import { SETTING_NUMBERS } from "@/lib/settings";
import { SpendTrend } from "./charts";
import { dismissSetupCard, recordDashboardReading, recordDashboardReadings, saveDashboardPrefs } from "./actions";
import { warrantyStatus, dateExpiryStatus, licenceTypeLabel } from "@/lib/compliance";
import { ExpiryStatus, FineStatus, UrgencyStatus, ServiceStatus, MachineStatus } from "@/components/ui/status";

type Machine = {
  id: string;
  name: string;
  status: string;
  meter_type: string;
  current_reading: number | null;
  current_reading_date: string | null;
  warranty_expiry_date: string | null;
  warranty_expiry_hours: number | null;
  assigned_operator_id: string | null;
};
type Licence = { id: string; machine_id: string; type: string; number: string | null; expiry_date: string; reminder_lead_days: number };
type DashFine = { id: string; machine_id: string; offence: string | null; notice_number: string | null; nomination_deadline: string | null; status: string };
type SPL = { machine_id: string; status: string; task: string; next_due_date: string | null };
type Fault = { id: string; machine_id: string; description: string | null; urgency: string | null; created_at: string };
type JC = { machine_id: string; type: string; total_cents: number; date_out: string | null };
type OpenJC = { machine_id: string; date_in: string | null };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** How many attention rows show before "Show N more". */
const VISIBLE_ROWS = 5;
/** The stale-meters dialog is one field per machine; past this it stops being quick. */
const STALE_FORM_MAX = 12;

const SAVED_KEYS: Record<string, string> = {
  prefs: "dashboard.prefsSaved",
  reading: "dashboard.readingsSaved",
  readings: "dashboard.readingsSaved",
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const sp = await searchParams;
  // Dashboard is a Professional+ feature (FR-19.2). Deny server-side for under-plan
  // farms, the KPI data below is never fetched or rendered; an upgrade prompt shows.
  const gate = await checkEntitlement("dashboard");
  const profile = gate.profile;
  const locale = profile.lang;
  // A contractor (workshop role) has no single "farm", their home is the aggregated
  // contractor dashboard (F12c), not this farm-centric one.
  if (profile.role === "workshop") redirect("/contractor");
  if (!gate.allowed) {
    return (
      <PageContainer>
        <PageHeader title={t("nav.dashboard", locale)} infoKey="dashboard" locale={locale} />
        <UpgradeNotice
          feature="dashboard"
          requiredPlan={gate.requiredPlan}
          currentPlan={gate.plan}
          locale={locale}
        />
      </PageContainer>
    );
  }
  const supabase = await createClient();
  // Multi-site (F7): scope every KPI query to the farm the user is currently acting in.
  // Single-farm users are unaffected (RLS already scopes to their one farm); a multi-site
  // user sees the farm chosen in the switcher. rr_admin (farmId null) keeps its all-farms view.
  const farmId = await currentFarmId(profile);
  const role = farmId ? ((await effectiveFarmRole(farmId, profile)) ?? profile.role) : profile.role;
  const isBoss = role === "owner" || role === "manager" || role === "rr_admin";
  const costsVisible = farmId ? await canViewFarmCosts(supabase, farmId) : profile.role === "rr_admin";
  const byFarm = <Q,>(q: Q): Q =>
    farmId ? (q as { eq(c: string, v: string): Q }).eq("farm_id", farmId) : q;
  // Started now, read with the KPI queries: whether this account reaches more than one farm.
  const farmsPromise = accessibleFarms(profile);

  // What this person chose to see on this device. Choices, not permissions: see
  // dashboard-prefs.ts.
  const prefs = parseDashPrefs((await cookies()).get(DASH_COOKIE)?.value, role);

  const now = new Date();
  const firstThis = new Date(now.getFullYear(), now.getMonth(), 1);
  const firstLast = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const flagCut = ymd(new Date(now.getTime() - 45 * 86400000));
  const [machinesRes, splRes, faultsRes, jcRes, openJcRes, fuelMonthRes, fuelFlagRes, licenceRes, farmRes] = await Promise.all([
    byFarm(supabase.from("machines").select("id, name, status, meter_type, current_reading, current_reading_date, warranty_expiry_date, warranty_expiry_hours, assigned_operator_id").is("deleted_at", null)),
    byFarm(supabase.from("service_plan_lines").select("machine_id, status, task, next_due_date").is("deleted_at", null)),
    byFarm(supabase.from("faults").select("id, machine_id, description, urgency, created_at").neq("status", "resolved").is("deleted_at", null).order("created_at", { ascending: false })),
    byFarm(supabase.from("job_cards_visible").select("machine_id, type, total_cents, date_out").is("deleted_at", null).gte("date_out", ymd(sixMonthsAgo))),
    byFarm(supabase.from("job_cards").select("machine_id, date_in").is("deleted_at", null).in("status", ["open", "in_progress", "waiting_parts"])),
    byFarm(supabase.from("fuel_issues_visible").select("machine_id, litres, cost_cents").is("deleted_at", null).gte("date", ymd(firstThis))),
    byFarm(supabase.from("fuel_issues").select("machine_id").is("deleted_at", null).not("anomaly_notified_at", "is", null).gte("date", flagCut)),
    byFarm(supabase.from("licences").select("id, machine_id, type, number, expiry_date, reminder_lead_days").is("deleted_at", null)),
    // The farm's own name (stated for a one-farm account, see `farmName`) and its
    // settings, for the stale-reading window and the set-up card.
    farmId
      ? supabase.from("farms").select("name, settings").eq("id", farmId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const farmRow = farmRes.data as { name: string; settings: Record<string, unknown> | null } | null;
  // Only a one-farm account is told its farm's name here. With more than one, the phone
  // header's farm chip and the sidebar switcher already name it, and saying it a third
  // time pushed the "things need you" count onto a second line.
  const multiFarm = (await farmsPromise).length > 1;
  const farmName = multiFarm ? null : farmRow?.name ?? null;
  const settings = farmRow?.settings ?? {};

  const machines = (machinesRes.data as Machine[] | null) ?? [];
  const spl = (splRes.data as SPL[] | null) ?? [];
  const allFaults = (faultsRes.data as Fault[] | null) ?? [];
  const jcs = (jcRes.data as JC[] | null) ?? [];
  const openJcs = (openJcRes.data as OpenJC[] | null) ?? [];
  const fuelMonth = (fuelMonthRes.data as { machine_id: string | null; litres: number | null; cost_cents: number | null }[] | null) ?? [];
  const fuelFlags = (fuelFlagRes.data as { machine_id: string | null }[] | null) ?? [];

  // Active machines only, retired/sold drop out of every count, list and total (Scope §4.1).
  const active = machines.filter((m) => m.status !== "retired" && m.status !== "sold");
  const activeIds = new Set(active.map((m) => m.id));
  const nameById = Object.fromEntries(machines.map((m) => [m.id, m.name]));

  // Service board counts (active machines).
  const svc = { overdue: 0, due_soon: 0, ok: 0 } as Record<string, number>;
  for (const l of spl) if (activeIds.has(l.machine_id) && l.status in svc) svc[l.status]++;

  // Open faults on active machines, with age.
  const faults = allFaults.filter((f) => activeIds.has(f.machine_id));

  // In-workshop machines + days-in (earliest open job card's date_in as proxy).
  const earliestOpenByMachine = new Map<string, string>();
  for (const j of openJcs) {
    if (!j.date_in) continue;
    const cur = earliestOpenByMachine.get(j.machine_id);
    if (!cur || j.date_in < cur) earliestOpenByMachine.set(j.machine_id, j.date_in);
  }
  const inWorkshop = active
    .filter((m) => m.status === "in_workshop")
    .map((m) => {
      const since = earliestOpenByMachine.get(m.id);
      const days = since ? Math.max(0, daysAgo(since, now) ?? 0) : null;
      return { id: m.id, name: m.name, days };
    });

  // Stale readings: metered active machines with no reading inside the farm's own window
  // (Settings > stale_reading_days), not a hard-coded month.
  const staleSetting = settings.stale_reading_days;
  const staleDays =
    typeof staleSetting === "number" && Number.isFinite(staleSetting) && staleSetting > 0
      ? Math.round(staleSetting)
      : SETTING_NUMBERS.stale_reading_days;
  const staleDate = ymd(new Date(now.getTime() - staleDays * 86400000));
  const metered = active
    .filter((m) => m.meter_type !== "none")
    // Stalest first: never read, then the oldest reading. The reading dialog defaults to it.
    .sort((a, b) => (a.current_reading_date ?? "").localeCompare(b.current_reading_date ?? "") || a.name.localeCompare(b.name));
  const stale = metered.filter((m) => !m.current_reading_date || m.current_reading_date < staleDate);
  const lastReadingText = (m: Machine) =>
    m.current_reading != null && m.current_reading_date
      ? t("dashboard.lastReading", locale)
          .replace("{reading}", meterReading(m.current_reading, m.meter_type, locale))
          .replace("{when}", shortDate(m.current_reading_date, locale))
      : t("dashboard.noReadingYet", locale);

  // Spend: this vs last month; 6-month trend; by type (active machines only).
  const inMonth = (dateStr: string | null, start: Date) => {
    if (!dateStr) return false;
    const nextStart = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    return dateStr >= ymd(start) && dateStr < ymd(nextStart);
  };
  const activeJcs = jcs.filter((j) => activeIds.has(j.machine_id));
  const spendThis = activeJcs.filter((j) => inMonth(j.date_out, firstThis)).reduce((a, j) => a + (j.total_cents || 0), 0);
  const spendLast = activeJcs.filter((j) => inMonth(j.date_out, firstLast)).reduce((a, j) => a + (j.total_cents || 0), 0);
  const spendSix = activeJcs.reduce((a, j) => a + (j.total_cents || 0), 0);

  const trend = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    const value = activeJcs.filter((j) => inMonth(j.date_out, d)).reduce((a, j) => a + (j.total_cents || 0), 0);
    // Month words from the locale ("Mei", "Okt"), never a hard-coded English list.
    return { key: ymd(d), label: shortMonth(d, locale), value };
  });

  const byTypeMap = new Map<string, number>();
  for (const j of activeJcs) byTypeMap.set(j.type, (byTypeMap.get(j.type) ?? 0) + (j.total_cents || 0));
  const byType = [...byTypeMap.entries()]
    .map(([k, v]) => ({ key: k, label: t(`jobType.${k}`, locale), value: v }))
    .sort((a, b) => b.value - a.value);

  // Fuel this month + open anomaly count (active machines / farm-level draws).
  const fuelSpendMonth = fuelMonth.reduce((a, f) => a + (f.cost_cents ?? 0), 0);
  const fuelLitresMonth = fuelMonth.reduce((a, f) => a + (f.litres ?? 0), 0);
  const fuelAnomalyCount = fuelFlags.filter((f) => f.machine_id != null && activeIds.has(f.machine_id)).length;
  const fuelHasData = fuelMonth.length > 0 || fuelAnomalyCount > 0;

  // Expiries upcoming (F6): warranty (machine) + licences, expiring or expired, on active
  // machines only (retired/sold excluded like every other count).
  const licences = (licenceRes.data as Licence[] | null) ?? [];
  type Expiry = { key: string; machineId: string; machineName: string; label: string; date: string; status: "expiring" | "expired" };
  const expiries: Expiry[] = [];
  for (const m of active) {
    const s = warrantyStatus(m);
    if (s === "expiring" || s === "expired") {
      expiries.push({
        key: `w-${m.id}`, machineId: m.id, machineName: m.name,
        label: t("compliance.warranty", locale), date: m.warranty_expiry_date ?? "", status: s,
      });
    }
  }
  for (const l of licences) {
    if (!activeIds.has(l.machine_id)) continue;
    const s = dateExpiryStatus(l.expiry_date, l.reminder_lead_days);
    if (s === "expiring" || s === "expired") {
      expiries.push({
        key: `l-${l.id}`, machineId: l.machine_id, machineName: nameById[l.machine_id] ?? "-",
        label: licenceTypeLabel(l.type, locale), date: l.expiry_date, status: s,
      });
    }
  }

  // AARTO nominations pending & deadlines (§23), Complete+ only. Fines still owing a driver
  // nomination (received | driver_identified) on active machines.
  const aartoAllowed = (await checkEntitlement("aarto", profile)).allowed;
  type PendingFine = { id: string; machineId: string; machineName: string; label: string; deadline: string | null; status: string };
  let pendingNominations: PendingFine[] = [];
  if (aartoAllowed) {
    let finesQ = supabase
      .from("fines")
      .select("id, machine_id, offence, notice_number, nomination_deadline, status")
      .in("status", ["received", "driver_identified"])
      .is("deleted_at", null);
    if (farmId) finesQ = finesQ.eq("farm_id", farmId);
    const { data: fineData } = await finesQ;
    pendingNominations = ((fineData as DashFine[] | null) ?? [])
      .filter((f) => activeIds.has(f.machine_id))
      .map((f) => ({
        id: f.id, machineId: f.machine_id, machineName: nameById[f.machine_id] ?? "-",
        label: f.offence || f.notice_number || t("fines.noOffence", locale),
        deadline: f.nomination_deadline, status: f.status,
      }));
  }

  // Spend delta, said in words rather than a percentage sign.
  const spendTone = spendThis > spendLast ? "overdue" : spendThis < spendLast ? "ok" : "default";
  const spendDelta =
    spendLast === 0
      ? undefined
      : (spendThis < spendLast ? t("dashboard.lessThan", locale) : t("dashboard.moreThan", locale))
          .replace("{amount}", rands(Math.abs(spendThis - spendLast)))
          .replace("{month}", shortMonth(firstLast, locale));

  // == "Needs your attention" ================================================
  // One ranked list, worst first. Each thing to do carries where to do it: the exact tab
  // or row, not just the machine page, which used to leave the owner hunting for the
  // action the button had just named.
  type Attend = {
    key: string;
    rank: number;
    /** Tie-break inside a rank: the deadline or the date it started, oldest first. */
    sortDate: string;
    machineId: string;
    machineName: string;
    detail: string;
    /** A system fact beside the person's words (when it was reported), never run into them. */
    meta?: string;
    status: { kind: "urgency" | "service" | "expiry" | "fine"; value: string };
    ctaLabel: string;
    ctaHref: string;
  };
  const attention: Attend[] = [];
  const machineHref = (id: string) => `/machines/${id}`;
  const capitalise = (s: string) => (s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s);

  const urgencyRank: Record<string, number> = { stopped: 0, limping: 3, can_work: 5 };
  for (const f of faults) {
    attention.push({
      key: `f-${f.id}`,
      rank: urgencyRank[f.urgency ?? ""] ?? 4,
      sortDate: f.created_at,
      machineId: f.machine_id,
      machineName: nameById[f.machine_id] ?? "-",
      detail: capitalise((f.description ?? "").trim()) || t(`urgency.${f.urgency ?? "can_work"}`, locale),
      meta: t("dashboard.reportedOn", locale).replace("{when}", relativeDate(f.created_at, locale, now)),
      status: { kind: "urgency", value: f.urgency ?? "can_work" },
      ctaLabel: t("faults.makeJobCard", locale),
      // The fault's own row, where its job-card action lives.
      ctaHref: `/faults#fault-${f.id}`,
    });
  }

  for (const l of spl) {
    if (!activeIds.has(l.machine_id)) continue;
    if (l.status !== "overdue" && l.status !== "due_soon") continue;
    attention.push({
      key: `s-${l.machine_id}-${l.task}`,
      rank: l.status === "overdue" ? 1 : 4,
      sortDate: l.next_due_date ?? "9999-12-31",
      machineId: l.machine_id,
      machineName: nameById[l.machine_id] ?? "-",
      detail: t(l.status === "overdue" ? "dashboard.serviceOverdueDetail" : "dashboard.serviceDueDetail", locale).replace("{task}", l.task),
      status: { kind: "service", value: l.status },
      ctaLabel: t("dashboard.ctaBookService", locale),
      ctaHref: withTab(machineHref(l.machine_id), "servicing"),
    });
  }

  for (const e of expiries) {
    attention.push({
      key: `e-${e.key}`,
      rank: e.status === "expired" ? 2 : 4,
      sortDate: e.date || "9999-12-31",
      machineId: e.machineId,
      machineName: e.machineName,
      detail: `${e.label} · ${t(e.status === "expired" ? "dashboard.expiredOn" : "dashboard.expiresOn", locale).replace("{when}", relativeDate(e.date, locale, now))}`,
      status: { kind: "expiry", value: e.status },
      ctaLabel: t("dashboard.ctaSeeMachine", locale),
      ctaHref: withTab(machineHref(e.machineId), "papers"),
    });
  }

  for (const f of pendingNominations) {
    // Ranked by the legal deadline, not by kind: a nomination due this week outranks a
    // service that is merely due soon, and one overdue is nearly as bad as a stopped
    // machine, because the fine transfers to the owner.
    const daysLeft = f.deadline ? -(daysAgo(f.deadline, now) ?? 0) : null;
    attention.push({
      key: `n-${f.id}`,
      rank: daysLeft == null ? 6 : daysLeft <= 7 ? 1 : daysLeft <= 30 ? 4 : 6,
      sortDate: f.deadline ?? "9999-12-31",
      machineId: f.machineId,
      machineName: f.machineName,
      detail: f.deadline
        ? `${f.label} · ${t("dashboard.nominationDue", locale).replace("{when}", relativeDate(f.deadline, locale, now))}`
        : f.label,
      status: { kind: "fine", value: f.status },
      ctaLabel: t("dashboard.ctaNominateDriver", locale),
      ctaHref: `/fines#fine-${f.id}`,
    });
  }
  attention.sort(
    (a, b) => a.rank - b.rank || a.sortDate.localeCompare(b.sortDate) || a.machineName.localeCompare(b.machineName),
  );

  // One row per machine. The list is already worst-first, so the first time a machine
  // appears is its worst item, and the group order follows it.
  const groupMap = new Map<string, Attend[]>();
  for (const a of attention) {
    const list = groupMap.get(a.machineId);
    if (list) list.push(a);
    else groupMap.set(a.machineId, [a]);
  }
  const groups = [...groupMap.entries()].map(([machineId, items]) => ({ machineId, items }));

  // Greeting. South Africa is UTC+2 all year, so the hour is derived rather than
  // guessed from a server timezone that is almost certainly UTC.
  const sastHour = new Date(now.getTime() + 2 * 3_600_000).getUTCHours();
  const greetKey =
    sastHour < 12 ? "dashboard.goodMorning" : sastHour < 18 ? "dashboard.goodAfternoon" : "dashboard.goodEvening";
  const firstName = profile.name.trim().split(/\s+/)[0] || profile.name;

  const working = active.filter((m) => m.status === "active").length;
  const standby = active.filter((m) => m.status === "standby").length;

  // Reporting from here, on the screens with no tab bar (lg and up). Same rule as /faults:
  // the bosses and the mechanic report on any machine, an operator on their own.
  const reportMachines = active
    .filter((m) => role !== "operator" || m.assigned_operator_id === profile.id)
    .map((m) => ({ id: m.id, name: m.name }));
  const canReport =
    ["rr_admin", "owner", "manager", "mechanic"].includes(role) || (role === "operator" && reportMachines.length > 0);

  // == Set-up progress ======================================================
  // A farm part-way through set-up used to see /onboarding only once nothing needed
  // attention, so a farm at 3 of 4 never saw it. The card stays until every step is
  // done or somebody hides it (farms.settings, no migration).
  let setup: { done: number; total: number; next: ReturnType<typeof setupSteps>[number] } | null = null;
  if (isBoss && prefs.setup && !settings.setup_card_dismissed_at && active.length > 0) {
    const { count: userCount } = await supabase
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("active", true);
    const steps = setupSteps({
      machines: machines.length,
      plans: spl.length,
      qrLabelsDone: !!settings.qr_labels_printed_at,
      users: userCount ?? 0,
    });
    const next = steps.find((s) => !s.done);
    if (next) setup = { done: steps.filter((s) => s.done).length, total: steps.length, next };
  }

  const statusBadge = (s: Attend["status"]) =>
    s.kind === "urgency" ? <UrgencyStatus value={s.value} locale={locale} />
    : s.kind === "service" ? <ServiceStatus value={s.value} locale={locale} />
    : s.kind === "expiry" ? <ExpiryStatus value={s.value} locale={locale} />
    : <FineStatus value={s.value} locale={locale} />;

  const attentionRow = (g: { machineId: string; items: Attend[] }) => {
    const [top, ...rest] = g.items;
    return (
      <li key={g.machineId} className="flex items-stretch">
        {/* The whole row is one tap, to the place the worst item is dealt with. The verb
            shows as a button's look from sm up; on a phone the chevron says "go". */}
        <Link
          href={top.ctaHref}
          className="focus-ring flex min-h-[56px] min-w-0 flex-1 items-center gap-3 px-4 py-3 hover:bg-sand-50"
        >
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 break-words font-semibold text-sand-900">{top.machineName}</span>
              {statusBadge(top.status)}
            </span>
            <span className="mt-0.5 line-clamp-2 text-sm leading-relaxed text-sand-700">
              {top.detail}
              {top.meta ? <span className="text-sand-500"> · {top.meta}</span> : null}
            </span>
            {rest.length > 0 ? (
              <span className="mt-0.5 line-clamp-2 text-sm text-sand-500">
                {rest.map((r) => `+ ${r.detail}`).join(" · ")}
              </span>
            ) : null}
          </span>
          <span className={buttonVariants({ variant: "secondary", size: "sm", className: "hidden shrink-0 sm:inline-flex" })}>
            {top.ctaLabel}
          </span>
          <ChevronRightIcon className="shrink-0 text-lg text-sand-400 sm:hidden" />
        </Link>
        {/* A machine with more than one thing wrong: each thing's own action, named with
            the machine, instead of a second row for the same machine. */}
        {rest.length > 0 ? (
          <div className="flex shrink-0 items-center pr-2">
            <ActionMenu
              title={top.machineName}
              label={`${t("common.actions", locale)}: ${top.machineName}`}
              closeLabel={t("ui.close", locale)}
            >
              {g.items.map((i) => (
                <Link key={i.key} href={i.ctaHref} className={menuItemClass()}>
                  <span className="min-w-0">
                    <span className="block">{i.ctaLabel}</span>
                    <span className="block truncate text-xs font-normal text-sand-500">{i.detail}</span>
                  </span>
                </Link>
              ))}
              <Link href={machineHref(g.machineId)} className={menuItemClass()}>
                {t("dashboard.ctaSeeMachine", locale)}
              </Link>
            </ActionMenu>
          </div>
        ) : null}
      </li>
    );
  };

  const savedKey = sp.saved ? (SAVED_KEYS[sp.saved] ?? "ui.saved") : null;

  // The Customise dialog lists what can be shown here. A section this person cannot
  // have (the fleet cost without cost access, set-up for a mechanic) is carried as it is.
  const customisable: { key: DashSection; label: string }[] = [
    ...(isBoss ? [{ key: "setup" as const, label: t("dashboard.sectionSetup", locale) }] : []),
    ...(costsVisible ? [{ key: "cost" as const, label: t("dashboard.fleetCost", locale) }] : []),
    { key: "fleet", label: t("dashboard.fleetNow", locale) },
    { key: "fuel", label: t("nav.fuel", locale) },
    { key: "stale", label: t("dashboard.sectionStale", locale) },
  ];
  const carried = (["setup", "cost", "fleet", "fuel", "stale"] as const).filter(
    (k) => !customisable.some((c) => c.key === k) && prefs[k],
  );

  const readingMachine = metered[0];

  const headerActions = (
    <div className="flex flex-wrap gap-2">
      {metered.length > 0 ? (
        <DialogForm
          trigger={t("dashboard.quickCaptureHours", locale)}
          triggerVariant="secondary"
          triggerIcon={<MachinesIcon />}
          title={t("dashboard.quickCaptureHours", locale)}
          description={t("dashboard.readingDialogHint", locale)}
          closeLabel={t("ui.close", locale)}
          size="md"
        >
          <form action={recordDashboardReading}>
            <DialogFields columns={1}>
              <Field label={t("dashboard.readingMachine", locale)} htmlFor="dash-reading-machine" required>
                <Select id="dash-reading-machine" name="machine_id" defaultValue={readingMachine?.id} required>
                  {metered.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · {lastReadingText(m)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("dashboard.readingValue", locale)} htmlFor="dash-reading-value" required>
                <Input id="dash-reading-value" name="reading" type="number" inputMode="decimal" min={0} step="any" required />
              </Field>
            </DialogFields>
            <DialogActions cancelLabel={t("common.cancel", locale)}>
              <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
            </DialogActions>
          </form>
        </DialogForm>
      ) : null}
      {/* On a phone and a tablet the tab bar's centre button already reports a fault, so
          this shows only where there is no tab bar, and opens the form right here. */}
      {canReport && reportMachines.length > 0 ? (
        <div className="hidden lg:block">
          {/* The kit dialog: it closes on its own and says "Problem sent" in place. */}
          <ReportFaultDialog
            machines={reportMachines}
            redirectTo="/dashboard?saved=fault"
            locale={locale}
            trigger={t("dashboard.quickReportProblem", locale)}
            title={t("dashboard.quickReportProblem", locale)}
            triggerIcon={<PlusIcon />}
          />
        </div>
      ) : null}
      <DialogForm
        trigger={t("dashboard.customise", locale)}
        triggerVariant="ghost"
        triggerIcon={<SettingsIcon />}
        title={t("dashboard.customiseTitle", locale)}
        description={t("dashboard.customiseHint", locale)}
        closeLabel={t("ui.close", locale)}
        size="md"
      >
        <form action={saveDashboardPrefs}>
          <DialogFields columns={1}>
            <Checkbox checked disabled readOnly label={t("dashboard.needsAttention", locale)} hint={t("dashboard.alwaysShown", locale)} />
            {customisable.map((c) => (
              <Checkbox key={c.key} name={`show_${c.key}`} defaultChecked={prefs[c.key]} label={c.label} />
            ))}
            {carried.map((k) => (
              <input key={k} type="hidden" name={`show_${k}`} value="on" />
            ))}
          </DialogFields>
          <DialogActions cancelLabel={t("common.cancel", locale)}>
            <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
          </DialogActions>
        </form>
      </DialogForm>
    </div>
  );

  return (
    <PageContainer size="wide">
      {/* Greeting, replaces the "Dashboard" heading, which told a multi-farm user
          nothing about which farm they were looking at. */}
      <PageHeader
        title={t(greetKey, locale).replace("{name}", firstName)}
        infoKey="dashboard"
        locale={locale}
        meta={
          <>
            <span className="capitalize">{weekdayDayMonth(now, locale)}</span>
            {farmName ? <> · {farmName}</> : null}
            {" · "}
            <span className={attention.length > 0 ? "font-medium text-sand-700" : ""}>
              {attention.length === 0
                ? t("dashboard.nothingNeedsYouSub", locale)
                : attention.length === 1
                  ? t("dashboard.oneThingNeedsYou", locale)
                  : t("dashboard.thingsNeedYou", locale).replace("{n}", String(attention.length))}
            </span>
          </>
        }
        actions={headerActions}
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={savedKey ? t(savedKey, locale) : undefined} />

      {setup ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold text-sand-900">
                {t("dashboard.setupTitle", locale)}
                <span className="font-normal text-sand-500">
                  {" · "}
                  {t("dashboard.setupProgress", locale).replace("{done}", String(setup.done)).replace("{total}", String(setup.total))}
                </span>
              </p>
              <p className="mt-0.5 text-sm text-sand-600">
                {t("dashboard.setupNext", locale).replace("{step}", t(`onboarding.${setup.next.key}Title`, locale))}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link href={setup.next.cta} className={buttonVariants({ variant: "secondary" })}>
                {t(setup.next.ctaKey, locale)}
              </Link>
              <Link href="/onboarding" className={buttonVariants({ variant: "ghost" })}>
                {t("dashboard.setupAll", locale)}
              </Link>
              <form action={dismissSetupCard}>
                <SubmitButton variant="ghost">{t("dashboard.setupHide", locale)}</SubmitButton>
              </form>
            </div>
          </div>
        </Card>
      ) : null}

      {/* == Needs your attention =========================================== */}
      {attention.length === 0 ? (
        active.length > 0 ? (
          <AllClear
            title={t("dashboard.allClearTitle", locale)}
            hint={t("dashboard.allClearHint", locale)}
          />
        ) : null
      ) : (
        <Card flush>
          <div className="flex items-baseline justify-between gap-3 px-4 pt-4">
            <h2 className="text-base font-bold text-sand-900">
              {t("dashboard.needsAttention", locale)}
            </h2>
            <span className="text-xs font-medium uppercase tracking-wide text-sand-500">
              {t("dashboard.worstFirst", locale)}
            </span>
          </div>
          <ul className="mt-2 flex flex-col divide-y divide-sand-100">
            {groups.slice(0, VISIBLE_ROWS).map(attentionRow)}
          </ul>
          {/* The rest of the same ranked list, here, rather than a "View all" that went to
              /faults although the list mixes services, papers and fines. */}
          {groups.length > VISIBLE_ROWS ? (
            <div className="border-t border-sand-100 px-3 py-1">
              <Disclosure
                variant="inline"
                summary={t("dashboard.showMore", locale).replace("{n}", String(groups.length - VISIBLE_ROWS))}
              >
                <ul className="-mx-3 flex flex-col divide-y divide-sand-100 border-t border-sand-100">
                  {groups.slice(VISIBLE_ROWS).map(attentionRow)}
                </ul>
              </Disclosure>
            </div>
          ) : null}
        </Card>
      )}

      {/* == What the fleet cost you ======================================== */}
      {costsVisible && prefs.cost ? (
        <Card>
          <CardHeader
            action={
              <Link href="/reports" className="focus-ring inline-flex min-h-[48px] items-center gap-0.5 rounded-md text-sm font-medium text-brand-ink sm:min-h-0">
                {t("dashboard.fullCostReport", locale)}
                <ChevronRightIcon className="text-base" />
              </Link>
            }
          >
            <CardTitle>{t("dashboard.fleetCost", locale)}</CardTitle>
          </CardHeader>
          <p className="-mt-2 mb-3 text-sm text-sand-500">{t("dashboard.fleetCostHint", locale)}</p>

          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-3xl font-bold tabular-nums tracking-tight text-sand-950">{rands(spendThis)}</span>
            <span className="text-sm text-sand-500">{t("dashboard.thisMonth", locale)}</span>
            {spendDelta ? (
              <span className={`text-sm font-medium ${spendTone === "overdue" ? "text-status-overdue" : spendTone === "ok" ? "text-status-ok" : "text-sand-500"}`}>
                {spendDelta}
              </span>
            ) : null}
            {/* A bare R0,00 over a chart of earlier spend read as "nothing spent". */}
            {spendThis === 0 && spendSix > 0 ? (
              <span className="text-sm text-sand-600">
                {t("dashboard.overSixMonths", locale).replace("{amount}", rands(spendSix))}
              </span>
            ) : null}
          </div>

          {/* The chart and the breakdown cover six months, and now say so: the breakdown
              used to sit straight under "This month" and read as part of it. */}
          {spendSix > 0 ? (
            <div className="mt-4 border-t border-sand-100 pt-3">
              <h3 className="text-sm font-semibold text-sand-700">{t("dashboard.spendTrend", locale)}</h3>
              <div className="mt-3">
                <SpendTrend data={trend} title={t("dashboard.spendTrend", locale)} />
              </div>
              {byType.length > 0 ? (
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                  {byType.slice(0, 4).map((b) => (
                    <div key={b.key} className="min-w-0">
                      <dt className="truncate text-xs text-sand-500">{b.label}</dt>
                      <dd className="text-base font-semibold tabular-nums text-sand-900">{rands(b.value)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* == The fleet at a glance ========================================== */}
      {/* One card, every row a way in. Servicing and fleet status were two cards of
          counts that went nowhere. */}
      {prefs.fleet && active.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("dashboard.fleetNow", locale)}</CardTitle>
          </CardHeader>
          <ul className="flex flex-col divide-y divide-sand-100">
            {([
              { key: "active", n: working, href: "/machines?status=active", note: null },
              {
                key: "in_workshop",
                n: inWorkshop.length,
                href: "/machines?status=in_workshop",
                note: inWorkshop.length > 0
                  ? inWorkshop.map((m) => (m.days != null ? `${m.name} · ${m.days}${t("dashboard.dayShort", locale)}` : m.name)).join(", ")
                  : null,
              },
              { key: "standby", n: standby, href: "/machines?status=standby", note: null },
            ] as const).map((row) => (
              <li key={row.key}>
                <Link href={row.href} className="focus-ring -mx-2 flex min-h-[48px] items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-sand-50">
                  <span className="min-w-0">
                    <MachineStatus value={row.key} locale={locale} size="md" />
                    {row.note ? <span className="mt-1 block truncate text-sm text-sand-500">{row.note}</span> : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="text-xl font-bold tabular-nums text-sand-900">{row.n}</span>
                    <ChevronRightIcon className="text-lg text-sand-400" />
                  </span>
                </Link>
              </li>
            ))}
            {svc.overdue > 0 || svc.due_soon > 0 ? (
              ([
                { key: "overdue", n: svc.overdue },
                { key: "due_soon", n: svc.due_soon },
              ] as const)
                .filter((row) => row.n > 0)
                .map((row) => (
                  <li key={row.key}>
                    <Link href="/calendar" className="focus-ring -mx-2 flex min-h-[48px] items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-sand-50">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-sm text-sand-600">{t("dashboard.servicing", locale)}</span>
                        <ServiceStatus value={row.key} locale={locale} size="md" />
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <span className="text-xl font-bold tabular-nums text-sand-900">{row.n}</span>
                        <ChevronRightIcon className="text-lg text-sand-400" />
                      </span>
                    </Link>
                  </li>
                ))
            ) : (
              <li className="py-2.5 text-sm text-sand-500">
                {t("dashboard.servicing", locale)}: {t("dashboard.servicingNothingToDo", locale)}
              </li>
            )}
          </ul>
        </Card>
      ) : null}

      {/* Fuel, kept, but only when the farm actually uses it. */}
      {prefs.fuel && fuelHasData ? (
        <Card>
          <CardHeader
            action={
              <Link href="/fuel" className="focus-ring inline-flex min-h-[48px] items-center gap-0.5 rounded-md text-sm font-medium text-brand-ink sm:min-h-0">
                {t("nav.fuel", locale)}
                <ChevronRightIcon className="text-base" />
              </Link>
            }
          >
            <CardTitle>{t("nav.fuel", locale)}</CardTitle>
          </CardHeader>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {costsVisible ? <Stat label={t("dashboard.fuelSpend", locale)} value={rands(fuelSpendMonth)} href="/fuel" size="md" /> : null}
            <Stat label={t("dashboard.fuelLitres", locale)} value={num(fuelLitresMonth, 0)} href="/fuel" size="md" />
            <Stat label={t("dashboard.fuelAnomalies", locale)} value={fuelAnomalyCount} tone={fuelAnomalyCount > 0 ? "overdue" : "default"} href="/fuel" size="md" />
          </div>
        </Card>
      ) : null}

      {/* Stale meters: the machines named, and one dialog to write the numbers down. */}
      {prefs.stale && stale.length > 0 ? (
        <Card>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-callout-warn-bg text-lg text-status-due" aria-hidden>
              <WarningIcon />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sand-900">
                {(stale.length === 1 ? t("dashboard.staleDaysOneTitle", locale) : t("dashboard.staleDaysTitle", locale))
                  .replace("{n}", String(stale.length))
                  .replace("{days}", String(staleDays))}
              </p>
              <p className="mt-0.5 text-sm text-sand-600">
                {staleNames(stale.map((m) => m.name), locale)} {t("dashboard.staleMetersHint", locale)}
              </p>
              <div className="mt-3">
                <DialogForm
                  trigger={t("dashboard.recordReadings", locale)}
                  triggerVariant="secondary"
                  title={t("dashboard.recordReadings", locale)}
                  description={t("dashboard.recordReadingsHint", locale)}
                  closeLabel={t("ui.close", locale)}
                >
                  <form action={recordDashboardReadings}>
                    <DialogFields columns={2}>
                      {stale.slice(0, STALE_FORM_MAX).map((m) => (
                        <Field key={m.id} label={m.name} htmlFor={`dash-stale-${m.id}`} hint={lastReadingText(m)}>
                          <Input id={`dash-stale-${m.id}`} name={`reading:${m.id}`} type="number" inputMode="decimal" min={0} step="any" />
                        </Field>
                      ))}
                    </DialogFields>
                    <DialogActions cancelLabel={t("common.cancel", locale)}>
                      <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                    </DialogActions>
                  </form>
                </DialogForm>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      {active.length === 0 ? (
        <GetStarted
          icon={<MachinesIcon />}
          title={t("dashboard.noMachinesTitle", locale)}
          hint={t("dashboard.noMachinesHint", locale)}
          action={
            isBoss ? (
              <Link href="/machines/new" className={buttonVariants({ variant: "primary" })}>
                <PlusIcon className="text-lg" />
                {t("dashboard.noMachinesAdd", locale)}
              </Link>
            ) : undefined
          }
          secondaryAction={
            isBoss ? (
              <Link href="/onboarding" className={buttonVariants({ variant: "secondary" })}>
                {t("dashboard.setupOpen", locale)}
              </Link>
            ) : undefined
          }
        />
      ) : null}
    </PageContainer>
  );
}

/** "Groen John Deere, Rooi Massey and 8 more." A sentence, never names then "…,". */
function staleNames(names: string[], locale: Lang): string {
  const shown = names.slice(0, 2).join(", ");
  const more = names.length - 2;
  return more > 0
    ? t("dashboard.namesAndMore", locale).replace("{names}", shown).replace("{n}", String(more))
    : `${shown}.`;
}
