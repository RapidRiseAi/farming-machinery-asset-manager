import Link from "next/link";
import { errorMessage } from "@/lib/errors";
import {
  checkEntitlement,
  currentFarmId,
  effectiveFarmRole,
  getFarmPlan,
  homePathFor,
} from "@/lib/auth";
import { planAllows } from "@/lib/entitlements";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { shortDate, todayLocal } from "@/lib/format";
import {
  isDue, isLive, nextPeriod, periodLabel, REPORT_CADENCES, type ReportSchedule,
} from "@/lib/scheduled-reports";
import { REPORT_FORMATS, REPORT_KEYS } from "@/lib/report-export";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { GetStarted } from "@/components/ui/empty-state";
import { TextField, SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { ChevronRightIcon, PlusIcon } from "@/components/ui/icons";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { createReportSchedule } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Emailed reports (FR-11.5).
 *
 * `/reports` has always been able to answer the question; it has never been able to
 * answer it without being asked. This screen is the standing instruction, this report,
 * this often, to these people, and it leads with what is going out next, because the
 * failure it exists to prevent is a schedule that quietly stopped working and a farm that
 * did not notice because nothing arrived.
 *
 * Setting one up is the header's one primary action, and its fields live in a dialog:
 * the page used to open on an eight-control form above the list it fills.
 */
export default async function ReportSchedulesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const gate = await checkEntitlement("advanced_reports");
  const profile = gate.profile;
  const locale = profile.lang;
  const sp = await searchParams;

  const title = t("reportSchedules.title", locale);
  const back = { href: "/reports", label: t("reports.title", locale) };
  const farmId = await currentFarmId(profile);
  const role = farmId ? await effectiveFarmRole(farmId, profile) : null;

  // A person's primary profile role does not grant authority in every farm they can
  // access. The membership role of the selected farm is the role for this screen.
  if (!farmId || !role || !["owner", "manager", "rr_admin"].includes(role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }

  const farmPlan = role === "rr_admin" ? null : await getFarmPlan(farmId);
  const allowed = role === "rr_admin" || Boolean(farmPlan && planAllows(farmPlan, "advanced_reports"));

  if (!allowed) {
    return (
      <PageContainer>
        <PageHeader title={title} back={back} />
        <UpgradeNotice
          feature="advanced_reports"
          requiredPlan={gate.requiredPlan}
          currentPlan={farmPlan}
          locale={locale}
          canUpgrade={role === "owner"}
        />
      </PageContainer>
    );
  }

  const supabase = await createClient();

  const q = supabase
    .from("report_schedules")
    .select("*")
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .order("next_run_date");
  const { data } = await q;
  const schedules = (data ?? []) as ReportSchedule[];

  // The farm's day, not UTC's: before 02:00 in South Africa UTC is still on yesterday.
  const today = todayLocal();
  const due = schedules.filter((s) => isDue(s, today));

  const newSchedule = (
    <DialogForm
      trigger={t("reportSchedules.newAction", locale)}
      triggerIcon={<PlusIcon />}
      title={t("reportSchedules.addTitle", locale)}
      description={t("reportSchedules.addBody", locale)}
      closeLabel={t("ui.close", locale)}
      size="lg"
    >
      <form action={createReportSchedule} className="flex flex-col gap-3">
        <TextField
          label={t("reportSchedules.name", locale)}
          hint={t("reportSchedules.nameHint", locale)}
          name="name"
          required
          maxLength={120}
        />
        <DialogFields>
          <SelectField label={t("reportSchedules.whichReport", locale)} name="report_key" defaultValue="all">
            {REPORT_KEYS.map((k) => (
              <option key={k} value={k}>{t(`reportSchedules.family.${k}`, locale)}</option>
            ))}
          </SelectField>
          <SelectField
            label={t("reportSchedules.whichFormat", locale)}
            hint={t("reportSchedules.formatHint", locale)}
            name="output_format"
            defaultValue="xlsx"
          >
            {REPORT_FORMATS.map((f) => (
              <option key={f} value={f}>{t(`reportSchedules.format.${f}`, locale)}</option>
            ))}
          </SelectField>
          <SelectField label={t("reportSchedules.howOften", locale)} name="cadence" defaultValue="monthly">
            {REPORT_CADENCES.map((c) => (
              <option key={c} value={c}>{t(`cadence.${c}`, locale)}</option>
            ))}
          </SelectField>
          <TextField
            label={t("reportSchedules.startOn", locale)}
            hint={t("reportSchedules.startOnHint", locale)}
            type="date"
            name="next_run_date"
            defaultValue={today}
          />
        </DialogFields>
        <SelectField
          label={t("reportSchedules.writtenIn", locale)}
          hint={t("reportSchedules.writtenInHint", locale)}
          name="lang"
          defaultValue={profile.language === "af" ? "af" : "en"}
        >
          <option value="en">English</option>
          <option value="af">Afrikaans</option>
        </SelectField>
        <Checkbox name="include_inactive" label={t("reportSchedules.includeInactive", locale)} />
        <DialogActions cancelLabel={t("common.cancel", locale)}>
          <SubmitButton>{t("reportSchedules.addAction", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  return (
    <PageContainer>
      <PageHeader
        title={title}
        lead={t("reportSchedules.lead", locale)}
        infoKey="reportSchedules"
        locale={locale}
        back={back}
        actions={newSchedule}
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.created ? t("reportSchedules.createdFlash", locale) : undefined} />
      <Flash tone="success" message={sp.deleted ? t("reportSchedules.deletedFlash", locale) : undefined} />

      {due.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t("reportSchedules.dueTitle", locale)}</CardTitle></CardHeader>
          <p className="mb-3 text-sm text-sand-600">{t("reportSchedules.dueBody", locale)}</p>
          <ul className="flex flex-col gap-2">
            {due.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/reports/schedules/${s.id}`}
                  className="focus-ring flex min-h-[48px] flex-wrap items-center gap-2 rounded-lg border border-sand-200 px-3 py-2.5 hover:bg-sand-50"
                >
                  <span className="min-w-0 font-medium text-sand-900">{s.name}</span>
                  <Badge tone="warning">{t("reportSchedules.dueBadge", locale)}</Badge>
                  <span className="ml-auto text-sm text-sand-600">
                    {periodLabel(nextPeriod(s).from, nextPeriod(s).to, locale)}
                  </span>
                  {/* A span, not a link: the row is already an anchor and a nested one is
                      the invalid HTML that threw React #418 on the machines list. */}
                  <span className="text-sm font-medium text-brand-ink">{t("reportSchedules.dueOpen", locale)} →</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>{t("reportSchedules.listTitle", locale)}</CardTitle></CardHeader>
        {schedules.length === 0 ? (
          <GetStarted
            title={t("reportSchedules.emptyTitle", locale)}
            hint={t("reportSchedules.emptyBody", locale)}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {schedules.map((s) => {
              const p = nextPeriod(s);
              return (
                <li key={s.id} id={`s-${s.id}`}>
                  <Link
                    href={`/reports/schedules/${s.id}`}
                    className="focus-ring flex min-h-[48px] items-center gap-3 rounded-lg border border-sand-200 px-3 py-2.5 hover:bg-sand-50"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 font-medium text-sand-900">{s.name}</span>
                        {!s.active ? <Badge tone="neutral">{t("reportSchedules.paused", locale)}</Badge> : null}
                        {s.active && !isLive(s) ? <Badge tone="neutral">{t("reportSchedules.finished", locale)}</Badge> : null}
                      </span>
                      <span className="text-sm text-sand-600">
                        {t(`reportSchedules.family.${s.report_key}`, locale)} · {t(`cadence.${s.cadence}`, locale)} · {t(`reportSchedules.format.${s.output_format}`, locale)}
                      </span>
                      {s.active ? (
                        <span className="text-sm text-sand-500">
                          {`${t("reportSchedules.nextRun", locale)}: ${shortDate(s.next_run_date, locale)} (${periodLabel(p.from, p.to, locale)})`}
                        </span>
                      ) : null}
                    </span>
                    <ChevronRightIcon className="shrink-0 text-lg text-sand-400" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </PageContainer>
  );
}
