import Link from "next/link";
import { redirect } from "next/navigation";

import { currentFarmId, effectiveFarmRole, homePathFor, requireProfile } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { num, shortDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { typeLabel } from "@/lib/machine-options";
import { createClient } from "@/lib/supabase/server";
import { mustAll } from "@/lib/supabase/must";
import { TRAILER_TYPES, TRIP_STATUS_TONE, tripDistance } from "@/lib/trips";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Stat, StatGrid } from "@/components/ui/stat";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { createTrip } from "./actions";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  number: number;
  status: string;
  machine_id: string;
  driver_id: string | null;
  origin: string | null;
  destination: string | null;
  planned_start: string | null;
  started_at: string | null;
  opening_reading: number | null;
  closing_reading: number | null;
  created_at: string;
};

export default async function TripsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const profile = await requireProfile();
  if (profile.role === "workshop" || profile.role === "rr_admin") redirect(`${homePathFor(profile.role)}?denied=1`);
  const sp = await searchParams;
  const locale = profile.lang;
  const farmId = (await currentFarmId(profile)) ?? "";
  const role = await effectiveFarmRole(farmId, profile);
  const canPlan = role === "owner" || role === "manager";

  const supabase = await createClient();
  const results = await Promise.all([
    supabase
      .from("trips")
      .select("id, number, status, machine_id, driver_id, origin, destination, planned_start, started_at, opening_reading, closing_reading, created_at")
      .eq("farm_id", farmId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("machines").select("id, name, type").eq("farm_id", farmId).is("deleted_at", null).neq("status", "retired").order("name").limit(2000),
    supabase.from("users").select("id, name").eq("farm_id", farmId).eq("active", true).is("deleted_at", null).order("name").limit(1000),
  ]);
  mustAll(results, "trips:page");
  const [{ data: tripData }, { data: machineData }, { data: peopleData }] = results;
  const trips = (tripData ?? []) as Row[];
  const machines = (machineData ?? []) as { id: string; name: string; type: string }[];
  const people = (peopleData ?? []) as { id: string; name: string }[];
  const vehicleName = new Map(machines.map((m) => [m.id, m.name]));
  const personName = new Map(people.map((p) => [p.id, p.name]));
  const trailers = machines.filter((m) => TRAILER_TYPES.includes(m.type));
  const vehicles = machines.filter((m) => !TRAILER_TYPES.includes(m.type));

  const underway = trips.filter((x) => x.status === "underway").length;
  const planned = trips.filter((x) => x.status === "planned").length;

  const newTrip = canPlan ? (
    <DialogForm
      trigger={t("trips.new", locale)}
      triggerIcon={<PlusIcon />}
      triggerVariant="primary"
      title={t("trips.new", locale)}
      closeLabel={t("ui.close", locale)}
    >
      <form action={createTrip}>
        <DialogFields>
          <Field label={t("trips.vehicle", locale)} htmlFor="nt_machine" required>
            <Select id="nt_machine" name="machine_id" required defaultValue={vehicles[0]?.id}>
              {vehicles.map((m) => (
                <option key={m.id} value={m.id}>{m.name} ({typeLabel(m.type, locale)})</option>
              ))}
            </Select>
          </Field>
          <Field label={t("trips.driver", locale)} htmlFor="nt_driver">
            <Select id="nt_driver" name="driver_id" defaultValue="">
              <option value="">{t("trips.noDriver", locale)}</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
          {trailers.length > 0 ? (
            <>
              <Field label={t("trips.trailer", locale)} htmlFor="nt_trailer">
                <Select id="nt_trailer" name="trailer_id" defaultValue="">
                  <option value="">{t("trips.noTrailer", locale)}</option>
                  {trailers.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t("trips.secondTrailer", locale)} htmlFor="nt_trailer2">
                <Select id="nt_trailer2" name="second_trailer_id" defaultValue="">
                  <option value="">{t("trips.noTrailer", locale)}</option>
                  {trailers.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </Select>
              </Field>
            </>
          ) : null}
          <Field label={t("trips.from", locale)} htmlFor="nt_from">
            <Input id="nt_from" name="origin" maxLength={200} />
          </Field>
          <Field label={t("trips.to", locale)} htmlFor="nt_to">
            <Input id="nt_to" name="destination" maxLength={200} />
          </Field>
          <Field label={t("trips.plannedStart", locale)} htmlFor="nt_when">
            <Input id="nt_when" name="planned_start" type="datetime-local" />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t("trips.notes", locale)} htmlFor="nt_notes">
              <Textarea id="nt_notes" name="notes" rows={2} maxLength={2000} />
            </Field>
          </div>
        </DialogFields>
        <DialogActions cancelLabel={t("common.cancel", locale)}>
          <SubmitButton variant="primary">{t("trips.create", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  ) : null;

  return (
    <PageContainer size="wide">
      <PageHeader
        title={t("trips.title", locale)}
        lead={t("trips.lead", locale)}
        actions={
          <div className="flex flex-wrap gap-2">
            {newTrip}
            <Link href="/trips/hours" className={buttonVariants({ variant: "secondary" })}>{t("trips.hoursLink", locale)}</Link>
            {canPlan ? <Link href="/trips/report" className={buttonVariants({ variant: "secondary" })}>{t("trips.reportLink", locale)}</Link> : null}
          </div>
        }
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />

      <StatGrid columns={2}>
        <Stat label={t("trips.statUnderway", locale)} value={num(underway)} size="md" />
        <Stat label={t("trips.statPlanned", locale)} value={num(planned)} size="md" />
      </StatGrid>

      {trips.length === 0 ? (
        <EmptyState title={t("trips.emptyTitle", locale)} hint={canPlan ? t("trips.emptyHint", locale) : t("trips.emptyHintDriver", locale)} />
      ) : (
        <Card flush>
          <div className="overflow-x-auto">
            <Table>
              <Thead>
                <Tr>
                  <Th>{t("trips.number", locale)}</Th>
                  <Th>{t("trips.vehicle", locale)}</Th>
                  <Th>{t("trips.driver", locale)}</Th>
                  <Th>{t("trips.route", locale)}</Th>
                  <Th>{t("trips.when", locale)}</Th>
                  <Th>{t("trips.distance", locale)}</Th>
                  <Th>{t("trips.status", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {trips.map((x) => {
                  const km = tripDistance(x);
                  const when = x.started_at ?? x.planned_start ?? x.created_at;
                  return (
                    <Tr key={x.id}>
                      <Td><Link href={`/trips/${x.id}`} className="font-medium underline">{x.number}</Link></Td>
                      <Td>{vehicleName.get(x.machine_id) ?? "-"}</Td>
                      <Td>{x.driver_id ? (personName.get(x.driver_id) ?? "-") : "-"}</Td>
                      <Td>{[x.origin, x.destination].filter(Boolean).join(" to ") || "-"}</Td>
                      <Td>{shortDate(when, locale)}</Td>
                      <Td className="tnum">{km == null ? "-" : num(km)}</Td>
                      <Td><Badge tone={TRIP_STATUS_TONE[x.status] ?? "neutral"}>{t(`trips.statusName.${x.status}`, locale)}</Badge></Td>
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
