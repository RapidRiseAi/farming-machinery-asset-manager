import Link from "next/link";
import { checkEntitlement } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { meterLabel } from "@/lib/machine-options";
import {
  FUEL_ACTIVITIES,
  activityLabel,
  computeConsumption,
  formatConsumption,
  type FuelIssueRow,
} from "@/lib/fuel";
import { addFuelTank, addFuelDelivery, addFuelIssue } from "./actions";
import { FuelTrend } from "@/components/fuel-trend";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { EmptyState } from "@/components/ui/empty-state";
import { FuelIcon } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

type Tank = { id: string; name: string; capacity_l: number | null };
type Machine = { id: string; name: string; meter_type: string };
type Delivery = { id: string; tank_id: string; date: string; litres: number | null; price_per_l_cents: number | null; supplier: string | null; invoice_no: string | null };
type Issue = {
  id: string; tank_id: string; machine_id: string | null; date: string; litres: number | null;
  meter_reading: number | null; cost_cents: number | null; activity: string | null;
  anomaly_notified_at: string | null; driver_name: string | null; by_user: string | null;
};
type Op = { id: string; name: string };

export default async function FuelPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  // Fuel is a Professional+ feature (FR-19.2 mapping). Deny server-side for under-plan
  // farms — fuel data is never fetched; an upgrade prompt shows instead.
  const gate = await checkEntitlement("fuel");
  const profile = gate.profile;
  const locale = profile.language;
  if (!gate.allowed) {
    return (
      <div className="flex flex-col gap-5">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("nav.fuel", locale)}</h1>
        <UpgradeNotice
          feature="fuel"
          requiredPlan={gate.requiredPlan}
          currentPlan={gate.plan}
          locale={locale}
        />
      </div>
    );
  }
  const sp = await searchParams;
  const canManage = profile.role === "owner" || profile.role === "manager";
  const canDraw = ["owner", "manager", "mechanic", "operator"].includes(profile.role);
  const supabase = await createClient();

  const [tankRes, machineRes, delRes, issRes, opRes] = await Promise.all([
    supabase.from("fuel_tanks").select("id, name, capacity_l").is("deleted_at", null).order("name"),
    supabase.from("machines").select("id, name, meter_type, status").is("deleted_at", null).order("name"),
    supabase.from("fuel_deliveries").select("id, tank_id, date, litres, price_per_l_cents, supplier, invoice_no").is("deleted_at", null).order("date", { ascending: false }).limit(400),
    supabase.from("fuel_issues").select("id, tank_id, machine_id, date, litres, meter_reading, cost_cents, activity, anomaly_notified_at, driver_name, by_user").is("deleted_at", null).order("date", { ascending: false }).limit(600),
    supabase.from("users").select("id, name").eq("active", true).is("deleted_at", null).order("name"),
  ]);

  const tanks = (tankRes.data as Tank[] | null) ?? [];
  const machinesAll = (machineRes.data as (Machine & { status: string })[] | null) ?? [];
  const machines = machinesAll.filter((m) => m.status !== "retired" && m.status !== "sold");
  const deliveries = (delRes.data as Delivery[] | null) ?? [];
  const issues = (issRes.data as Issue[] | null) ?? [];
  const operators = (opRes.data as Op[] | null) ?? [];

  const tankName = new Map(tanks.map((tk) => [tk.id, tk.name]));
  const machineName = new Map(machinesAll.map((m) => [m.id, m.name]));
  const machineMeter = new Map(machinesAll.map((m) => [m.id, m.meter_type]));
  const opName = new Map(operators.map((o) => [o.id, o.name]));

  // Spend: purchased (deliveries, ex-VAT) vs used by machines (issues cost, ex-VAT).
  const litresDelivered = deliveries.reduce((a, d) => a + (d.litres ?? 0), 0);
  const costPurchased = deliveries.reduce((a, d) => a + Math.round((d.litres ?? 0) * (d.price_per_l_cents ?? 0)), 0);
  const litresIssued = issues.reduce((a, i) => a + (i.litres ?? 0), 0);
  const costUsed = issues.reduce((a, i) => a + (i.cost_cents ?? 0), 0);

  // Per-tank balance (deliveries − draws).
  const balByTank = new Map<string, { delivered: number; issued: number }>();
  for (const tk of tanks) balByTank.set(tk.id, { delivered: 0, issued: 0 });
  for (const d of deliveries) { const b = balByTank.get(d.tank_id); if (b) b.delivered += d.litres ?? 0; }
  for (const i of issues) { const b = balByTank.get(i.tank_id); if (b) b.issued += i.litres ?? 0; }

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
      name: machineName.get(mid) ?? "—",
      meterType: machineMeter.get(mid) ?? "none",
      litres: rows.reduce((a, r) => a + (r.litres ?? 0), 0),
      c: computeConsumption(rows, machineMeter.get(mid) ?? "none"),
    }))
    .sort((a, b) => (b.c.display ?? -1) - (a.c.display ?? -1) || b.litres - a.litres);

  // Flagged draws (anomalies) — most recent first.
  const anomalies = issues
    .filter((i) => i.anomaly_notified_at != null && i.machine_id != null)
    .slice(0, 10);

  const draweeLabel = (i: Issue) =>
    (i.by_user ? opName.get(i.by_user) : null) ?? i.driver_name ?? "";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("fuel.title", locale)}</h1>
          <p className="mt-0.5 text-sm text-sand-500">{t("fuel.subtitle", locale)}</p>
        </div>
      </div>

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      {/* Spend summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("fuel.purchased", locale)} value={rands(costPurchased)} />
        <Stat label={`${t("fuel.delivered", locale)} (${t("fuel.litresShort", locale)})`} value={litresDelivered.toLocaleString("en-ZA", { maximumFractionDigits: 0 })} />
        <Stat label={t("fuel.attributed", locale)} value={rands(costUsed)} />
        <Stat label={`${t("fuel.issued", locale)} (${t("fuel.litresShort", locale)})`} value={litresIssued.toLocaleString("en-ZA", { maximumFractionDigits: 0 })} />
      </div>

      {tanks.length === 0 ? (
        <EmptyState
          icon={<FuelIcon />}
          title={t("fuel.noTanks", locale)}
        />
      ) : null}

      {/* Capture: draw + delivery */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {canDraw && tanks.length > 0 ? (
          <Card>
            <CardHeader><CardTitle>{t("fuel.logDraw", locale)}</CardTitle></CardHeader>
            <p className="-mt-2 mb-3 text-sm text-sand-500">{t("fuel.logDrawDesc", locale)}</p>
            <form action={addFuelIssue} className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t("fuel.machine", locale)} htmlFor="i_machine">
                  <Select id="i_machine" name="machine_id" defaultValue="">
                    <option value="">{t("fuel.farmLevel", locale)}</option>
                    {machines.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("fuel.tank", locale)} htmlFor="i_tank">
                  <Select id="i_tank" name="tank_id" required defaultValue={tanks[0]?.id ?? ""}>
                    {tanks.map((tk) => (
                      <option key={tk.id} value={tk.id}>{tk.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("fuel.litres", locale)} htmlFor="i_litres">
                  <Input id="i_litres" name="litres" type="number" inputMode="decimal" step="0.1" required />
                </Field>
                <Field label={t("fuel.meter", locale)} htmlFor="i_meter">
                  <Input id="i_meter" name="meter_reading" type="number" inputMode="decimal" step="0.1" />
                </Field>
                <Field label={t("fuel.cost", locale)} htmlFor="i_cost">
                  <Input id="i_cost" name="cost" inputMode="decimal" placeholder="R" />
                </Field>
                <Field label={t("fuel.date", locale)} htmlFor="i_date">
                  <Input id="i_date" name="date" type="date" />
                </Field>
                {operators.length > 0 ? (
                  <Field label={t("fuel.driver", locale)} htmlFor="i_driver">
                    <Select id="i_driver" name="driver_user_id" defaultValue="">
                      <option value="">{profile.name}</option>
                      {operators.map((op) => (
                        <option key={op.id} value={op.id}>{op.name}</option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                <Field label={t("fuel.activityLabel", locale)} htmlFor="i_activity">
                  <Select id="i_activity" name="activity" defaultValue="">
                    <option value="">—</option>
                    {FUEL_ACTIVITIES.map((a) => (
                      <option key={a} value={a}>{activityLabel(a, locale)}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <SubmitButton variant="primary" className="self-start">{t("fuel.log", locale)}</SubmitButton>
            </form>
          </Card>
        ) : null}

        {canManage && tanks.length > 0 ? (
          <Card>
            <CardHeader><CardTitle>{t("fuel.logFill", locale)}</CardTitle></CardHeader>
            <p className="-mt-2 mb-3 text-sm text-sand-500">{t("fuel.logFillDesc", locale)}</p>
            <form action={addFuelDelivery} className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t("fuel.tank", locale)} htmlFor="d_tank">
                  <Select id="d_tank" name="tank_id" required defaultValue={tanks[0]?.id ?? ""}>
                    {tanks.map((tk) => (
                      <option key={tk.id} value={tk.id}>{tk.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("fuel.date", locale)} htmlFor="d_date">
                  <Input id="d_date" name="date" type="date" />
                </Field>
                <Field label={t("fuel.litres", locale)} htmlFor="d_litres">
                  <Input id="d_litres" name="litres" type="number" inputMode="decimal" step="0.1" required />
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
              </div>
              <SubmitButton variant="primary" className="self-start">{t("fuel.log", locale)}</SubmitButton>
            </form>
          </Card>
        ) : null}
      </div>

      {/* Tank balance + add tank */}
      <Card>
        <CardHeader><CardTitle>{t("fuel.reconciliation", locale)}</CardTitle></CardHeader>
        {tanks.length === 0 ? (
          <p className="text-sm text-sand-500">{t("fuel.noTanks", locale)}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-sand-100 text-sm">
            {tanks.map((tk) => {
              const b = balByTank.get(tk.id) ?? { delivered: 0, issued: 0 };
              const bal = b.delivered - b.issued;
              return (
                <li key={tk.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="font-medium text-sand-900">
                    {tk.name}
                    {tk.capacity_l ? <span className="ml-1 text-xs text-sand-400">/ {tk.capacity_l.toLocaleString("en-ZA")} {t("fuel.litresShort", locale)}</span> : null}
                  </span>
                  <span className="flex items-center gap-3 tabular-nums text-sand-600">
                    <span>{t("fuel.delivered", locale)}: {b.delivered.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}</span>
                    <span>{t("fuel.issued", locale)}: {b.issued.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}</span>
                    <span className="font-semibold text-sand-900">{t("fuel.balance", locale)}: {bal.toLocaleString("en-ZA", { maximumFractionDigits: 0 })} {t("fuel.litresShort", locale)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-xs text-sand-400">{t("fuel.balanceHint", locale)}</p>
        {canManage ? (
          <details className="mt-3 border-t border-sand-100 pt-3">
            <summary className="cursor-pointer text-sm font-medium text-brand-700">{t("fuel.addTank", locale)}</summary>
            <form action={addFuelTank} className="mt-2 flex flex-wrap items-end gap-2">
              <Field label={t("fuel.tankName", locale)} htmlFor="t_name" className="flex-1">
                <Input id="t_name" name="name" required />
              </Field>
              <Field label={t("fuel.capacityL", locale)} htmlFor="t_cap">
                <Input id="t_cap" name="capacity_l" type="number" inputMode="decimal" step="1" />
              </Field>
              <SubmitButton variant="secondary">{t("fuel.add", locale)}</SubmitButton>
            </form>
          </details>
        ) : null}
      </Card>

      {/* Consumption per machine */}
      <Card>
        <CardHeader><CardTitle>{t("fuel.consumptionTitle", locale)}</CardTitle></CardHeader>
        {consumption.length === 0 ? (
          <p className="text-sm text-sand-500">{t("fuel.noConsumption", locale)}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-sand-100">
            {consumption.map((row) => (
              <li key={row.machineId} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <Link href={`/machines/${row.machineId}`} className="focus-ring rounded font-medium text-brand-700 hover:underline">{row.name}</Link>
                  <p className="text-xs text-sand-500">
                    {meterLabel(row.meterType, locale)} · {row.litres.toLocaleString("en-ZA", { maximumFractionDigits: 0 })} {t("fuel.litresShort", locale)}
                    {row.c.intervals > 0 ? ` · ${row.c.intervals} ${t("fuel.intervals", locale)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  {row.c.trend.length > 1 ? (
                    <div className="w-28"><FuelTrend trend={row.c.trend} unit={row.meterType === "km" ? t("fuel.perKm", locale) : t("fuel.perHr", locale)} title={t("fuel.trend", locale)} /></div>
                  ) : null}
                  <span className="w-24 text-right font-semibold tabular-nums text-sand-900">
                    {row.c.display != null ? formatConsumption(row.c, locale) : t("fuel.needMoreData", locale)}
                  </span>
                </div>
              </li>
            ))}
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
              <li key={i.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <Link href={`/machines/${i.machine_id}`} className="focus-ring rounded font-medium text-brand-700 hover:underline">{machineName.get(i.machine_id ?? "") ?? "—"}</Link>
                  <span className="ml-2 text-sand-500">{i.litres} {t("fuel.litresShort", locale)}{i.meter_reading != null ? ` @ ${i.meter_reading}` : ""}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-xs tabular-nums text-sand-400">{i.date}</span>
                  <Badge tone="danger">{t("fuel.flagged", locale)}</Badge>
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
                    <span className="font-medium text-sand-800">{d.litres} {t("fuel.litresShort", locale)}</span>
                    <span className="text-sand-500"> · {tankName.get(d.tank_id) ?? "—"}{d.supplier ? ` · ${d.supplier}` : ""}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-sand-400">
                    {d.price_per_l_cents != null ? <span className="tabular-nums text-sand-500">{rands(Math.round((d.litres ?? 0) * d.price_per_l_cents))}</span> : null}
                    <span className="tabular-nums">{d.date}</span>
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
                    <span className="font-medium text-sand-800">{i.litres} {t("fuel.litresShort", locale)}</span>
                    <span className="text-sand-500"> · {i.machine_id ? (machineName.get(i.machine_id) ?? "—") : t("fuel.farmLevel", locale)}{i.activity ? ` · ${activityLabel(i.activity, locale)}` : ""}{draweeLabel(i) ? ` · ${draweeLabel(i)}` : ""}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-sand-400">
                    {i.cost_cents != null ? <span className="tabular-nums text-sand-500">{rands(i.cost_cents)}</span> : null}
                    {i.anomaly_notified_at ? <Badge tone="danger">{t("fuel.flagged", locale)}</Badge> : null}
                    <span className="tabular-nums">{i.date}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
