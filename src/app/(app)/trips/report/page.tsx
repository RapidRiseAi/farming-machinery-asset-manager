import Link from "next/link";

import { farmAllows, getFarmPlan, requireRole } from "@/lib/auth";
import { requiredPlan as minPlanFor } from "@/lib/entitlements";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { mapsAvailable } from "@/lib/features";
import { kmCheck, type KmCheck } from "@/lib/routing/geometry";
import { OWNED_FIELD, SETTING_NUMBERS } from "@/lib/settings";
import { num } from "@/lib/format";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { must, mustAll } from "@/lib/supabase/must";
import { readAll, readByIds } from "@/lib/supabase/read-all";
import { tripDistance, tripReport, type ReportTrip } from "@/lib/trips";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { updateSettings } from "../../settings/actions";

/** The window this report covers, said on the page: it is not an all-time total. */
const WINDOW_DAYS = 90;

/**
 * What each vehicle earned over its last 90 days of finished work. Owners and managers only,
 * on Professional and Complete (decision 16). Below that the report is not computed: saved
 * trips stay readable on their own pages and in the export (decision 37), but a fresh trip
 * profit report is the higher plan's analysis.
 */
export const dynamic = "force-dynamic";

export default async function TripReportPage() {
  const profile = await requireRole(["owner", "manager"]);
  const locale = profile.lang;
  const farmId = profile.farm_id ?? "";

  if (!(await farmAllows(farmId, "trips", profile))) {
    return (
      <PageContainer>
        <p><Link href="/trips" className="text-sm underline">{t("trips.back", locale)}</Link></p>
        <PageHeader title={t("tripReport.title", locale)} />
        <UpgradeNotice
          feature="trips"
          requiredPlan={minPlanFor("trips")}
          currentPlan={await getFarmPlan(farmId)}
          locale={locale}
          canUpgrade={profile.role === "owner"}
        />
      </PageContainer>
    );
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const supabase = await createClient();
  // Finished trips by when they ended; cancelled and unfinished ones by when they were made,
  // so the page can say how many it left out. Every page of them, not the first thousand.
  const tripsRead = await readAll<ReportTrip & { number: number }>(() =>
    supabase
      .from("trips")
      .select("id, number, machine_id, status, opening_reading, closing_reading")
      .eq("farm_id", farmId)
      .is("deleted_at", null)
      .or(`and(status.eq.completed,ended_at.gte.${since}),and(status.neq.completed,created_at.gte.${since})`),
  );
  const tripRows = must(tripsRead, "trips:report-trips") ?? [];
  const finishedIds = tripRows.filter((r) => r.status === "completed").map((r) => r.id);
  const results = await Promise.all([
    // Only the money of the trips counted: never the business's whole ledger in memory.
    readByIds<{ trip_id: string; amount_cents: number }>(finishedIds, (chunk) =>
      supabase.from("trip_income").select("trip_id, amount_cents").in("trip_id", chunk), { key: "trip_id" }),
    readByIds<{ id: string; trip_id: string; amount_cents: number }>(finishedIds, (chunk) =>
      supabase.from("trip_expenses").select("id, trip_id, amount_cents").in("trip_id", chunk)),
    readByIds<{ trip_id: string; distance_m: number }>(finishedIds, (chunk) =>
      supabase.from("trip_routes").select("trip_id, distance_m").in("trip_id", chunk), { key: "trip_id" }),
    supabase.from("machines").select("id, name, meter_type").eq("farm_id", farmId).limit(2000),
    supabase.from("farms").select("settings").eq("id", farmId).maybeSingle(),
  ]);
  mustAll(results, "trips:report");
  const [{ data: incomeData }, { data: expenseData }, { data: routeData }, { data: machineData }, { data: farmData }] = results;
  const mapOn = await mapsAvailable(farmId, profile);

  type Trip = ReportTrip & { number: number };
  const income = new Map((incomeData ?? []).map((r) => [r.trip_id, Number(r.amount_cents)]));
  const spent = new Map<string, number>();
  for (const e of expenseData ?? []) {
    spent.set(e.trip_id, (spent.get(e.trip_id) ?? 0) + Number(e.amount_cents));
  }
  const names = new Map(((machineData ?? []) as { id: string; name: string }[]).map((m) => [m.id, m.name]));
  const report = tripReport(tripRows, income, spent);
  const tripData = tripRows.filter((r) => r.status === "completed");

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
      <PageHeader title={t("tripReport.title", locale)} lead={t("tripReport.lead", locale).replace("{days}", String(WINDOW_DAYS))} />
      {report.withoutReadings + report.zeroKm + report.cancelled + report.unfinished > 0 ? (
        <ul className="flex flex-col gap-1 text-sm text-sand-600">
          {report.withoutReadings > 0 ? <li>{t("tripReport.withoutReadings", locale).replace("{n}", String(report.withoutReadings))}</li> : null}
          {report.zeroKm > 0 ? <li>{t("tripReport.zeroKm", locale).replace("{n}", String(report.zeroKm))}</li> : null}
          {report.cancelled + report.unfinished > 0 ? (
            <li>
              {t("tripReport.notCounted", locale)
                .replace("{cancelled}", String(report.cancelled))
                .replace("{unfinished}", String(report.unfinished))
                .replace("{days}", String(WINDOW_DAYS))}
            </li>
          ) : null}
        </ul>
      ) : null}
      {report.vehicles.length === 0 ? (
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
                  <Th>{t("tripReport.result", locale)}</Th>
                  <Th>{t("tripReport.perKm", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {report.vehicles.map((r) => (
                  <Tr key={r.machineId}>
                    <Td>{names.get(r.machineId) ?? "-"}</Td>
                    <Td className="tnum">
                      {num(r.trips)}
                      {r.tripsWithoutIncome > 0 ? (
                        <span className="block text-xs text-sand-500">
                          {t("tripReport.withoutIncome", locale).replace("{n}", String(r.tripsWithoutIncome))}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="tnum">{r.tripsWithKm === 0 ? "-" : num(r.km)}</Td>
                    <Td className="tnum">{rands(r.incomeCents)}</Td>
                    <Td className="tnum">{rands(r.expenseCents)}</Td>
                    <Td className="tnum">{rands(r.incomeCents - r.expenseCents)}</Td>
                    <Td className="tnum">{r.perKmCents == null ? "-" : rands(r.perKmCents)}</Td>
                  </Tr>
                ))}
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
