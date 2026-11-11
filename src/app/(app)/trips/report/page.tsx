import Link from "next/link";

import { requireRole } from "@/lib/auth";
import { featureOn } from "@/lib/features";
import { kmCheck, type KmCheck } from "@/lib/routing/geometry";
import { OWNED_FIELD, SETTING_NUMBERS } from "@/lib/settings";
import { num } from "@/lib/format";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { mustAll } from "@/lib/supabase/must";
import { marginPerKmCents, tripDistance } from "@/lib/trips";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { updateSettings } from "../../settings/actions";

/** What each vehicle earned over its last 90 days of finished work. Owners and managers only. */
export const dynamic = "force-dynamic";

export default async function TripReportPage() {
  const profile = await requireRole(["owner", "manager"]);
  const locale = profile.lang;
  const farmId = profile.farm_id ?? "";
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const supabase = await createClient();
  const results = await Promise.all([
    supabase.from("trips").select("id, number, machine_id, opening_reading, closing_reading").eq("farm_id", farmId).eq("status", "completed").gte("ended_at", since).limit(5000),
    supabase.from("trip_income").select("trip_id, amount_cents").eq("farm_id", farmId).limit(5000),
    supabase.from("trip_expenses").select("trip_id, amount_cents").eq("farm_id", farmId).limit(10000),
    supabase.from("machines").select("id, name, meter_type").eq("farm_id", farmId).limit(2000),
    supabase.from("trip_routes").select("trip_id, distance_m").eq("farm_id", farmId).limit(5000),
    supabase.from("farms").select("settings").eq("id", farmId).maybeSingle(),
  ]);
  mustAll(results, "trips:report");
  const [{ data: tripData }, { data: incomeData }, { data: expenseData }, { data: machineData }, { data: routeData }, { data: farmData }] = results;
  const mapOn = await featureOn("map", farmId);

  type Trip = { id: string; number: number; machine_id: string; opening_reading: number | null; closing_reading: number | null };
  const income = new Map(((incomeData ?? []) as { trip_id: string; amount_cents: number }[]).map((r) => [r.trip_id, Number(r.amount_cents)]));
  const spent = new Map<string, number>();
  for (const e of (expenseData ?? []) as { trip_id: string; amount_cents: number }[]) {
    spent.set(e.trip_id, (spent.get(e.trip_id) ?? 0) + Number(e.amount_cents));
  }
  const names = new Map(((machineData ?? []) as { id: string; name: string }[]).map((m) => [m.id, m.name]));

  const byVehicle = new Map<string, { trips: number; km: number; incomeCents: number; expenseCents: number }>();
  for (const trip of (tripData ?? []) as Trip[]) {
    const row = byVehicle.get(trip.machine_id) ?? { trips: 0, km: 0, incomeCents: 0, expenseCents: 0 };
    row.trips += 1;
    row.km += tripDistance(trip) ?? 0;
    row.incomeCents += income.get(trip.id) ?? 0;
    row.expenseCents += spent.get(trip.id) ?? 0;
    byVehicle.set(trip.machine_id, row);
  }
  const rows = [...byVehicle.entries()].sort((a, b) => b[1].incomeCents - a[1].incomeCents);

  // Finished trips against their planned routes, by the odometer. Only a km meter counts.
  const settings = ((farmData as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const tolerance =
    typeof settings.route_km_tolerance_pct === "number" ? settings.route_km_tolerance_pct : SETTING_NUMBERS.route_km_tolerance_pct;
  const plannedM = new Map(((routeData ?? []) as { trip_id: string; distance_m: number }[]).map((r) => [r.trip_id, r.distance_m]));
  const kmMeter = new Set(((machineData ?? []) as { id: string; meter_type: string | null }[]).filter((m) => m.meter_type === "km").map((m) => m.id));
  const checked: { trip: Trip; check: KmCheck }[] = [];
  for (const trip of (tripData ?? []) as Trip[]) {
    const planned = plannedM.get(trip.id);
    if (planned == null || !kmMeter.has(trip.machine_id)) continue;
    checked.push({ trip, check: kmCheck({ plannedKm: planned / 1000, odometerKm: tripDistance(trip), recordedKm: null, tolerancePct: tolerance }) });
  }
  const outside = checked.filter((c) => c.check.verdict === "over" || c.check.verdict === "under");

  return (
    <PageContainer>
      <p><Link href="/trips" className="text-sm underline">{t("trips.back", locale)}</Link></p>
      <PageHeader title={t("tripReport.title", locale)} lead={t("tripReport.lead", locale)} />
      {rows.length === 0 ? (
        <EmptyState title={t("tripReport.emptyTitle", locale)} hint={t("tripReport.emptyHint", locale)} />
      ) : (
        <Card flush>
          <div className="overflow-x-auto">
            <Table>
              <Thead>
                <Tr>
                  <Th>{t("trips.vehicle", locale)}</Th>
                  <Th>{t("tripReport.count", locale)}</Th>
                  <Th>{t("trips.distance", locale)}</Th>
                  <Th>{t("trips.income", locale)}</Th>
                  <Th>{t("trips.expenses", locale)}</Th>
                  <Th>{t("tripReport.perKm", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {rows.map(([id, r]) => {
                  const perKm = marginPerKmCents(r);
                  return (
                    <Tr key={id}>
                      <Td>{names.get(id) ?? "-"}</Td>
                      <Td className="tnum">{num(r.trips)}</Td>
                      <Td className="tnum">{num(r.km)}</Td>
                      <Td className="tnum">{rands(r.incomeCents)}</Td>
                      <Td className="tnum">{rands(r.expenseCents)}</Td>
                      <Td className="tnum">{perKm == null ? "-" : rands(perKm)}</Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </div>
        </Card>
      )}

      {mapOn ? (
        <Card>
          <CardHeader><CardTitle as="h3">{t("routes.reportTitle", locale)}</CardTitle></CardHeader>
          <p className="mb-3 text-sm text-sand-600">
            {checked.length === 0
              ? t("routes.reportNone", locale)
              : outside.length === 0
                ? t("routes.reportAllOk", locale).replace("{n}", String(checked.length)).replace("{pct}", String(tolerance))
                : t("routes.reportSome", locale).replace("{n}", String(outside.length)).replace("{total}", String(checked.length)).replace("{pct}", String(tolerance))}
          </p>
          {outside.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <Thead>
                  <Tr>
                    <Th>{t("routes.reportTrip", locale)}</Th>
                    <Th>{t("trips.vehicle", locale)}</Th>
                    <Th>{t("routes.planned", locale)}</Th>
                    <Th>{t("routes.odometer", locale)}</Th>
                    <Th>{t("routes.difference", locale)}</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {outside.map(({ trip, check }) => (
                    <Tr key={trip.id}>
                      <Td><Link href={`/trips/${trip.id}`} className="underline">{t("trips.titleOne", locale).replace("{n}", String(trip.number))}</Link></Td>
                      <Td>{names.get(trip.machine_id) ?? "-"}</Td>
                      <Td className="tnum">{num(check.plannedKm ?? 0)} km</Td>
                      <Td className="tnum">{num(check.actualKm ?? 0)} km</Td>
                      <Td>
                        <Badge tone="warning">{`${(check.diffPct ?? 0) > 0 ? "+" : "-"}${num(Math.round(Math.abs(check.diffPct ?? 0)))}%`}</Badge>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </div>
          ) : null}
          <form action={updateSettings} className="mt-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name={OWNED_FIELD} value="route_km_tolerance_pct" />
            <input type="hidden" name="return_to" value="/trips/report" />
            <div className="min-w-0 basis-56">
              <Field label={t("routes.tolerance", locale)} htmlFor="route_km_tolerance_pct" hint={t("routes.toleranceHint", locale)}>
                <Input id="route_km_tolerance_pct" name="route_km_tolerance_pct" inputMode="numeric" defaultValue={tolerance} />
              </Field>
            </div>
            <SubmitButton>{t("common.save", locale)}</SubmitButton>
          </form>
        </Card>
      ) : null}
    </PageContainer>
  );
}
