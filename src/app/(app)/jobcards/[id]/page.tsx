import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { removeLine, toggleServiceLine } from "../actions";
import { LineEntry } from "../line-entry";
import { JobCardEditor } from "../job-card-editor";
import { LifecycleActions } from "../lifecycle-actions";

type JobCard = {
  id: string; farm_id: string; machine_id: string; type: string; status: string;
  date_in: string | null; date_out: string | null; meter_reading: number | null;
  reported_problem: string | null; diagnosis: string | null; work_performed: string | null; recommendations: string | null;
  parts_total_cents: number; labour_total_cents: number; other_total_cents: number; total_cents: number;
  vat_rate_bps: number; locked: boolean; approved_at: string | null; approved_by: string | null; created_from_fault_id: string | null;
};
type Line = {
  id: string; kind: string; description: string | null; part_no: string | null;
  qty: number | null; unit_cost_cents: number | null; hours: number | null; rate_cents: number | null; total_cents: number;
};
type PlanLine = { id: string; task: string; status: string };

const savedMsg: Record<string, string> = {
  "1": "ui.saved", line: "ui.saved", service: "ui.saved", completed: "ui.saved", approved: "ui.saved",
};

export default async function JobCardDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  const { id } = await params;
  const sp = await searchParams;
  const locale = profile.language;

  const supabase = await createClient();
  const { data } = await supabase.from("job_cards").select("*").eq("id", id).is("deleted_at", null).maybeSingle();
  const jc = data as JobCard | null;
  if (!jc) notFound();

  const [{ data: machineData }, { data: linesData }, { data: planData }, { data: coverData }] = await Promise.all([
    supabase.from("machines").select("name, meter_type").eq("id", jc.machine_id).maybeSingle(),
    supabase.from("job_card_lines").select("id, kind, description, part_no, qty, unit_cost_cents, hours, rate_cents, total_cents").eq("job_card_id", id).is("deleted_at", null),
    supabase.from("service_plan_lines").select("id, task, status").eq("machine_id", jc.machine_id).is("deleted_at", null),
    supabase.from("job_card_service_lines").select("service_plan_line_id").eq("job_card_id", id),
  ]);
  const machine = machineData as { name: string; meter_type: string } | null;
  const lines = (linesData as Line[] | null) ?? [];
  const planLines = (planData as PlanLine[] | null) ?? [];
  const covered = new Set(((coverData as { service_plan_line_id: string }[] | null) ?? []).map((c) => c.service_plan_line_id));

  const canApprove = profile.role === "owner" || profile.role === "manager";
  const locked = jc.locked;

  const statusTone = (s: string): BadgeTone =>
    s === "approved" || s === "completed" ? "ok" : s === "waiting_parts" ? "warning" : "info";
  const lineDetail = (l: Line) =>
    l.kind === "part"
      ? `${l.qty ?? 0} × ${rands(l.unit_cost_cents)}`
      : l.kind === "labour"
        ? `${l.hours ?? 0}h × ${rands(l.rate_cents)}`
        : rands(l.unit_cost_cents);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Link href="/jobcards" className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-sm text-sand-500">
        <ChevronLeftIcon className="text-[1rem]" />
        {t("jobcards.back", locale)}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{machine?.name ?? t("jobcards.title", locale)}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{t(`jobType.${jc.type}`, locale)}</Badge>
            <Badge tone={statusTone(jc.status)}>{t(`jobStatus.${jc.status}`, locale)}</Badge>
          </div>
        </div>
        <a href={`/jobcards/${jc.id}/pdf`} className="focus-ring rounded-md text-sm text-brand-700">PDF →</a>
      </div>

      {locked ? (
        <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
          🔒 {t("jobcards.lockedBanner", locale)}
          {jc.approved_at ? ` · ${t("jobcards.approvedBy", locale)}: ${jc.approved_at.slice(0, 10)}` : ""}
        </div>
      ) : null}

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t(savedMsg[sp.saved] ?? "ui.saved", locale) : undefined} />

      {/* Totals */}
      <Card>
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><p className="text-sand-500">{t("jobcards.parts", locale)}</p><p className="font-medium text-sand-900">{rands(jc.parts_total_cents)}</p></div>
          <div><p className="text-sand-500">{t("jobcards.labour", locale)}</p><p className="font-medium text-sand-900">{rands(jc.labour_total_cents)}</p></div>
          <div><p className="text-sand-500">{t("jobcards.other", locale)}</p><p className="font-medium text-sand-900">{rands(jc.other_total_cents)}</p></div>
          <div><p className="text-sand-500">{t("jobcards.totalExVat", locale)}</p><p className="text-lg font-bold text-sand-900">{rands(jc.total_cents)}</p></div>
        </div>
      </Card>

      {/* Lines */}
      <Card>
        <CardHeader><CardTitle>{t("jobcards.lines", locale)}</CardTitle></CardHeader>
        {lines.length === 0 ? (
          <p className="text-sm text-sand-400">{t("jobcards.noLines", locale)}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-sand-100 text-sm">
            {lines.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="font-medium text-sand-900">{l.description ?? t(`jobcards.${l.kind}Kind`, locale)}</span>
                  <span className="ml-2 text-sand-500">{lineDetail(l)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-medium">{rands(l.total_cents)}</span>
                  {!locked ? (
                    <form action={removeLine}>
                      <input type="hidden" name="line_id" value={l.id} />
                      <input type="hidden" name="job_card_id" value={jc.id} />
                      <button className="focus-ring rounded px-1 text-status-overdue" aria-label={t("jobcards.remove", locale)}>✕</button>
                    </form>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {!locked ? (
          <div className="mt-3">
            <LineEntry jobCardId={jc.id} farmId={jc.farm_id} vatRateBps={jc.vat_rate_bps} locale={locale} />
          </div>
        ) : null}
      </Card>

      {/* Covered service lines */}
      {jc.type === "scheduled_service" && !locked && planLines.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t("jobcards.serviceLinesCovered", locale)}</CardTitle></CardHeader>
          <p className="mb-2 text-xs text-sand-500">{t("jobcards.serviceLinesHint", locale)}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {planLines.map((pl) => (
              <li key={pl.id}>
                <form action={toggleServiceLine} className="flex items-center gap-2">
                  <input type="hidden" name="job_card_id" value={jc.id} />
                  <input type="hidden" name="farm_id" value={jc.farm_id} />
                  <input type="hidden" name="service_plan_line_id" value={pl.id} />
                  <input type="hidden" name="on" value={covered.has(pl.id) ? "0" : "1"} />
                  <button className={`focus-ring rounded ${covered.has(pl.id) ? "text-status-ok" : "text-sand-400"}`}>
                    {covered.has(pl.id) ? "☑" : "☐"}
                  </button>
                  <span>{pl.task}</span>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Details / lifecycle */}
      {!locked ? (
        <>
          <Card>
            <CardHeader><CardTitle>{t("jobcards.details", locale)}</CardTitle></CardHeader>
            <JobCardEditor
              id={jc.id}
              meterType={machine?.meter_type ?? "none"}
              locale={locale}
              initial={{
                status: jc.status,
                date_in: jc.date_in ?? "",
                date_out: jc.date_out ?? "",
                meter_reading: jc.meter_reading != null ? String(jc.meter_reading) : "",
                reported_problem: jc.reported_problem ?? "",
                diagnosis: jc.diagnosis ?? "",
                work_performed: jc.work_performed ?? "",
                recommendations: jc.recommendations ?? "",
              }}
            />
          </Card>
          <LifecycleActions id={jc.id} meterReading={jc.meter_reading} canApprove={canApprove} locale={locale} />
        </>
      ) : (
        <Card>
          <CardHeader><CardTitle>{t("jobcards.details", locale)}</CardTitle></CardHeader>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-sand-500">{t("jobcards.dateIn", locale)}</dt><dd>{jc.date_in ?? "—"}</dd></div>
            <div><dt className="text-sand-500">{t("jobcards.dateOut", locale)}</dt><dd>{jc.date_out ?? "—"}</dd></div>
            <div><dt className="text-sand-500">{t("jobcards.meterReading", locale)}</dt><dd>{jc.meter_reading ?? "—"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-sand-500">{t("jobcards.reportedProblem", locale)}</dt><dd className="whitespace-pre-wrap">{jc.reported_problem ?? "—"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-sand-500">{t("jobcards.diagnosis", locale)}</dt><dd className="whitespace-pre-wrap">{jc.diagnosis ?? "—"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-sand-500">{t("jobcards.workPerformed", locale)}</dt><dd className="whitespace-pre-wrap">{jc.work_performed ?? "—"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-sand-500">{t("jobcards.recommendations", locale)}</dt><dd className="whitespace-pre-wrap">{jc.recommendations ?? "—"}</dd></div>
          </dl>
        </Card>
      )}
    </div>
  );
}
