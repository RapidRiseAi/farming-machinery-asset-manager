import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { effectiveFarmRole, homePathFor, requireProfile } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { featureOn } from "@/lib/features";
import { dateTime, num } from "@/lib/format";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { must } from "@/lib/supabase/must";
import { signedUrlsByPath } from "@/lib/signed-urls";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { EXPENSE_KINDS, TRIP_STATUS_TONE, tripDistance, tripFields } from "@/lib/trips";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Fact, FactList } from "@/components/ui/facts";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { Input } from "@/components/ui/input";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { SignaturePad } from "@/components/trips/signature-pad";
import {
  addTripExpense,
  addTripJob,
  cancelTrip,
  deliverTripJob,
  finishTrip,
  saveTripIncome,
  startTrip,
} from "../actions";
import { TripRouteCard } from "./route-card";

export const dynamic = "force-dynamic";

type Job = {
  id: string;
  customer: string;
  reference: string | null;
  description: string | null;
  weight_kg: number | null;
  passengers: number | null;
  seal_no: string | null;
  pickup: string | null;
  dropoff: string | null;
  status: string;
  delivered_at: string | null;
  received_by: string | null;
  pod_note: string | null;
  pod_photo_path: string | null;
  pod_signature_path: string | null;
};

export default async function TripPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const profile = await requireProfile();
  if (profile.role === "workshop" || profile.role === "rr_admin") redirect(`${homePathFor(profile.role)}?denied=1`);
  const locale = profile.lang;
  const close = t("ui.close", locale);
  const cancel = t("common.cancel", locale);

  const supabase = await createClient();
  const trip = must(
    await supabase
      .from("trips")
      .select("id, farm_id, number, status, machine_id, trailer_id, second_trailer_id, driver_id, driving_session_id, origin, destination, planned_start, started_at, ended_at, opening_reading, closing_reading, notes")
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle(),
    "trip:row",
  ) as {
    id: string; farm_id: string; number: number; status: string; machine_id: string; trailer_id: string | null;
    second_trailer_id: string | null; driver_id: string | null; driving_session_id: string | null;
    origin: string | null; destination: string | null;
    planned_start: string | null; started_at: string | null; ended_at: string | null;
    opening_reading: number | null; closing_reading: number | null; notes: string | null;
  } | null;
  if (!trip) notFound();

  const role = await effectiveFarmRole(trip.farm_id, profile);
  const manager = role === "owner" || role === "manager";
  const canWork = manager || trip.driver_id === profile.id;

  const [jobs, machines, driver, income, expenses] = await Promise.all([
    supabase.from("trip_jobs").select("id, customer, reference, description, weight_kg, passengers, seal_no, pickup, dropoff, status, delivered_at, received_by, pod_note, pod_photo_path, pod_signature_path").eq("trip_id", id).is("deleted_at", null).order("created_at"),
    supabase.from("machines").select("id, name, meter_type").in("id", [trip.machine_id, trip.trailer_id, trip.second_trailer_id].filter(Boolean) as string[]),
    trip.driver_id ? supabase.from("users").select("name").eq("id", trip.driver_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    manager ? supabase.from("trip_income").select("amount_cents, invoice_ref").eq("trip_id", id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    manager ? supabase.from("trip_expenses").select("id, kind, amount_cents, note").eq("trip_id", id).order("created_at") : Promise.resolve({ data: [], error: null }),
  ]);
  const jobRows = (must(jobs, "trip:jobs") ?? []) as Job[];
  const machineRows = (must(machines, "trip:machines") ?? []) as { id: string; name: string; meter_type: string | null }[];
  const names = new Map(machineRows.map((m) => [m.id, m.name]));
  // An hour meter says nothing about distance, so only a km reading is held against the plan.
  const kmMeter = machineRows.find((m) => m.id === trip.machine_id)?.meter_type === "km";
  const mapOn = await featureOn("map", trip.farm_id);
  const driverName = (must(driver, "trip:driver") as { name?: string } | null)?.name ?? null;
  const incomeRow = must(income, "trip:income") as { amount_cents: number; invoice_ref: string | null } | null;
  const expenseRows = (must(expenses, "trip:expenses") ?? []) as { id: string; kind: string; amount_cents: number; note: string | null }[];

  // Proof of delivery is signed for the moment it is read, and never stored as a public link.
  const svc = createServiceClient();
  const paths = jobRows.flatMap((j) => [j.pod_photo_path, j.pod_signature_path].filter(Boolean) as string[]);
  // One request for every photo and signature; one that will not sign is left without a link.
  const signed = (await signedUrlsByPath(svc, "jobcard-photos", paths, 3600)).urls;

  const fields = tripFields(locale);
  const km = tripDistance(trip);
  const expenseTotal = expenseRows.reduce((sum, e) => sum + Number(e.amount_cents), 0);
  const label = t("trips.titleOne", locale).replace("{n}", String(trip.number));

  return (
    <PageContainer>
      <p><Link href="/trips" className="text-sm underline">{t("trips.back", locale)}</Link></p>
      <PageHeader title={label} actions={<Badge tone={TRIP_STATUS_TONE[trip.status] ?? "neutral"}>{t(`trips.statusName.${trip.status}`, locale)}</Badge>} />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved === "route" ? t("routes.savedFlash", locale) : undefined} />

      <Card>
        <FactList>
          <Fact label={t("trips.vehicle", locale)} value={names.get(trip.machine_id) ?? "-"} />
          {trip.trailer_id ? <Fact label={t("trips.trailer", locale)} value={names.get(trip.trailer_id) ?? "-"} /> : null}
          {trip.second_trailer_id ? <Fact label={t("trips.secondTrailer", locale)} value={names.get(trip.second_trailer_id) ?? "-"} /> : null}
          <Fact label={t("trips.driver", locale)} value={driverName ?? "-"} />
          <Fact label={t("trips.route", locale)} value={[trip.origin, trip.destination].filter(Boolean).join(" to ") || "-"} />
          {trip.started_at ? <Fact label={t("trips.started", locale)} value={dateTime(trip.started_at, locale)} /> : null}
          {trip.ended_at ? <Fact label={t("trips.ended", locale)} value={dateTime(trip.ended_at, locale)} /> : null}
          {km != null ? <Fact label={t("trips.distance", locale)} value={num(km)} /> : null}
          {trip.notes ? <Fact label={t("trips.notes", locale)} value={trip.notes} /> : null}
        </FactList>

        {canWork && trip.status === "planned" ? (
          <form action={startTrip} className="mt-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={trip.id} />
            <div className="min-w-0 flex-1 basis-48">
              <Field label={t("trips.openingReading", locale)} htmlFor="t_open">
                <Input id="t_open" name="reading" inputMode="decimal" />
              </Field>
            </div>
            <SubmitButton variant="primary">{t("trips.start", locale)}</SubmitButton>
          </form>
        ) : null}
        {canWork && trip.status === "underway" ? (
          <form action={finishTrip} className="mt-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={trip.id} />
            <div className="min-w-0 flex-1 basis-48">
              <Field label={t("trips.closingReading", locale)} htmlFor="t_close">
                <Input id="t_close" name="reading" inputMode="decimal" />
              </Field>
            </div>
            <SubmitButton variant="primary">{t("trips.finish", locale)}</SubmitButton>
          </form>
        ) : null}
        {manager && trip.status === "planned" ? (
          <form action={cancelTrip} className="mt-3">
            <input type="hidden" name="id" value={trip.id} />
            <SubmitButton variant="ghost" size="sm">{t("trips.cancelTrip", locale)}</SubmitButton>
          </form>
        ) : null}
      </Card>

      {mapOn ? <TripRouteCard trip={trip} viewerId={profile.id} manager={manager} kmMeter={kmMeter} locale={locale} /> : null}

      <Card>
        <CardHeader
          action={
            manager && trip.status !== "completed" && trip.status !== "cancelled" ? (
              <DialogForm trigger={t("trips.addLoad", locale)} triggerVariant="secondary" title={t("trips.addLoad", locale)} closeLabel={close}>
                <form action={addTripJob}>
                  <input type="hidden" name="trip_id" value={trip.id} />
                  <DialogFields>
                    <Field label={t("trips.customer", locale)} htmlFor="j_customer" required>
                      <Input id="j_customer" name="customer" required maxLength={200} />
                    </Field>
                    <Field label={t("trips.reference", locale)} htmlFor="j_ref">
                      <Input id="j_ref" name="reference" maxLength={100} />
                    </Field>
                    <Field label={t("trips.pickup", locale)} htmlFor="j_pick">
                      <Input id="j_pick" name="pickup" maxLength={200} />
                    </Field>
                    <Field label={t("trips.dropoff", locale)} htmlFor="j_drop">
                      <Input id="j_drop" name="dropoff" maxLength={200} />
                    </Field>
                    {fields.goods ? (
                      <>
                        <Field label={t("trips.weight", locale)} htmlFor="j_weight">
                          <Input id="j_weight" name="weight_kg" inputMode="decimal" />
                        </Field>
                        <Field label={t("trips.seal", locale)} htmlFor="j_seal">
                          <Input id="j_seal" name="seal_no" maxLength={100} />
                        </Field>
                      </>
                    ) : null}
                    {fields.passengers ? (
                      <Field label={t("trips.passengers", locale)} htmlFor="j_pax">
                        <Input id="j_pax" name="passengers" inputMode="numeric" />
                      </Field>
                    ) : null}
                    <div className="sm:col-span-2">
                      <Field label={t("trips.description", locale)} htmlFor="j_desc">
                        <Textarea id="j_desc" name="description" rows={2} maxLength={1000} />
                      </Field>
                    </div>
                  </DialogFields>
                  <DialogActions cancelLabel={cancel}>
                    <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            ) : undefined
          }
        >
          <CardTitle as="h3">{t("trips.loads", locale)}</CardTitle>
        </CardHeader>

        {jobRows.length === 0 ? <p className="text-sm text-sand-500">{t("trips.noLoads", locale)}</p> : null}
        <ul className="flex flex-col gap-3">
          {jobRows.map((j) => (
            <li key={j.id} className="rounded-xl border border-sand-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words font-semibold text-sand-900">{j.customer}</span>
                <Badge tone={j.status === "delivered" ? "ok" : j.status === "failed" ? "danger" : "neutral"}>
                  {t(`trips.jobStatus.${j.status}`, locale)}
                </Badge>
              </div>
              <p className="mt-1 break-words text-sm text-sand-600">
                {[
                  j.reference,
                  j.pickup && j.dropoff ? `${j.pickup} to ${j.dropoff}` : (j.dropoff ?? j.pickup),
                  j.weight_kg != null ? `${num(Number(j.weight_kg))} kg` : null,
                  j.passengers != null ? t("trips.paxCount", locale).replace("{n}", String(j.passengers)) : null,
                  j.seal_no ? `${t("trips.seal", locale)} ${j.seal_no}` : null,
                ].filter(Boolean).join(" · ")}
              </p>
              {j.description ? <p className="mt-1 break-words text-sm text-sand-600">{j.description}</p> : null}

              {j.status !== "pending" ? (
                <div className="mt-2 text-sm text-sand-700">
                  <p>
                    {j.received_by ? t("trips.receivedBy", locale).replace("{name}", () => j.received_by ?? "") : null}{" "}
                    {j.delivered_at ? dateTime(j.delivered_at, locale) : null}
                  </p>
                  {j.pod_note ? <p className="break-words">{j.pod_note}</p> : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {[j.pod_photo_path, j.pod_signature_path].map((path) =>
                      path && signed.get(path) ? (
                        <a key={path} href={signed.get(path)} target="_blank" rel="noopener noreferrer">
                          <Image src={signed.get(path) as string} alt={t("trips.proof", locale)} width={160} height={110} unoptimized className="h-24 w-auto rounded-lg border border-sand-200" />
                        </a>
                      ) : null,
                    )}
                  </div>
                </div>
              ) : canWork && trip.status !== "cancelled" ? (
                <DialogForm trigger={t("trips.signOff", locale)} triggerVariant="primary" title={t("trips.signOff", locale)} description={j.customer} closeLabel={close} size="md">
                  <form action={deliverTripJob}>
                    <input type="hidden" name="job_id" value={j.id} />
                    <input type="hidden" name="trip_id" value={trip.id} />
                    <input type="hidden" name="farm_id" value={trip.farm_id} />
                    <DialogFields columns={1}>
                      <Field label={t("trips.outcome", locale)} htmlFor={`o_${j.id}`}>
                        <Select id={`o_${j.id}`} name="outcome" defaultValue="delivered">
                          <option value="delivered">{t("trips.jobStatus.delivered", locale)}</option>
                          <option value="failed">{t("trips.jobStatus.failed", locale)}</option>
                        </Select>
                      </Field>
                      <Field label={t("trips.receiverName", locale)} htmlFor={`r_${j.id}`}>
                        <Input id={`r_${j.id}`} name="received_by" maxLength={200} />
                      </Field>
                      <Field label={t("trips.photo", locale)} htmlFor={`p_${j.id}`}>
                        <Input id={`p_${j.id}`} name="photo" type="file" accept="image/*" capture="environment" />
                      </Field>
                      <SignaturePad name="signature" clearLabel={t("trips.signatureClear", locale)} hint={t("trips.signatureHint", locale)} />
                      <Field label={t("trips.note", locale)} htmlFor={`n_${j.id}`}>
                        <Textarea id={`n_${j.id}`} name="note" rows={2} maxLength={1000} />
                      </Field>
                    </DialogFields>
                    <DialogActions cancelLabel={cancel}>
                      <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                    </DialogActions>
                  </form>
                </DialogForm>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      {manager ? (
        <Card>
          <CardHeader><CardTitle as="h3">{t("trips.money", locale)}</CardTitle></CardHeader>
          <FactList>
            <Fact label={t("trips.income", locale)} value={incomeRow ? rands(Number(incomeRow.amount_cents)) : "-"} />
            {incomeRow?.invoice_ref ? <Fact label={t("trips.invoiceRef", locale)} value={incomeRow.invoice_ref} /> : null}
            <Fact label={t("trips.expenses", locale)} value={rands(expenseTotal)} />
          </FactList>
          {expenseRows.length > 0 ? (
            <ul className="mt-2 text-sm text-sand-600">
              {expenseRows.map((e) => (
                <li key={e.id}>{t(`trips.expenseKind.${e.kind}`, locale)}: {rands(Number(e.amount_cents))}{e.note ? ` (${e.note})` : ""}</li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <DialogForm trigger={t("trips.setIncome", locale)} triggerVariant="secondary" title={t("trips.setIncome", locale)} closeLabel={close} size="md">
              <form action={saveTripIncome}>
                <input type="hidden" name="trip_id" value={trip.id} />
                <DialogFields columns={1}>
                  <Field label={t("trips.amount", locale)} htmlFor="i_amount" required>
                    <Input id="i_amount" name="amount" inputMode="decimal" required defaultValue={incomeRow ? String(Number(incomeRow.amount_cents) / 100) : ""} />
                  </Field>
                  <Field label={t("trips.invoiceRef", locale)} htmlFor="i_ref">
                    <Input id="i_ref" name="invoice_ref" maxLength={100} defaultValue={incomeRow?.invoice_ref ?? ""} />
                  </Field>
                </DialogFields>
                <DialogActions cancelLabel={cancel}>
                  <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                </DialogActions>
              </form>
            </DialogForm>
            <DialogForm trigger={t("trips.addExpense", locale)} triggerVariant="secondary" title={t("trips.addExpense", locale)} closeLabel={close} size="md">
              <form action={addTripExpense}>
                <input type="hidden" name="trip_id" value={trip.id} />
                <DialogFields columns={1}>
                  <Field label={t("trips.expenseType", locale)} htmlFor="e_kind">
                    <Select id="e_kind" name="kind" defaultValue="toll">
                      {EXPENSE_KINDS.map((k) => (
                        <option key={k} value={k}>{t(`trips.expenseKind.${k}`, locale)}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("trips.amount", locale)} htmlFor="e_amount" required>
                    <Input id="e_amount" name="amount" inputMode="decimal" required />
                  </Field>
                  <Field label={t("trips.note", locale)} htmlFor="e_note">
                    <Input id="e_note" name="note" maxLength={500} />
                  </Field>
                </DialogFields>
                <DialogActions cancelLabel={cancel}>
                  <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                </DialogActions>
              </form>
            </DialogForm>
          </div>
        </Card>
      ) : null}
    </PageContainer>
  );
}
