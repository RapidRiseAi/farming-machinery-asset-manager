import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireProfile, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import {
  CADENCES, advanceByCadence, scheduleNetCents, scheduleTotalCents, isLive,
  type Schedule, type ScheduleLine,
} from "@/lib/recurring";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { TextField, SelectField, TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrashIcon } from "@/components/ui/icons";
import {
  updateSchedule, addScheduleLine, removeScheduleLine,
  toggleSchedule, runScheduleNow, deleteSchedule,
} from "../actions";

export const dynamic = "force-dynamic";

/** One standing invoice: what it bills, who it bills, and when it next goes out. */
export default async function SchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect("/documents");
  const locale = profile.lang;
  const { id } = await params;
  const sp = await searchParams;

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const supabase = await createClient();
  const { data } = await supabase.from("recurring_invoices").select("*").eq("id", id).is("deleted_at", null).maybeSingle();
  const schedule = data as Schedule | null;
  if (!schedule) notFound();

  const [{ data: lineData }, { data: raisedData }] = await Promise.all([
    supabase
      .from("recurring_invoice_lines")
      .select("id, sort_order, description, qty, unit_price_cents, discount_cents")
      .eq("recurring_id", id)
      .is("deleted_at", null)
      .order("sort_order"),
    // What this schedule has actually produced. The proof that it is working, and the
    // first place to look when a partner thinks it is not.
    supabase
      .from("partner_documents")
      .select("id, number, status, issue_date, total_cents")
      .eq("workshop_id", workshop.id)
      .is("deleted_at", null)
      .order("issue_date", { ascending: false })
      .limit(200),
  ]);

  const lines = (lineData ?? []) as ScheduleLine[];
  const netCents = scheduleNetCents(lines);
  const totalCents = scheduleTotalCents(lines, schedule.vat_rate_bps);
  const live = isLive(schedule);

  // Only the documents this schedule raised. `last_document_id` names the most recent;
  // anything older is matched by having been raised on a period start we have recorded.
  const raised = ((raisedData ?? []) as { id: string; number: string; status: string; issue_date: string; total_cents: number }[])
    .filter((d) => d.id === schedule.last_document_id);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Link href="/recurring" className="focus-ring rounded text-sm text-brand-700 hover:underline">
        ← {t("recurring.title", locale)}
      </Link>

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved || sp.added ? t("ui.saved", locale) : undefined} />
      <Flash tone="success" message={sp.raised ? t("recurring.raisedFlash", locale) : undefined} />
      <Flash tone="info" message={sp.nothing ? t("recurring.nothingFlash", locale) : undefined} />

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold tracking-tight text-sand-900">{schedule.name}</h1>
        <Badge tone="neutral">{t(`cadence.${schedule.cadence}`, locale)}</Badge>
        {schedule.auto_send ? <Badge tone="info">{t("recurring.autoSendBadge", locale)}</Badge> : null}
        {!live ? <Badge tone="warning">{t("recurring.pausedBadge", locale)}</Badge> : null}
      </div>

      <Card>
        <CardHeader><CardTitle>{t("recurring.whatItBills", locale)}</CardTitle></CardHeader>

        {lines.length === 0 ? (
          <p className="mb-3 text-sm text-status-warn">{t("recurring.noLines", locale)}</p>
        ) : (
          <ul className="mb-3 flex flex-col divide-y divide-sand-100 text-sm">
            {lines.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="text-sand-900">{l.description}</span>
                <span className="text-sand-500">× {l.qty}</span>
                <span className="ml-auto tabular-nums text-sand-800">{rands(l.unit_price_cents)}</span>
                <ConfirmDialog
                  action={removeScheduleLine}
                  triggerLabel={t("common.remove", locale)}
                  triggerIcon={<TrashIcon />}
                  triggerVariant="ghost"
                  triggerSize="sm"
                  title={t("recurring.removeLineTitle", locale)}
                  intro={l.description}
                  confirmLabel={t("common.remove", locale)}
                  cancelLabel={t("common.cancel", locale)}
                  closeLabel={t("ui.close", locale)}
                >
                  <input type="hidden" name="schedule_id" value={schedule.id} />
                  <input type="hidden" name="line_id" value={l.id} />
                </ConfirmDialog>
              </li>
            ))}
          </ul>
        )}

        <dl className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-sand-200 pt-2 text-sm sm:max-w-xs">
          <dt className="text-sand-600">{t("doc.subtotal", locale)}</dt>
          <dd className="text-right tabular-nums text-sand-900">{rands(netCents)}</dd>
          <dt className="font-medium text-sand-800">{t("recurring.eachTime", locale)}</dt>
          <dd className="text-right font-semibold tabular-nums text-sand-900">{rands(totalCents)}</dd>
        </dl>

        <form action={addScheduleLine} className="flex flex-col gap-3 border-t border-sand-100 pt-3">
          <input type="hidden" name="schedule_id" value={schedule.id} />
          <input type="hidden" name="sort_order" value={lines.length} />
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField name="description" label={t("recurring.lineDescription", locale)} required className="sm:col-span-2" />
            <TextField name="unit_price" inputMode="decimal" label={t("recurring.linePrice", locale)} required />
          </div>
          <label className="flex items-center gap-3 text-sm text-sand-700">
            <input type="checkbox" name="incl_vat" defaultChecked className="h-5 w-5 rounded border-sand-300 text-brand-600" />
            {t("recurring.priceInclVat", locale)}
          </label>
          <SubmitButton variant="secondary" className="self-start">{t("recurring.addLine", locale)}</SubmitButton>
        </form>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("recurring.whenTitle", locale)}</CardTitle></CardHeader>
        <p className="mb-3 text-sm text-sand-600">
          {live
            ? `${t("recurring.nextOn", locale)} ${shortDate(schedule.next_issue_date, locale)} · ${t("recurring.thenPreview", locale)} ${advanceByCadence(schedule.next_issue_date, schedule.cadence)}`
            : t("recurring.stopped", locale)}
        </p>

        <form action={updateSchedule} className="flex flex-col gap-3">
          <input type="hidden" name="schedule_id" value={schedule.id} />
          <TextField name="name" label={t("recurring.name", locale)} defaultValue={schedule.name} required />
          <TextField name="subject" label={t("recurring.subject", locale)} defaultValue={schedule.subject ?? ""} />
          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField name="cadence" label={t("recurring.howOften", locale)} defaultValue={schedule.cadence}>
              {CADENCES.map((c) => (
                <option key={c} value={c}>{t(`cadence.${c}`, locale)}</option>
              ))}
            </SelectField>
            <TextField name="next_issue_date" type="date" label={t("recurring.nextIssue", locale)} defaultValue={schedule.next_issue_date} />
            <TextField name="ends_on" type="date" label={t("recurring.endsOn", locale)} defaultValue={schedule.ends_on ?? ""} />
          </div>
          <TextareaField name="notes" rows={2} label={t("recurring.notes", locale)} defaultValue={schedule.notes ?? ""} />
          <label className="flex items-start gap-3 text-sm text-sand-700">
            <input
              type="checkbox"
              name="auto_send"
              defaultChecked={schedule.auto_send}
              className="mt-0.5 h-5 w-5 rounded border-sand-300 text-brand-600"
            />
            <span>
              {t("recurring.autoSend", locale)}
              <span className="block text-xs text-sand-500">{t("recurring.autoSendHint", locale)}</span>
            </span>
          </label>
          <SubmitButton variant="secondary" className="self-start">{t("common.save", locale)}</SubmitButton>
        </form>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("recurring.controlsTitle", locale)}</CardTitle></CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          {lines.length > 0 ? (
            <ConfirmDialog
              action={runScheduleNow}
              triggerLabel={t("recurring.runNow", locale)}
              triggerVariant="primary"
              triggerSize="sm"
              tone="brand"
              title={t("recurring.runNowTitle", locale)}
              intro={t("recurring.runNowBody", locale)}
              facts={[{ label: t("recurring.eachTime", locale), value: rands(totalCents) }]}
              consequences={[
                schedule.auto_send ? t("recurring.runNowSends", locale) : t("recurring.runNowDrafts", locale),
                t("recurring.runNowIdempotent", locale),
              ]}
              confirmLabel={t("recurring.runNow", locale)}
              cancelLabel={t("common.cancel", locale)}
              closeLabel={t("ui.close", locale)}
            >
              <input type="hidden" name="schedule_id" value={schedule.id} />
            </ConfirmDialog>
          ) : null}

          <form action={toggleSchedule}>
            <input type="hidden" name="schedule_id" value={schedule.id} />
            <input type="hidden" name="active" value={schedule.active ? "0" : "1"} />
            <SubmitButton variant="secondary" size="sm">
              {schedule.active ? t("recurring.pause", locale) : t("recurring.resume", locale)}
            </SubmitButton>
          </form>

          <ConfirmDialog
            action={deleteSchedule}
            triggerLabel={t("common.remove", locale)}
            triggerIcon={<TrashIcon />}
            triggerVariant="ghost"
            triggerSize="sm"
            title={t("recurring.deleteTitle", locale)}
            intro={schedule.name}
            consequences={[t("recurring.deleteConsequence", locale)]}
            confirmLabel={t("common.remove", locale)}
            cancelLabel={t("common.cancel", locale)}
            closeLabel={t("ui.close", locale)}
          >
            <input type="hidden" name="schedule_id" value={schedule.id} />
          </ConfirmDialog>
        </div>
      </Card>

      {raised.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t("recurring.raisedTitle", locale)}</CardTitle></CardHeader>
          <ul className="flex flex-col divide-y divide-sand-100 text-sm">
            {raised.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
                <Link href={`/documents/${d.id}`} className="focus-ring rounded font-medium text-brand-700 underline-offset-2 hover:underline">
                  {d.number}
                </Link>
                <span className="text-sand-500">{shortDate(d.issue_date, locale)}</span>
                <span className="ml-auto tabular-nums text-sand-900">{rands(d.total_cents)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
