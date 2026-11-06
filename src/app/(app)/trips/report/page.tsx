import Link from "next/link";

import { requireRole } from "@/lib/auth";
import { num } from "@/lib/format";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { mustAll } from "@/lib/supabase/must";
import { marginPerKmCents, tripDistance } from "@/lib/trips";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";

/** What each vehicle earned over its last 90 days of finished work. Owners and managers only. */
export const dynamic = "force-dynamic";

export default async function TripReportPage() {
  const profile = await requireRole(["owner", "manager"]);
  const locale = profile.lang;
  const farmId = profile.farm_id ?? "";
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const supabase = await createClient();
  const results = await Promise.all([
    supabase.from("trips").select("id, machine_id, opening_reading, closing_reading").eq("farm_id", farmId).eq("status", "completed").gte("ended_at", since).limit(5000),
    supabase.from("trip_income").select("trip_id, amount_cents").eq("farm_id", farmId).limit(5000),
    supabase.from("trip_expenses").select("trip_id, amount_cents").eq("farm_id", farmId).limit(10000),
    supabase.from("machines").select("id, name").eq("farm_id", farmId).limit(2000),
  ]);
  mustAll(results, "trips:report");
  const [{ data: tripData }, { data: incomeData }, { data: expenseData }, { data: machineData }] = results;

  type Trip = { id: string; machine_id: string; opening_reading: number | null; closing_reading: number | null };
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
    </PageContainer>
  );
}
