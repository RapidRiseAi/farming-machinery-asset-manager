import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  checkEntitlement,
  currentFarmId,
  effectiveFarmRole,
  getFarmPlan,
  homePathFor,
} from "@/lib/auth";
import { planAllows } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { dateTime, shortDate } from "@/lib/format";
import { num } from "@/lib/format";
import {
  isLive, nextPeriod, periodLabel, REPORT_CADENCES,
  type ReportSchedule, type ReportScheduleRun,
} from "@/lib/scheduled-reports";
import { REPORT_FORMATS, REPORT_KEYS } from "@/lib/report-export";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { AllClear } from "@/components/ui/empty-state";
import { TextField, SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrashIcon, MailIcon } from "@/components/ui/icons";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import {
  addReportRecipient, deleteReportSchedule, removeReportRecipient,
  sendReportScheduleNow, toggleReportSchedule, updateReportSchedule,
} from "../actions";

export const dynamic = "force-dynamic";

type RecipientRow = {
  id: string;
  user_id: string | null;
  email: string | null;
  users: { name: string; email: string | null; active: boolean } | { name: string; email: string | null; active: boolean }[] | null;
};

type FarmUser = { id: string; name: string; email: string | null };

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

/**
 * One emailed report: what it is, who gets it, and what actually happened each time.
 *
 * The run history is the point of the bottom half. A send that bounced is the single most
 * useful thing this feature can tell somebody and the easiest thing to lose — an owner who
 * believes their accountant was sent the August figures, and was not, is worse off than an
 * owner who never set a schedule up.
 */
