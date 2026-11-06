import Link from "next/link";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { accessibleFarms, checkEntitlement, currentFarmId, effectiveFarmRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { canViewFarmCosts } from "@/lib/cost-visibility";
import { t, type Lang } from "@/lib/i18n";
import { errorMessage } from "@/lib/errors";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { ReportFaultDialog } from "@/components/report-fault-dialog";
// Import from specific modules (not the barrel) so this Server Component stays
// free of the kit's client chunk, see src/components/ui/README.md.
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Flash } from "@/components/ui/flash";
import { Card } from "@/components/ui/card";
import { GetStarted } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { MachinesIcon, PlusIcon } from "@/components/ui/icons";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { meterReading, shortDate } from "@/lib/format";
import { weekdayDayMonth } from "@/lib/month-names";
import { setupSteps } from "@/lib/setup-steps";
import { SETTING_NUMBERS } from "@/lib/settings";
import { MODULE_KEYS, moduleOn } from "@/lib/modules";
import { soft } from "@/lib/supabase/must";
import { loadDashData, type DashMachine } from "@/lib/dashboard/data";
import { computeWidget } from "@/lib/dashboard/compute";
import { defaultLayout } from "@/lib/dashboard/defaults";
import { normalizeLayout } from "@/lib/dashboard/schema";
import type { LayoutItem } from "@/lib/dashboard/layout";
import { WIDGETS, WIDGET_BY_TYPE, widgetBlock, type SourceKey, type WidgetAccess } from "@/lib/dashboard/widgets";
import { WidgetBody } from "@/components/dashboard/widget-body";
import { CustomiseButton, DashboardGrid, type CatalogEntry, type WidgetFrameInfo } from "@/components/dashboard/dashboard-grid";
import { AttentionList, buildAttention } from "./attention";
import { dismissSetupCard, recordDashboardReading, recordDashboardReadings, saveDashboardLayout } from "./actions";

/** The stale-meters dialog is one field per machine; past this it stops being quick. */
const STALE_FORM_MAX = 12;

const SAVED_KEYS: Record<string, string> = {
  reading: "dashboard.readingsSaved",
  readings: "dashboard.readingsSaved",
};

/** The attention list and the header's count read these on every board. */
const ALWAYS: SourceKey[] = ["machines", "service", "faults", "licences", "fines"];

