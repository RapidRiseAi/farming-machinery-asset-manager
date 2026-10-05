import Link from "next/link";
import { errorMessage } from "@/lib/errors";
import { checkEntitlement, currentFarmId, effectiveFarmRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { canViewFarmCosts } from "@/lib/cost-visibility";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { meterLabel } from "@/lib/machine-options";
import {
  FUEL_ACTIVITIES,
  FUEL_FARM_LEVEL,
  activityLabel,
  computeConsumption,
  formatConsumption,
  latestInterval,
  type FuelIssueRow,
} from "@/lib/fuel";
import { addFuelTank, addFuelDelivery, addFuelIssue, addFuelDip } from "./actions";
import { FuelTrend } from "@/components/fuel-trend";
import { FuelDrawMachineFields, type FuelDrawMachine } from "@/components/fuel/fuel-draw-machine-fields";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat, StatGrid } from "@/components/ui/stat";
import { StatusBadge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { GetStarted } from "@/components/ui/empty-state";
import { Fact, FactList } from "@/components/ui/facts";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { FuelIcon, PlusIcon } from "@/components/ui/icons";
import { DialogActions, DialogFields, DialogForm, DialogSection } from "@/components/ui/dialog-form";
import { meterReading, num, shortDate, todayLocal } from "@/lib/format";

export const dynamic = "force-dynamic";

type Tank = { id: string; name: string; capacity_l: number | null };
type Machine = {
  id: string; name: string; meter_type: string; status: string;
  current_reading: number | null; current_reading_date: string | null;
};
type Delivery = { id: string; tank_id: string; date: string; litres: number | null; price_per_l_cents: number | null; supplier: string | null; invoice_no: string | null };
type Issue = {
  id: string; tank_id: string; machine_id: string | null; date: string; litres: number | null;
  meter_reading: number | null; cost_cents: number | null; activity: string | null;
  anomaly_notified_at: string | null; driver_name: string | null; by_user: string | null;
};
type Op = { id: string; name: string };
/** One row of `public.fuel_tank_balances`: litres only, counted from every row. */
type TankBalance = {
  tank_id: string;
  delivered_litres: number;
  issued_litres: number;
  balance_litres: number;
  dipped_on: string | null;
  dip_litres: number | null;
  book_at_dip_litres: number | null;
};

/** A tank below this share of its capacity says so in words. */
const LOW_TANK_PCT = 15;

export default async function FuelPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; machine?: string }>;
}) {
  // Fuel is a Professional+ feature (FR-19.2 mapping). Deny server-side for under-plan
  // farms, fuel data is never fetched; an upgrade prompt shows instead.
  const gate = await checkEntitlement("fuel");
  const profile = gate.profile;
  const locale = profile.lang;
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const L = t("fuel.litresShort", locale);
  // U+00A0 keeps "1 427 L" on one line; num() already groups with a no-break space.
  const litres = (n: number | null | undefined) => `${num(n ?? 0, 0)} ${L}`;
  if (!gate.allowed) {
    return (
      <PageContainer size="wide">
        <PageHeader title={t("nav.fuel", locale)} infoKey="fuel" locale={locale} />
        <UpgradeNotice
          feature="fuel"
          requiredPlan={gate.requiredPlan}
          currentPlan={gate.plan}
          locale={locale}
        />
      </PageContainer>
    );
  }
  const sp = await searchParams;
  const supabase = await createClient();
  const farmId = await currentFarmId(profile);
  const resourceRole = farmId ? await effectiveFarmRole(farmId, profile) : null;
  const canManage = resourceRole === "owner" || resourceRole === "manager";
  const canDraw = resourceRole != null && ["owner", "manager", "mechanic", "operator"].includes(resourceRole);
  const costsVisible = farmId ? await canViewFarmCosts(supabase, farmId) : profile.role === "rr_admin";
  const byFarm = <Q,>(q: Q): Q => farmId ? (q as { eq(c: string, v: string): Q }).eq("farm_id", farmId) : q;

  const [tankRes, machineRes, delRes, issRes, opRes, balRes] = await Promise.all([
    byFarm(supabase.from("fuel_tanks").select("id, name, capacity_l").is("deleted_at", null).order("name")),
    byFarm(supabase.from("machines").select("id, name, meter_type, status, current_reading, current_reading_date").is("deleted_at", null).order("name")),
    byFarm(supabase.from("fuel_deliveries_visible").select("id, tank_id, date, litres, price_per_l_cents, supplier, invoice_no").is("deleted_at", null).order("date", { ascending: false }).limit(400)),
    byFarm(supabase.from("fuel_issues_visible").select("id, tank_id, machine_id, date, litres, meter_reading, cost_cents, activity, anomaly_notified_at, driver_name, by_user").is("deleted_at", null).order("date", { ascending: false }).limit(600)),
    supabase.from("users").select("id, name").eq("active", true).is("deleted_at", null).order("name"),
    // The tank cards, counted in the database from every delivery and draw (20261005122000).
    // The two lists above are capped, and for an operator the draws are only their own
    // machines', so a balance summed from them was short of rows or simply wrong.
    supabase.rpc("fuel_tank_balances", { p_farm: farmId }),
  ]);

  const tanks = (tankRes.data as Tank[] | null) ?? [];
  // A failed read must not draw every tank as empty: "0 L" is an answer, and a wrong one.
  if (balRes.error) throw new Error("Tank balances are temporarily unavailable.");
  const balByTank = new Map(((balRes.data as TankBalance[] | null) ?? []).map((b) => [b.tank_id, b]));
  const machinesAll = (machineRes.data as Machine[] | null) ?? [];
  const machines = machinesAll.filter((m) => m.status !== "retired" && m.status !== "sold");
  const deliveries = (delRes.data as Delivery[] | null) ?? [];
  const issues = (issRes.data as Issue[] | null) ?? [];
  const operators = (opRes.data as Op[] | null) ?? [];

  const tankName = new Map(tanks.map((tk) => [tk.id, tk.name]));
  const machineName = new Map(machinesAll.map((m) => [m.id, m.name]));
  const machineMeter = new Map(machinesAll.map((m) => [m.id, m.meter_type]));
  const opName = new Map(operators.map((o) => [o.id, o.name]));

  // == Smart defaults for "Diesel went out" =====================================
  // Most draws are the same person filling the same machine from the same tank as last
  // time, so start there. Never "Whole farm": a draw booked to no machine never reaches
  // consumption per machine, so with no history the machine opens on a placeholder.
  const activeIds = new Set(machines.map((m) => m.id));
  const myLastDraw = issues.find((i) => i.by_user === profile.id) ?? null;
  const askedMachine = sp.machine && activeIds.has(sp.machine) ? sp.machine : null;
  const lastMachine = myLastDraw?.machine_id && activeIds.has(myLastDraw.machine_id) ? myLastDraw.machine_id : null;
  const defaultMachineId = askedMachine ?? lastMachine ?? (machines.length === 1 ? machines[0].id : "");
  const defaultTankId =
    myLastDraw && tankName.has(myLastDraw.tank_id) ? myLastDraw.tank_id : (tanks[0]?.id ?? "");
  const today = todayLocal();

  // The reference reading under the meter box: the machine's own latest reading, or the
  // last metered draw when the machine has none on file.
  const lastMeteredDraw = new Map<string, Issue>();
  for (const i of issues) {
    if (i.machine_id && i.meter_reading != null && !lastMeteredDraw.has(i.machine_id)) lastMeteredDraw.set(i.machine_id, i);
  }
  const drawMachines: FuelDrawMachine[] = machines.map((m) => {
    const fromDraw = lastMeteredDraw.get(m.id);
    const reading = m.current_reading ?? fromDraw?.meter_reading ?? null;
    const on = m.current_reading != null ? m.current_reading_date : (fromDraw?.date ?? null);
    const metered = m.meter_type === "hours" || m.meter_type === "km";
    const readingText = reading != null ? meterReading(reading, m.meter_type, locale) : null;
    return {
      id: m.id,
      name: m.name,
      lastReading: reading,
      metered,
      lastText: readingText
        ? on
          ? t("fuel.lastReading", locale).replace("{reading}", readingText).replace("{date}", shortDate(on, locale))
          : t("fuel.lastReadingNoDate", locale).replace("{reading}", readingText)
        : null,
    };
  });

  // == This month, not all time ================================================
  // The four tiles that used to open this page summed whatever the capped queries
  // returned, with no period. A month is a number somebody can hold against a statement.
  const month = today.slice(0, 7);
  const inMonth = (d: string) => d.slice(0, 7) === month;
  const monthIssues = issues.filter((i) => inMonth(i.date));
  const monthOut = monthIssues.reduce((a, i) => a + (i.litres ?? 0), 0);
  const monthCost = monthIssues.reduce((a, i) => a + (i.cost_cents ?? 0), 0);
  const monthIn = deliveries.filter((d) => inMonth(d.date)).reduce((a, d) => a + (d.litres ?? 0), 0);
  const myMonthOut = monthIssues.filter((i) => i.by_user === profile.id).reduce((a, i) => a + (i.litres ?? 0), 0);


  // Per-machine consumption (interval method), machines with any metered draws.
  const issuesByMachine = new Map<string, FuelIssueRow[]>();
  for (const i of issues) {
    if (!i.machine_id) continue;
    const arr = issuesByMachine.get(i.machine_id) ?? [];
    arr.push({ id: i.id, date: i.date, litres: i.litres, meter_reading: i.meter_reading, cost_cents: i.cost_cents });
    issuesByMachine.set(i.machine_id, arr);
  }
  const consumption = [...issuesByMachine.entries()]
    .map(([mid, rows]) => ({
      machineId: mid,
      name: machineName.get(mid) ?? t("fines.unknownVehicle", locale),
      meterType: machineMeter.get(mid) ?? "none",
      litres: rows.reduce((a, r) => a + (r.litres ?? 0), 0),
      c: computeConsumption(rows, machineMeter.get(mid) ?? "none"),
    }))
    .sort((a, b) => (b.c.display ?? -1) - (a.c.display ?? -1) || b.litres - a.litres);

  // Flagged draws (anomalies), most recent first.
  const anomalies = issues
    .filter((i) => i.anomaly_notified_at != null && i.machine_id != null)
    .slice(0, 10);

  const draweeLabel = (i: Issue) =>
    (i.by_user ? opName.get(i.by_user) : null) ?? i.driver_name ?? "";

  /** One tank needs no choosing: say which it is and post it hidden. */
  const tankField = (id: string, defaultValue: string) =>
    tanks.length === 1 ? (
      <div className="sm:col-span-2">
        <input type="hidden" name="tank_id" value={tanks[0].id} />
        <FactList>
          <Fact label={t("fuel.tank", locale)} value={tanks[0].name} />
        </FactList>
      </div>
    ) : (
      <Field label={t("fuel.tank", locale)} htmlFor={id}>
        <Select id={id} name="tank_id" required defaultValue={defaultValue}>
          {tanks.map((tk) => (
            <option key={tk.id} value={tk.id}>{tk.name}</option>
          ))}
        </Select>
      </Field>
    );

  const addTankDialog = (primary: boolean) =>
    canManage ? (
      <DialogForm
        trigger={t("fuel.addTank", locale)}
        triggerVariant={primary ? "primary" : "secondary"}
        triggerSize={primary ? "md" : "sm"}
        triggerIcon={primary ? <PlusIcon /> : undefined}
        title={t("fuel.addTank", locale)}
        closeLabel={closeLabel}
        size="md"
      >
        <form action={addFuelTank}>
          <DialogFields>
            <Field label={t("fuel.tankName", locale)} htmlFor="t_name" required>
              <Input id="t_name" name="name" required />
            </Field>
            <Field label={t("fuel.capacityL", locale)} htmlFor="t_cap">
              <Input id="t_cap" name="capacity_l" type="number" inputMode="decimal" step="1" />
            </Field>
          </DialogFields>
          <DialogActions cancelLabel={cancelLabel}>
            <SubmitButton variant="primary">{t("fuel.add", locale)}</SubmitButton>
          </DialogActions>
        </form>
      </DialogForm>
    ) : null;

  /*
    The two things this screen is opened to DO, as buttons.

    They were two cards of eight and six fields, side by side above the tank balance, so
    the page opened on fourteen empty boxes and the reconciliation it exists to show
    started below the fold. Both are still one tap away, and the dialog names which one
    you are in: "Tank", "Litres", "Cost" and "Date" appear in both.
  */
  const headerActions =
    tanks.length > 0 && (canDraw || canManage) ? (
      <>
        {canDraw ? (
          <DialogForm
            trigger={t("fuel.logDraw", locale)}
            triggerIcon={<PlusIcon />}
            title={t("fuel.logDraw", locale)}
            description={t("fuel.logDrawDesc", locale)}
            closeLabel={closeLabel}
          >
            <form action={addFuelIssue}>
              <DialogFields>
                <FuelDrawMachineFields
                  machines={drawMachines}
                  defaultMachineId={defaultMachineId}
                  farmValue={FUEL_FARM_LEVEL}
                  labels={{
                    machine: t("fuel.machine", locale),
                    placeholder: t("fuel.selectMachine", locale),
                    farmLevel: t("fuel.farmLevel", locale),
                    meter: t("fuel.meter", locale),
                    meterLower: t("fuel.meterLower", locale),
                  }}
                />
                <Field label={t("fuel.litres", locale)} htmlFor="i_litres" required>
                  <Input id="i_litres" name="litres" type="number" inputMode="decimal" step="0.1" min={0} required />
                </Field>
                {tankField("i_tank", defaultTankId)}
                {/* Cost is a farm figure: nobody is asked for one they are not shown. */}
                {costsVisible ? (
                  <Field label={t("fuel.cost", locale)} htmlFor="i_cost">
                    <Input id="i_cost" name="cost" inputMode="decimal" placeholder="R" />
                  </Field>
                ) : null}
                <DialogSection title={t("fuel.moreDetails", locale)}>
                  <Field label={t("fuel.date", locale)} htmlFor="i_date">
                    <Input id="i_date" name="date" type="date" defaultValue={today} max={today} />
                  </Field>
                  {operators.length > 0 ? (
                    <Field label={t("fuel.driver", locale)} htmlFor="i_driver">
                      <Select id="i_driver" name="driver_user_id" defaultValue="">
                        <option value="">{profile.name}</option>
                        {operators.filter((op) => op.id !== profile.id).map((op) => (
                          <option key={op.id} value={op.id}>{op.name}</option>
                        ))}
                      </Select>
                    </Field>
                  ) : null}
                  <Field label={t("fuel.activityLabel", locale)} htmlFor="i_activity">
                    <Select id="i_activity" name="activity" defaultValue="">
                      <option value="">{t("fuel.activityNone", locale)}</option>
                      {FUEL_ACTIVITIES.map((a) => (
                        <option key={a} value={a}>{activityLabel(a, locale)}</option>
                      ))}
                    </Select>
                  </Field>
                </DialogSection>
              </DialogFields>
              <DialogActions cancelLabel={cancelLabel}>
                <SubmitButton variant="primary">{t("fuel.log", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
        ) : null}

        {canManage ? (
          <DialogForm
            trigger={t("fuel.logFill", locale)}
            triggerVariant="secondary"
            title={t("fuel.logFill", locale)}
            description={t("fuel.logFillDesc", locale)}
            closeLabel={closeLabel}
          >
            <form action={addFuelDelivery}>
              <DialogFields>
                {tankField("d_tank", defaultTankId)}
                <Field label={t("fuel.litres", locale)} htmlFor="d_litres" required>
                  <Input id="d_litres" name="litres" type="number" inputMode="decimal" step="0.1" min={0} required />
                </Field>
                <Field label={t("fuel.date", locale)} htmlFor="d_date">
                  <Input id="d_date" name="date" type="date" defaultValue={today} max={today} />
                </Field>
                <Field label={t("fuel.cost", locale)} htmlFor="d_cost">
                  <Input id="d_cost" name="cost" inputMode="decimal" placeholder="R" />
                </Field>
                <Field label={t("fuel.supplier", locale)} htmlFor="d_supplier">
                  <Input id="d_supplier" name="supplier" />
                </Field>
                <Field label={t("fuel.invoiceNo", locale)} htmlFor="d_invoice">
                  <Input id="d_invoice" name="invoice_no" />
                </Field>
              </DialogFields>
              <DialogActions cancelLabel={cancelLabel}>
                <SubmitButton variant="primary">{t("fuel.log", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
        ) : null}
      </>
    ) : undefined;

  return (
    <PageContainer size="wide">
      <PageHeader
        title={t("fuel.title", locale)}
        lead={t("fuel.subtitle", locale)}
        infoKey="fuel"
        locale={locale}
        actions={headerActions}
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      {tanks.length === 0 ? (
        // No tank means no delivery and no draw can exist yet, so the empty screen is one
        // sentence and one button, not zero tiles above a card repeating the sentence.
        <GetStarted
          icon={<FuelIcon />}
          title={t("fuel.noTanksTitle", locale)}
          hint={t("fuel.noTanks", locale)}
          action={addTankDialog(true)}
        />
      ) : (
        <>
          {/* == The answer: what is in each tank ============================== */}
          <section aria-labelledby="fuel-tanks" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="fuel-tanks" className="text-base font-semibold text-sand-900">
                {t("fuel.reconciliation", locale)}
              </h2>
              {/* Measuring the tank is the same person at the same bowser as drawing from it. */}
              <div className="flex flex-wrap items-center gap-2">
                {canDraw ? (
                  <DialogForm
                    trigger={t("fuel.addDip", locale)}
                    triggerVariant="secondary"
                    triggerSize="sm"
                    title={t("fuel.addDip", locale)}
                    description={t("fuel.dipHint", locale)}
                    closeLabel={closeLabel}
                    size="md"
                  >
                    <form action={addFuelDip}>
                      <DialogFields>
                        {tankField("dip_tank", defaultTankId)}
                        <Field label={t("fuel.dipLitres", locale)} htmlFor="dip_litres" required>
                          <Input id="dip_litres" name="litres" type="number" inputMode="decimal" step="0.1" min={0} required />
                        </Field>
                        <Field label={t("fuel.dipDate", locale)} htmlFor="dip_date">
                          <Input id="dip_date" name="dipped_on" type="date" defaultValue={today} max={today} />
                        </Field>
                        <Field label={t("fuel.dipNote", locale)} htmlFor="dip_note">
                          <Input id="dip_note" name="note" maxLength={300} />
                        </Field>
                      </DialogFields>
                      <DialogActions cancelLabel={cancelLabel}>
                        <SubmitButton variant="primary">{t("fuel.addDipSubmit", locale)}</SubmitButton>
                      </DialogActions>
                    </form>
                  </DialogForm>
                ) : null}
                {addTankDialog(false)}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {tanks.map((tk) => {
                const b = balByTank.get(tk.id);
                const delivered = Number(b?.delivered_litres ?? 0);
                const issued = Number(b?.issued_litres ?? 0);
                const bal = Number(b?.balance_litres ?? 0);
                const cap = tk.capacity_l && tk.capacity_l > 0 ? tk.capacity_l : null;
                const pct = cap ? Math.round((Math.max(0, bal) / cap) * 100) : null;
                const low = pct != null && pct < LOW_TANK_PCT;

                // The stick in the tank, against what the books said on THAT day: comparing
                // with today would count every draw since as missing. A short measurement is
                // diesel that left without a draw being logged: a leak, or somebody's
                // jerrycan. It is reported, never adjusted away.
                const dippedOn = b?.dipped_on ?? null;
                let dipFact: { value: string; short: boolean; variance: string } | null = null;
                if (dippedOn && b?.dip_litres != null && b.book_at_dip_litres != null) {
                  const variance = Number(b.dip_litres) - Number(b.book_at_dip_litres);
                  const short = variance < -0.5;
                  dipFact = {
                    value: litres(Number(b.dip_litres)),
                    short,
                    variance: t(short ? "fuel.varianceShort" : "fuel.variance", locale)
                      .replace("{n}", num(Math.abs(variance), 0)),
                  };
                }

                return (
                  <Card key={tk.id}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <CardTitle>{tk.name}</CardTitle>
                      {low ? (
                        <StatusBadge tone="warning" shape="triangle" label={t("fuel.runningLow", locale)} />
                      ) : null}
                    </div>
                    <p className="mt-3 text-xs font-medium uppercase tracking-wide text-sand-500">
                      {t("fuel.balance", locale)}
                    </p>
                    <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums text-sand-900">
                      {litres(bal)}
                    </p>
                    {cap && pct != null ? (
                      <div className="mt-3">
                        <div className="h-2 overflow-hidden rounded-full bg-sand-100" aria-hidden>
                          <div
                            className={`h-2 rounded-full ${low ? "bg-status-due" : "bg-brand-500"}`}
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                        <p className="mt-1 text-xs tabular-nums text-sand-600">
                          {t("fuel.ofCapacity", locale)
                            .replace("{n}", num(Math.max(0, bal), 0))
                            .replace("{cap}", num(cap, 0))
                            .replace("{pct}", String(pct))}
                        </p>
                      </div>
                    ) : null}
                    <FactList className="mt-3 border-t border-sand-100">
                      <Fact label={t("fuel.delivered", locale)} value={<span className="tabular-nums">{litres(delivered)}</span>} />
                      <Fact label={t("fuel.issued", locale)} value={<span className="tabular-nums">{litres(issued)}</span>} />
                      {dippedOn && dipFact ? (
                        <Fact
                          label={t("fuel.dipOn", locale).replace("{date}", shortDate(dippedOn, locale))}
                          value={<span className="tabular-nums">{dipFact.value}</span>}
                          hint={
                            dipFact.short ? (
                              <StatusBadge tone="danger" shape="square" label={dipFact.variance} wrap className="mt-1" />
                            ) : (
                              dipFact.variance
                            )
                          }
                        />
                      ) : null}
                    </FactList>
                  </Card>
                );
              })}
            </div>
            <p className="text-xs text-sand-500">{t("fuel.balanceHint", locale)}</p>
          </section>

          {/* == This month ===================================================== */}
          {canManage ? (
            <StatGrid columns={costsVisible ? 3 : 2}>
              <Stat label={t("fuel.monthOut", locale)} value={litres(monthOut)} valueClassName="text-xl sm:text-3xl" />
              <Stat label={t("fuel.monthIn", locale)} value={litres(monthIn)} valueClassName="text-xl sm:text-3xl" />
              {costsVisible ? (
                <Stat label={t("fuel.monthCost", locale)} value={rands(monthCost)} valueClassName="text-xl sm:text-3xl" />
              ) : null}
            </StatGrid>
          ) : (
            <StatGrid columns={2}>
              <Stat label={t("fuel.yourMonth", locale)} value={litres(myMonthOut)} valueClassName="text-xl sm:text-3xl" />
              <Stat label={t("fuel.monthOut", locale)} value={litres(monthOut)} valueClassName="text-xl sm:text-3xl" />
            </StatGrid>
          )}

          {/* Consumption per machine */}
          <Card>
            <CardHeader><CardTitle>{t("fuel.consumptionTitle", locale)}</CardTitle></CardHeader>
            {consumption.length === 0 ? (
              <p className="text-sm text-sand-500">{t("fuel.noConsumption", locale)}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-sand-100">
                {consumption.map((row) => {
                  const latest = latestInterval(row.c.trend);
                  return (
                    <li key={row.machineId} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <Link href={`/machines/${row.machineId}`} className="focus-ring rounded font-medium text-brand-ink hover:underline">{row.name}</Link>
                        <p className="text-xs text-sand-500">
                          {meterLabel(row.meterType, locale)} · {litres(row.litres)}
                          {row.c.intervals > 0 ? ` · ${num(row.c.intervals, 0)} ${t("fuel.intervals", locale)}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-4">
                        {row.c.trend.length > 1 ? (
                          <div className="w-28">
                            <FuelTrend
                              trend={row.c.trend}
                              unit={row.meterType === "km" ? t("fuel.perKm", locale) : t("fuel.perHr", locale)}
                              title={t("fuel.trend", locale)}
                              locale={locale}
                            />
                          </div>
                        ) : null}
                        <div className="flex w-28 flex-col items-end gap-1 text-right">
                          <span className="font-semibold tabular-nums text-sand-900">
                            {row.c.display != null ? formatConsumption(row.c, locale) : t("fuel.needMoreData", locale)}
                          </span>
                          {latest?.high ? (
                            <StatusBadge tone="danger" shape="triangle" label={t("fuel.highLatest", locale)} />
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* Anomalies */}
          <Card>
            <CardHeader><CardTitle>{t("fuel.anomalies", locale)}</CardTitle></CardHeader>
            <p className="-mt-2 mb-2 text-sm text-sand-500">{t("fuel.anomalyHint", locale)}</p>
            {anomalies.length === 0 ? (
              <p className="text-sm text-sand-500">{t("fuel.noAnomalies", locale)}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-sand-100 text-sm">
                {anomalies.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
                    <span className="min-w-0">
                      <Link href={`/machines/${i.machine_id}`} className="focus-ring rounded font-medium text-brand-ink hover:underline">{machineName.get(i.machine_id ?? "") ?? t("fines.unknownVehicle", locale)}</Link>
                      <span className="ml-2 tabular-nums text-sand-500">
                        {i.meter_reading != null
                          ? t("fuel.litresAt", locale)
                              .replace("{litres}", litres(i.litres))
                              .replace("{reading}", meterReading(i.meter_reading, machineMeter.get(i.machine_id ?? ""), locale))
                          : litres(i.litres)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-xs tabular-nums text-sand-500">{shortDate(i.date, locale)}</span>
                      <StatusBadge tone="danger" shape="triangle" label={t("fuel.flagged", locale)} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Recent deliveries + draws */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>{t("fuel.deliveries", locale)}</CardTitle></CardHeader>
              {deliveries.length === 0 ? (
                <p className="text-sm text-sand-500">{t("fuel.noDeliveries", locale)}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-sand-100 text-sm">
                  {deliveries.slice(0, 12).map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="min-w-0 truncate">
                        <span className="font-medium tabular-nums text-sand-800">{litres(d.litres)}</span>
                        <span className="text-sand-500"> · {tankName.get(d.tank_id) ?? t("fuel.tank", locale)}{d.supplier ? ` · ${d.supplier}` : ""}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-sand-500">
                        {costsVisible && d.price_per_l_cents != null ? <span className="tabular-nums">{rands(Math.round((d.litres ?? 0) * d.price_per_l_cents))}</span> : null}
                        <span className="tabular-nums">{shortDate(d.date, locale)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <CardHeader><CardTitle>{t("fuel.draws", locale)}</CardTitle></CardHeader>
              {issues.length === 0 ? (
                <p className="text-sm text-sand-500">{t("fuel.noDraws", locale)}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-sand-100 text-sm">
                  {issues.slice(0, 12).map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="min-w-0 truncate">
                        <span className="font-medium tabular-nums text-sand-800">{litres(i.litres)}</span>
                        <span className="text-sand-500"> · {i.machine_id ? (machineName.get(i.machine_id) ?? t("fines.unknownVehicle", locale)) : t("fuel.farmLevel", locale)}{i.activity ? ` · ${activityLabel(i.activity, locale)}` : ""}{draweeLabel(i) ? ` · ${draweeLabel(i)}` : ""}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-sand-500">
                        {costsVisible && i.cost_cents != null ? <span className="tabular-nums">{rands(i.cost_cents)}</span> : null}
                        {i.anomaly_notified_at ? <StatusBadge tone="danger" shape="triangle" label={t("fuel.flagged", locale)} /> : null}
                        <span className="tabular-nums">{shortDate(i.date, locale)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </PageContainer>
  );
}