export default async function ReportSchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const gate = await checkEntitlement("advanced_reports");
  const profile = gate.profile;
  const locale = profile.lang;
  const { id } = await params;
  const sp = await searchParams;
  const farmId = await currentFarmId(profile);
  const role = farmId ? await effectiveFarmRole(farmId, profile) : null;

  if (!farmId || !role || !["owner", "manager", "rr_admin"].includes(role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }

  const farmPlan = role === "rr_admin" ? null : await getFarmPlan(farmId);
  const allowed = role === "rr_admin" || Boolean(farmPlan && planAllows(farmPlan, "advanced_reports"));
  if (!allowed) {
    return (
      <div className="flex flex-col gap-5">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("reportSchedules.title", locale)}</h1>
        <UpgradeNotice feature="advanced_reports" requiredPlan={gate.requiredPlan} currentPlan={farmPlan} locale={locale} />
      </div>
    );
  }
  const supabase = await createClient();

  const [{ data: sData }, { data: rData }, { data: runData }, { data: uData }] = await Promise.all([
    supabase
      .from("report_schedules")
      .select("*")
      .eq("id", id)
      .eq("farm_id", farmId)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("report_schedule_recipients")
      .select("id, user_id, email, users(name, email, active)")
      .eq("schedule_id", id)
      .eq("farm_id", farmId)
      .is("deleted_at", null),
    supabase
      .from("report_schedule_runs")
      .select("*")
      .eq("schedule_id", id)
      .eq("farm_id", farmId)
      .is("deleted_at", null)
      .order("period_start", { ascending: false })
      .limit(12),
    supabase
      .from("users")
      .select("id, name, email")
      .eq("farm_id", farmId ?? "")
      .eq("active", true)
      .is("deleted_at", null)
      .order("name"),
  ]);

  const schedule = sData as ReportSchedule | null;
  if (!schedule) notFound();

  const recipients = (rData ?? []) as RecipientRow[];
  const runs = (runData ?? []) as ReportScheduleRun[];
  const farmUsers = (uData ?? []) as FarmUser[];
  const takenUserIds = new Set(recipients.map((r) => r.user_id).filter(Boolean) as string[]);
  const addable = farmUsers.filter((u) => !takenUserIds.has(u.id) && u.email);

  const p = nextPeriod(schedule);
  const live = isLive(schedule);

  const recipientLabel = (r: RecipientRow): string => {
    if (r.email) return r.email;
    const u = one(r.users);
    if (!u) return t("reportSchedules.unknownPerson", locale);
    return u.email ? `${u.name} (${u.email})` : t("reportSchedules.noAddress", locale) + ` — ${u.name}`;
  };

  const runTone = (s: ReportScheduleRun["status"]) =>
    s === "sent" ? "ok" : s === "failed" ? "danger" : "warning";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-sand-900">{schedule.name}</h1>
          <p className="text-sm text-sand-600">
            {t(`reportSchedules.family.${schedule.report_key}`, locale)} ·{" "}
            {t(`reportSchedules.format.${schedule.output_format}`, locale)} ·{" "}
            {t(`cadence.${schedule.cadence}`, locale)}
          </p>
        </div>
        <Link href="/reports/schedules" className="focus-ring ml-auto rounded-lg px-2 py-1 text-sm font-medium text-brand-700 hover:underline">
          {t("reportSchedules.backToList", locale)}
        </Link>
      </div>

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t("reportSchedules.savedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.added ? t("reportSchedules.addedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.removed ? t("reportSchedules.removedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.paused ? t("reportSchedules.pausedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.resumed ? t("reportSchedules.resumedFlash", locale) : undefined} />
      <Flash tone="info" message={sp.nothing ? t("reportSchedules.nothingDueFlash", locale) : undefined} />
      <Flash
        tone={sp.sent && Number(sp.failed ?? 0) > 0 ? "warning" : "success"}
        message={
          sp.sent
            ? `${t("reportSchedules.sentFlash", locale)} ${num(Number(sp.sent), 0)}${
                Number(sp.failed ?? 0) > 0 ? ` · ${t("reportSchedules.someFailed", locale)} ${num(Number(sp.failed), 0)}` : ""
              }`
            : undefined
        }
      />

      {/* ── What happens next ─────────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle>{t("reportSchedules.nextTitle", locale)}</CardTitle></CardHeader>
        {live ? (
          <p className="text-sm text-sand-700">
            {t("reportSchedules.nextGoesOut", locale)} <strong>{shortDate(schedule.next_run_date, locale)}</strong>,{" "}
            {t("reportSchedules.nextCovering", locale)} <strong>{periodLabel(p.from, p.to, locale)}</strong>.
          </p>
        ) : (
          <p className="text-sm text-sand-700">
            {schedule.active ? t("reportSchedules.finishedBody", locale) : t("reportSchedules.pausedBody", locale)}
          </p>
        )}
        {schedule.last_period_start ? (
          <p className="mt-1 text-sm text-sand-600">
            {t("reportSchedules.lastCovered", locale)} {shortDate(schedule.last_period_start, locale)}
            {schedule.last_run_at ? ` · ${dateTime(schedule.last_run_at, locale)}` : ""}
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ConfirmDialog
            action={sendReportScheduleNow}
            triggerLabel={t("reportSchedules.sendNow", locale)}
            triggerIcon={<MailIcon />}
            triggerVariant="primary"
            triggerSize="sm"
            tone="brand"
            title={t("reportSchedules.sendNowTitle", locale)}
            intro={t("reportSchedules.sendNowBody", locale)}
            facts={[
              { label: t("reportSchedules.periodLabel", locale), value: periodLabel(p.from, p.to, locale) },
              { label: t("reportSchedules.toLabel", locale), value: String(recipients.length) },
            ]}
            consequences={[t("reportSchedules.sendNowIdempotent", locale)]}
            confirmLabel={t("reportSchedules.sendNow", locale)}
            cancelLabel={t("common.cancel", locale)}
            closeLabel={t("ui.close", locale)}
          >
            <input type="hidden" name="id" value={schedule.id} />
          </ConfirmDialog>

          <form action={toggleReportSchedule}>
            <input type="hidden" name="id" value={schedule.id} />
            <input type="hidden" name="active" value={schedule.active ? "0" : "1"} />
            <SubmitButton variant="secondary" size="sm">
              {schedule.active ? t("reportSchedules.pause", locale) : t("reportSchedules.resume", locale)}
            </SubmitButton>
          </form>
        </div>
      </Card>

      {/* ── Who gets it ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle>{t("reportSchedules.whoTitle", locale)}</CardTitle></CardHeader>
        <p className="mb-3 text-sm text-sand-600">{t("reportSchedules.whoBody", locale)}</p>

        {recipients.length === 0 ? (
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {t("reportSchedules.noRecipients", locale)}
          </p>
        ) : (
          <ul className="mb-4 flex flex-col gap-2">
            {recipients.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-sand-200 px-3 py-2">
                <span className="text-sm text-sand-900">{recipientLabel(r)}</span>
                <Badge tone={r.email ? "info" : "neutral"}>
                  {r.email ? t("reportSchedules.outsideAddress", locale) : t("reportSchedules.farmPerson", locale)}
                </Badge>
                <span className="ml-auto">
                  <ConfirmDialog
                    action={removeReportRecipient}
                    triggerLabel={t("common.remove", locale)}
                    triggerIcon={<TrashIcon />}
                    triggerVariant="ghost"
                    triggerSize="sm"
                    tone="danger"
                    title={t("reportSchedules.removeWhoTitle", locale)}
                    intro={t("reportSchedules.removeWhoBody", locale)}
                    facts={[{ label: t("reportSchedules.toLabel", locale), value: recipientLabel(r) }]}
                    confirmLabel={t("common.remove", locale)}
                    cancelLabel={t("common.cancel", locale)}
                    closeLabel={t("ui.close", locale)}
                  >
                    <input type="hidden" name="id" value={schedule.id} />
                    <input type="hidden" name="recipient_id" value={r.id} />
                  </ConfirmDialog>
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Somebody on the farm: stored as a reference, never a copy of their address. */}
          <form action={addReportRecipient} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={schedule.id} />
            <input type="hidden" name="who" value="user" />
            <SelectField
              label={t("reportSchedules.addPerson", locale)}
              hint={t("reportSchedules.addPersonHint", locale)}
              name="user_id"
              id={`add-user-${schedule.id}`}
              disabled={addable.length === 0}
              defaultValue=""
            >
              <option value="" disabled>
                {addable.length === 0 ? t("reportSchedules.everyoneAdded", locale) : t("reportSchedules.choosePerson", locale)}
              </option>
              {addable.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </SelectField>
            <div>
              <SubmitButton variant="secondary" size="sm" disabled={addable.length === 0}>
                {t("reportSchedules.addPersonAction", locale)}
              </SubmitButton>
            </div>
          </form>

          {/* An address outside the farm. Said plainly, because it is farm data leaving. */}
          <form action={addReportRecipient} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={schedule.id} />
            <input type="hidden" name="who" value="email" />
            <TextField
              label={t("reportSchedules.addEmail", locale)}
              hint={t("reportSchedules.addEmailHint", locale)}
              type="email"
              name="email"
              id={`add-email-${schedule.id}`}
            />
            <div>
              <SubmitButton variant="secondary" size="sm">{t("reportSchedules.addEmailAction", locale)}</SubmitButton>
            </div>
          </form>
        </div>
      </Card>

      {/* ── The settings ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle>{t("reportSchedules.settingsTitle", locale)}</CardTitle></CardHeader>
        <form action={updateReportSchedule} className="flex flex-col gap-3">
          <input type="hidden" name="id" value={schedule.id} />
          <TextField
            label={t("reportSchedules.name", locale)}
            name="name"
            id={`edit-name-${schedule.id}`}
            required
            maxLength={120}
            defaultValue={schedule.name}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label={t("reportSchedules.whichReport", locale)}
              name="report_key"
              id={`edit-report-${schedule.id}`}
              defaultValue={schedule.report_key}
            >
              {REPORT_KEYS.map((k) => (
                <option key={k} value={k}>{t(`reportSchedules.family.${k}`, locale)}</option>
              ))}
            </SelectField>
            <SelectField
              label={t("reportSchedules.whichFormat", locale)}
              hint={t("reportSchedules.formatHint", locale)}
              name="output_format"
              id={`edit-format-${schedule.id}`}
              defaultValue={schedule.output_format}
            >
              {REPORT_FORMATS.map((f) => (
                <option key={f} value={f}>{t(`reportSchedules.format.${f}`, locale)}</option>
              ))}
            </SelectField>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label={t("reportSchedules.howOften", locale)}
              name="cadence"
              id={`edit-cadence-${schedule.id}`}
              defaultValue={schedule.cadence}
            >
              {REPORT_CADENCES.map((c) => (
                <option key={c} value={c}>{t(`cadence.${c}`, locale)}</option>
              ))}
            </SelectField>
            <TextField
              label={t("reportSchedules.nextRun", locale)}
              hint={t("reportSchedules.nextRunHint", locale)}
              type="date"
              name="next_run_date"
              id={`edit-next-${schedule.id}`}
              defaultValue={schedule.next_run_date}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label={t("reportSchedules.endsOn", locale)}
              hint={t("reportSchedules.endsOnHint", locale)}
              type="date"
              name="ends_on"
              id={`edit-ends-${schedule.id}`}
              defaultValue={schedule.ends_on ?? ""}
            />
            <TextField
              label={t("reportSchedules.site", locale)}
              hint={t("reportSchedules.siteHint", locale)}
              name="site"
              id={`edit-site-${schedule.id}`}
              defaultValue={schedule.site ?? ""}
            />
          </div>

          <SelectField
            label={t("reportSchedules.writtenIn", locale)}
            hint={t("reportSchedules.writtenInHint", locale)}
            name="lang"
            id={`edit-lang-${schedule.id}`}
            defaultValue={schedule.lang}
          >
            <option value="en">English</option>
            <option value="af">Afrikaans</option>
          </SelectField>

          <label className="flex min-h-[48px] items-center gap-2.5 text-sm text-sand-700 sm:min-h-[40px]">
            <input
              type="checkbox"
              name="include_inactive"
              defaultChecked={schedule.include_inactive}
              className="h-5 w-5 rounded border-sand-300"
            />
            {t("reportSchedules.includeInactive", locale)}
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton>{t("common.save", locale)}</SubmitButton>
            <ConfirmDialog
              action={deleteReportSchedule}
              triggerLabel={t("reportSchedules.delete", locale)}
              triggerIcon={<TrashIcon />}
              triggerVariant="ghost"
              triggerSize="sm"
              tone="danger"
              title={t("reportSchedules.deleteTitle", locale)}
              intro={t("reportSchedules.deleteBody", locale)}
              facts={[{ label: t("reportSchedules.nameLabel", locale), value: schedule.name }]}
              consequences={[t("reportSchedules.deleteConsequence", locale)]}
              footnote={t("reportSchedules.deleteFootnote", locale)}
              confirmLabel={t("reportSchedules.delete", locale)}
              cancelLabel={t("common.cancel", locale)}
              closeLabel={t("ui.close", locale)}
            >
              <input type="hidden" name="id" value={schedule.id} />
            </ConfirmDialog>
          </div>
        </form>
      </Card>

      {/* ── What actually happened ────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle>{t("reportSchedules.historyTitle", locale)}</CardTitle></CardHeader>
        {runs.length === 0 ? (
          <AllClear title={t("reportSchedules.historyEmpty", locale)} hint={t("reportSchedules.historyEmptyHint", locale)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 rounded-lg border border-sand-200 px-3 py-2">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-sand-900">
                    {periodLabel(r.period_start, r.period_end, locale)}
                  </span>
                  <Badge tone={runTone(r.status)}>{t(`reportSchedules.runStatus.${r.status}`, locale)}</Badge>
                  <span className="ml-auto text-sm text-sand-600">
                    {r.sent_at ? dateTime(r.sent_at, locale) : dateTime(r.created_at, locale)}
                  </span>
                </span>
                <span className="text-sm text-sand-600">
                  {t("reportSchedules.wentTo", locale)} {r.recipients.join(", ") || "—"}
                </span>
                {r.error ? (
                  <span className="text-sm text-status-overdue">
                    {t("reportSchedules.runError", locale)} {r.error}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