/**
 * The dashboard: a board of widgets each person arranges for themselves, starting from
 * the FLEETWISE board (lib/dashboard/defaults.ts).
 *
 * It is a window onto the other screens, never the only place a number lives: every
 * widget links to the page that shows what it counted (lib/dashboard/widgets.ts). The
 * server reads only what the widgets on the board need, renders each widget's body, and
 * hands the bodies to the grid, which owns only the arrangement.
 */
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
        <UpgradeNotice feature="dashboard" requiredPlan={gate.requiredPlan} currentPlan={gate.plan} locale={locale} />
      </PageContainer>
    );
  }
  const supabase = await createClient();
  // Multi-site (F7): every widget reads the farm the person is acting in. rr_admin
  // (farmId null) keeps its all-farms view, on the FLEETWISE board, not customisable.
  const farmId = await currentFarmId(profile);
  const role = farmId ? ((await effectiveFarmRole(farmId, profile)) ?? profile.role) : profile.role;
  const isBoss = role === "owner" || role === "manager" || role === "rr_admin";
  const [costsVisible, farms, farmRes, tco, fuel, aarto, savedRes] = await Promise.all([
    farmId ? canViewFarmCosts(supabase, farmId) : Promise.resolve(profile.role === "rr_admin"),
    accessibleFarms(profile),
    farmId ? supabase.from("farms").select("name, settings").eq("id", farmId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    checkEntitlement("tco", profile),
    checkEntitlement("fuel", profile),
    checkEntitlement("aarto", profile),
    farmId
      ? supabase.from("dashboard_layouts").select("layout").eq("user_id", profile.id).eq("farm_id", farmId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const farmRow = farmRes.data as { name: string; settings: Record<string, unknown> | null } | null;
  const settings = farmRow?.settings ?? {};
  // A board that cannot be read is not a reason to show nothing: the FLEETWISE board.
  soft(savedRes, "dashboard:layout");

  const access: WidgetAccess = {
    costs: costsVisible,
    features: { tco: tco.allowed, fuel: fuel.allowed, aarto: aarto.allowed },
    modules: Object.fromEntries(MODULE_KEYS.map((m) => [m, moduleOn(settings, m)])),
  };
  const defaults = defaultLayout(role, access);
  const saved = savedRes.data ? normalizeLayout((savedRes.data as { layout: unknown }).layout) : null;
  const items: LayoutItem[] = saved ?? defaults;

  const blockOf = (item: LayoutItem) => {
    const def = WIDGET_BY_TYPE.get(item.type);
    return def ? widgetBlock(def, access) : "plan";
  };
  const needed = new Set<SourceKey>(ALWAYS);
  for (const item of items) if (!blockOf(item)) for (const s of WIDGET_BY_TYPE.get(item.type)!.sources) needed.add(s);
  if (!aarto.allowed) needed.delete("fines");
  const data = await loadDashData(supabase, farmId, needed);

  const staleSetting = settings.stale_reading_days;
  const staleDays = typeof staleSetting === "number" && Number.isFinite(staleSetting) && staleSetting > 0
    ? Math.round(staleSetting)
    : SETTING_NUMBERS.stale_reading_days;
  const attention = buildAttention(data, locale, aarto.allowed);
  const active = data.machines.filter((m) => m.status !== "retired" && m.status !== "sold");
  const metered = active
    .filter((m) => m.meter_type !== "none")
    .sort((a, b) => (a.current_reading_date ?? "").localeCompare(b.current_reading_date ?? "") || a.name.localeCompare(b.name));
  const lastReadingText = (m: DashMachine) =>
    m.current_reading != null && m.current_reading_date
      ? t("dashboard.lastReading", locale)
          .replace("{reading}", meterReading(m.current_reading, m.meter_type, locale))
          .replace("{when}", shortDate(m.current_reading_date, locale))
      : t("dashboard.noReadingYet", locale);

  // == Widget bodies ===========================================================
  const contents: Record<string, ReactNode> = {};
  const frames: Record<string, WidgetFrameInfo> = {};
  for (const item of items) {
    const def = WIDGET_BY_TYPE.get(item.type)!;
    const block = blockOf(item);
    frames[item.id] = {
      title: item.settings.title || t(`dash.w.${item.type}.title`, locale),
      href: def.href(item.settings),
      locked: block ? t(`dash.locked.${block}`, locale) : undefined,
    };
    if (block) continue;
    if (item.type === "attention") {
      contents[item.id] = <AttentionList groups={attention.groups} locale={locale} />;
      continue;
    }
    const computed = computeWidget(item.type, item.settings, data, { locale, staleDays });
    if (!computed) continue;
    const body = <WidgetBody type={item.type} settings={item.settings} data={computed} locale={locale} />;
    contents[item.id] = item.type === "stale_meters" && computed.kind === "list" && computed.rows.length > 0 ? (
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="min-h-0 flex-1">{body}</div>
        <StaleReadingsDialog machines={metered.filter((m) => computed.rows.some((r) => r.key === m.id))} lastReadingText={lastReadingText} locale={locale} />
      </div>
    ) : body;
  }
  const catalog: CatalogEntry[] = WIDGETS.map((w) => {
    const block = widgetBlock(w, access);
    return { type: w.type, category: w.category, blocked: block ? t(`dash.locked.${block}`, locale) : null };
  });

  // == Header ==================================================================
  // Greeting. South Africa is UTC+2 all year, so the hour is derived rather than
  // guessed from a server timezone that is almost certainly UTC.
  const now = data.now;
  const sastHour = new Date(now.getTime() + 2 * 3_600_000).getUTCHours();
  const greetKey = sastHour < 12 ? "dashboard.goodMorning" : sastHour < 18 ? "dashboard.goodAfternoon" : "dashboard.goodEvening";
  const firstName = profile.name.trim().split(/\s+/)[0] || profile.name;
  // Only a one-farm account is told its farm's name here; with more, the switcher says it.
  const farmName = farms.length > 1 ? null : farmRow?.name ?? null;
  // Same rule as /faults: the bosses and the mechanic report on any machine, an operator on their own.
  const reportMachines = active
    .filter((m) => role !== "operator" || m.assigned_operator_id === profile.id)
    .map((m) => ({ id: m.id, name: m.name }));
  const canReport = ["rr_admin", "owner", "manager", "mechanic", "operator"].includes(role) && reportMachines.length > 0;

  // == Set-up progress ========================================================
  let setup: { done: number; total: number; next: ReturnType<typeof setupSteps>[number] } | null = null;
  if (isBoss && farmId && !settings.setup_card_dismissed_at && active.length > 0) {
    const usersRes = await supabase.from("users").select("id", { count: "exact", head: true }).eq("active", true);
    // soft: the card is a nudge, not the board. A failed count is reported and the card left out.
    soft(usersRes, "dashboard:setup-users");
    const steps = setupSteps({
      machines: data.machines.length,
      plans: data.service.length,
      qrLabelsDone: !!settings.qr_labels_printed_at,
      users: usersRes.count ?? 0,
    });
    const next = steps.find((s) => !s.done);
    if (next && !usersRes.error) setup = { done: steps.filter((s) => s.done).length, total: steps.length, next };
  }

  const savedKey = sp.saved ? (SAVED_KEYS[sp.saved] ?? "ui.saved") : null;
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
            <RequestIdInput action="readings:dashboard" />
            <DialogFields columns={1}>
              <Field label={t("dashboard.readingMachine", locale)} htmlFor="dash-reading-machine" required>
                <Select id="dash-reading-machine" name="machine_id" defaultValue={metered[0]?.id} required>
                  {metered.map((m) => (
                    <option key={m.id} value={m.id}>{m.name} · {lastReadingText(m)}</option>
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
      {canReport ? (
        <div className="hidden lg:block">
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
      {farmId && active.length > 0 ? <CustomiseButton locale={locale} /> : null}
    </div>
  );

  return (
    <PageContainer size="wide">
      <PageHeader
        title={t(greetKey, locale).replace("{name}", firstName)}
        infoKey="dashboard"
        locale={locale}
        meta={
          <>
            <span className="capitalize">{weekdayDayMonth(now, locale)}</span>
            {farmName ? <> · {farmName}</> : null}
            {" · "}
            <span className={attention.total > 0 ? "font-medium text-sand-800" : ""}>
              {attention.total === 0
                ? t("dashboard.nothingNeedsYouSub", locale)
                : attention.total === 1
                  ? t("dashboard.oneThingNeedsYou", locale)
                  : t("dashboard.thingsNeedYou", locale).replace("{n}", String(attention.total))}
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
                <span className="font-normal text-sand-600">
                  {" · "}
                  {t("dashboard.setupProgress", locale).replace("{done}", String(setup.done)).replace("{total}", String(setup.total))}
                </span>
              </p>
              <p className="mt-0.5 text-sm text-sand-700">
                {t("dashboard.setupNext", locale).replace("{step}", t(`onboarding.${setup.next.key}Title`, locale))}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link href={setup.next.cta} className={buttonVariants({ variant: "secondary" })}>{t(setup.next.ctaKey, locale)}</Link>
              <Link href="/onboarding" className={buttonVariants({ variant: "ghost" })}>{t("dashboard.setupAll", locale)}</Link>
              <form action={dismissSetupCard}>
                <SubmitButton variant="ghost">{t("dashboard.setupHide", locale)}</SubmitButton>
              </form>
            </div>
          </div>
        </Card>
      ) : null}

      {active.length === 0 ? (
        <GetStarted
          icon={<MachinesIcon />}
          title={t("dashboard.noMachinesTitle", locale)}
          hint={t("dashboard.noMachinesHint", locale)}
          action={isBoss ? (
            <Link href="/machines/new" className={buttonVariants({ variant: "primary" })}>
              <PlusIcon className="text-lg" />
              {t("dashboard.noMachinesAdd", locale)}
            </Link>
          ) : undefined}
          secondaryAction={isBoss ? (
            <Link href="/onboarding" className={buttonVariants({ variant: "secondary" })}>{t("dashboard.setupOpen", locale)}</Link>
          ) : undefined}
        />
      ) : (
        <DashboardGrid
          initial={items}
          defaults={defaults}
          contents={contents}
          frames={frames}
          catalog={catalog}
          canEdit={!!farmId}
          save={saveDashboardLayout}
          locale={locale}
        />
      )}
    </PageContainer>
  );
}

/** Stale meters: the names on the widget, and one dialog to write the numbers down. */
function StaleReadingsDialog({
  machines, lastReadingText, locale,
}: { machines: DashMachine[]; lastReadingText: (m: DashMachine) => string; locale: Lang }) {
  if (machines.length === 0) return null;
  return (
    <DialogForm
      trigger={t("dashboard.recordReadings", locale)}
      triggerVariant="secondary"
      title={t("dashboard.recordReadings", locale)}
      description={t("dashboard.recordReadingsHint", locale)}
      closeLabel={t("ui.close", locale)}
    >
      <form action={recordDashboardReadings}>
        <RequestIdInput action="readings:dashboard-batch" />
        <DialogFields columns={2}>
          {machines.slice(0, STALE_FORM_MAX).map((m) => (
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
  );
}
