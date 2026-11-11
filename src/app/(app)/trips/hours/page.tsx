import Link from "next/link";
import { redirect } from "next/navigation";

import { currentFarmId, effectiveFarmRole, homePathFor, requireProfile } from "@/lib/auth";
import { driverHours, type HoursPolicy, type WorkPeriod } from "@/lib/driver-hours";
import { num } from "@/lib/format";
import { t } from "@/lib/i18n";
import { OWNED_FIELD } from "@/lib/settings";
import { createClient } from "@/lib/supabase/server";
import { mustAll } from "@/lib/supabase/must";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { updateSettings } from "../../settings/actions";

/**
 * Driving time against the company's own policy, for a fatigue audit or a morning check. Built
 * from trips and driving sessions together, counted once where they overlap.
 */
export const dynamic = "force-dynamic";

const POLICY_KEYS = ["driver_max_hours_day", "driver_max_hours_week", "driver_min_rest_hours"];

export default async function DriverHoursPage() {
  const profile = await requireProfile();
  if (profile.role === "workshop" || profile.role === "rr_admin") redirect(`${homePathFor(profile.role)}?denied=1`);
  const locale = profile.lang;
  const farmId = (await currentFarmId(profile)) ?? "";
  const role = await effectiveFarmRole(farmId, profile);
  const manager = role === "owner" || role === "manager";

  const supabase = await createClient();
  const since = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const results = await Promise.all([
    supabase.from("trips").select("driver_id, started_at, ended_at").eq("farm_id", farmId).not("started_at", "is", null).not("driver_id", "is", null).gte("started_at", since).limit(5000),
    supabase.from("driving_sessions").select("driver_id, started_at, ended_at").eq("farm_id", farmId).gte("started_at", since).limit(5000),
    supabase.from("users").select("id, name").eq("farm_id", farmId).limit(1000),
    supabase.from("farms").select("settings").eq("id", farmId).maybeSingle(),
  ]);
  mustAll(results, "trips:hours");
  const [{ data: tripData }, { data: sessionData }, { data: peopleData }, { data: farmData }] = results;

  const settings = ((farmData as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const setting = (key: string, fallback: number) => (typeof settings[key] === "number" ? (settings[key] as number) : fallback);
  const policy: HoursPolicy = {
    maxDay: setting("driver_max_hours_day", 12),
    maxWeek: setting("driver_max_hours_week", 60),
    minRest: setting("driver_min_rest_hours", 8),
  };

  type Raw = { driver_id: string | null; started_at: string; ended_at: string | null };
  const periods: WorkPeriod[] = ([...(tripData ?? []), ...(sessionData ?? [])] as Raw[]).flatMap((r) =>
    r.driver_id ? [{ driverId: r.driver_id, start: r.started_at, end: r.ended_at }] : [],
  );
  const hours = driverHours(periods, policy).sort((a, b) => b.week - a.week);
  const nameOf = new Map(((peopleData ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));

  return (
    <PageContainer>
      <p><Link href="/trips" className="text-sm underline">{t("trips.back", locale)}</Link></p>
      <PageHeader title={t("hours.title", locale)} lead={t("hours.lead", locale)} />

      {hours.length === 0 ? (
        <EmptyState title={t("hours.emptyTitle", locale)} hint={t("hours.emptyHint", locale)} />
      ) : (
        <Card flush>
          <div className="overflow-x-auto">
            <Table>
              <Thead>
                <Tr>
                  <Th>{t("trips.driver", locale)}</Th>
                  <Th>{t("hours.day", locale)}</Th>
                  <Th>{t("hours.week", locale)}</Th>
                  <Th>{t("hours.rest", locale)}</Th>
                  <Th>{t("hours.state", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {hours.map((h) => (
                  <Tr key={h.driverId}>
                    <Td>{nameOf.get(h.driverId) ?? "-"}</Td>
                    <Td className="tnum">{num(h.day)}</Td>
                    <Td className="tnum">{num(h.week)}</Td>
                    <Td className="tnum">{h.shortestRest == null ? "-" : num(h.shortestRest)}</Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {h.overDay ? <Badge tone="danger">{t("hours.overDay", locale)}</Badge> : null}
                        {h.overWeek ? <Badge tone="danger">{t("hours.overWeek", locale)}</Badge> : null}
                        {h.shortRest ? <Badge tone="warning">{t("hours.shortRest", locale)}</Badge> : null}
                        {!h.overDay && !h.overWeek && !h.shortRest ? <Badge tone="ok">{t("hours.ok", locale)}</Badge> : null}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </div>
        </Card>
      )}

      {manager ? (
        <Card>
          <CardHeader><CardTitle as="h3">{t("hours.policy", locale)}</CardTitle></CardHeader>
          <p className="mb-3 text-sm text-sand-600">{t("hours.policyHint", locale)}</p>
          <form action={updateSettings} className="grid gap-3 sm:grid-cols-3">
            <input type="hidden" name={OWNED_FIELD} value={POLICY_KEYS.join(" ")} />
            <input type="hidden" name="return_to" value="/trips/hours" />
            <Field label={t("hours.maxDay", locale)} htmlFor="driver_max_hours_day">
              <Input id="driver_max_hours_day" name="driver_max_hours_day" inputMode="numeric" defaultValue={policy.maxDay} />
            </Field>
            <Field label={t("hours.maxWeek", locale)} htmlFor="driver_max_hours_week">
              <Input id="driver_max_hours_week" name="driver_max_hours_week" inputMode="numeric" defaultValue={policy.maxWeek} />
            </Field>
            <Field label={t("hours.minRest", locale)} htmlFor="driver_min_rest_hours">
              <Input id="driver_min_rest_hours" name="driver_min_rest_hours" inputMode="numeric" defaultValue={policy.minRest} />
            </Field>
            <div className="sm:col-span-3">
              <SubmitButton>{t("common.save", locale)}</SubmitButton>
            </div>
          </form>
        </Card>
      ) : null}
    </PageContainer>
  );
}
