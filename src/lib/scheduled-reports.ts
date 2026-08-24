import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getReportData } from "@/app/(app)/reports/data";
import {
  buildReportPdf, buildReportWorkbook, csvBytes, gridsAreEmpty, reportGrids,
  type ReportFormat, type ReportKey,
} from "@/lib/report-export";
import { sendEmail, emailConfigured, fromAddress, type EmailAttachment } from "@/lib/email/resend";
import { advanceByCadence, type Cadence } from "@/lib/recurring";
import { t } from "@/lib/i18n";
import type { Lang, Locale } from "@/lib/i18n";
import { shortDate } from "@/lib/format";

/**
 * Scheduled & emailed reports — the worker (FR-11.5, migration 0506).
 *
 * Postgres decides WHICH schedules are due and claims a period; it cannot build a
 * workbook or reach a mail provider. This is the other half: take a claimed run, build
 * the report from the SAME code the /reports screen calls, email it, and write back what
 * happened.
 *
 * The client is passed in on purpose. "Send it now" hands it the caller's RLS-bound
 * client, so the report is assembled under the owner's own permissions and RLS answers
 * every query. The nightly cron has no session at all and hands it the service client —
 * the unavoidable privileged path, and the reason every farm-keyed query in
 * `getReportData` is additionally scoped to the `farm_id` the ENGINE returned, which is a
 * value RLS guaranteed at the moment the schedule was written.
 */

export const REPORT_CADENCES = ["weekly", "monthly", "quarterly", "yearly"] as const;

/** A row of `report_schedules`, as the page reads it. */
export type ReportSchedule = {
  id: string;
  farm_id: string;
  name: string;
  report_key: ReportKey;
  output_format: ReportFormat;
  cadence: Cadence;
  next_run_date: string;
  ends_on: string | null;
  last_period_start: string | null;
  last_run_at: string | null;
  include_inactive: boolean;
  site: string | null;
  lang: Locale;
  active: boolean;
  created_at: string;
};

export type ReportScheduleRun = {
  id: string;
  schedule_id: string;
  period_start: string;
  period_end: string;
  report_key: ReportKey;
  output_format: ReportFormat;
  recipients: string[];
  status: "pending" | "sent" | "failed";
  row_count: number | null;
  bytes: number | null;
  provider: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
};

/** Exactly the row shape `app.run_due_report_schedules` returns. */
export type ClaimedRun = {
  run_id: string;
  schedule_id: string;
  farm_id: string;
  farm_name: string;
  schedule_name: string;
  report_key: ReportKey;
  output_format: ReportFormat;
  lang: Locale;
  period_start: string;
  period_end: string;
  include_inactive: boolean;
  site: string | null;
  recipients: string[];
};

export type RecipientRow = {
  id: string;
  user_id: string | null;
  email: string | null;
};

// ── The period a run covers ──────────────────────────────────────────────────
//
// Mirrors `app.report_period` exactly, so a screen saying "the next one covers August"
// cannot disagree with the month the engine actually reports on. The rule is: the last
// COMPLETE period ending before the run date.

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (v: string) => new Date(`${v}T00:00:00Z`);

/** Monday of the week containing `d` — what Postgres `date_trunc('week', …)` returns. */
function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() - ((out.getUTCDay() + 6) % 7));
  return out;
}

export function reportPeriod(cadence: Cadence, runDate: string): { from: string; to: string } {
  const run = utc(runDate);
  const dayBefore = (d: Date) => {
    const out = new Date(d);
    out.setUTCDate(out.getUTCDate() - 1);
    return out;
  };

  if (cadence === "weekly") {
    const end = dayBefore(startOfWeek(run));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 6);
    return { from: iso(start), to: iso(end) };
  }

  const monthsPer = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
  const truncate = (d: Date) => {
    const m = cadence === "yearly" ? 0 : Math.floor(d.getUTCMonth() / monthsPer) * monthsPer;
    return new Date(Date.UTC(d.getUTCFullYear(), m, 1));
  };
  const end = dayBefore(truncate(run));
  return { from: iso(truncate(end)), to: iso(end) };
}

/** The period the NEXT run will report on — what the schedules screen promises. */
export function nextPeriod(s: Pick<ReportSchedule, "cadence" | "next_run_date">) {
  return reportPeriod(s.cadence, s.next_run_date);
}

/** Will this schedule ever fire again? (Mirrors `isLive` on standing invoices.) */
export function isLive(s: Pick<ReportSchedule, "active" | "ends_on" | "next_run_date">): boolean {
  if (!s.active) return false;
  return s.ends_on == null || s.next_run_date <= s.ends_on;
}

export function isDue(s: Pick<ReportSchedule, "active" | "ends_on" | "next_run_date">, today = iso(new Date())): boolean {
  return isLive(s) && s.next_run_date <= today;
}

export function advanceRun(s: Pick<ReportSchedule, "cadence" | "next_run_date">): string {
  return advanceByCadence(s.next_run_date, s.cadence);
}

// ── What goes in the envelope ────────────────────────────────────────────────

function stamp(filename: string, periodStart: string): string {
  const dot = filename.lastIndexOf(".");
  const base = dot === -1 ? filename : filename.slice(0, dot);
  const ext = dot === -1 ? "" : filename.slice(dot);
  return `${base}-${periodStart}${ext}`;
}

export function periodLabel(from: string, to: string, lang: Lang): string {
  return `${shortDate(from, lang)} – ${shortDate(to, lang)}`;
}

function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type Body = { subject: string; html: string; text: string };

export function reportEmailBody(run: ClaimedRun, opts: { empty: boolean; files: string[] }): Body {
  const lang = run.lang;
  const period = periodLabel(run.period_start, run.period_end, lang);
  const subject = `${run.schedule_name} — ${period}`;
  const reportName = t(`reportSchedules.family.${run.report_key}`, lang);
  const inactive = run.include_inactive
    ? t("reportEmail.includesInactive", lang)
    : t("reportEmail.excludesInactive", lang);

  const facts: [string, string][] = [
    [t("reportEmail.farmLabel", lang), run.farm_name],
    [t("reportEmail.reportLabel", lang), reportName],
    [t("reportEmail.periodLabel", lang), period],
  ];
  if (run.site) facts.push([t("reportEmail.siteLabel", lang), run.site]);

  const attachedLine = opts.files.length > 1
    ? t("reportEmail.attachedMany", lang)
    : t("reportEmail.attachedOne", lang);

  const text = [
    t("reportEmail.greeting", lang),
    "",
    ...facts.map(([k, v]) => `${k}: ${v}`),
    "",
    opts.empty ? t("reportEmail.empty", lang) : attachedLine,
    ...opts.files.map((f) => `  - ${f}`),
    "",
    inactive,
    "",
    t("reportEmail.stop", lang),
    "",
    t("reportEmail.footer", lang),
  ].join("\n");

  const row = (k: string, v: string) => `
    <tr>
      <td style="padding:6px 0;color:#6b6356;font-size:14px;">${esc(k)}</td>
      <td style="padding:6px 0;color:#26221c;font-size:14px;font-weight:600;text-align:right;">${esc(v)}</td>
    </tr>`;

  // Same mail-client constraints as the document and statement emails: tables and inline
  // styles, no flexbox, no webfont, no remote image, plain text always sent alongside.
  const html = `<div style="background:#faf9f7;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e9e5dd;border-radius:12px;overflow:hidden;">
    <tr><td style="background:#15803d;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">${esc(run.schedule_name)}</td></tr>
    <tr><td style="padding:24px;">
      <p style="margin:0 0 16px;color:#26221c;font-size:15px;line-height:1.55;">${esc(t("reportEmail.greeting", lang))}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #e9e5dd;border-bottom:1px solid #e9e5dd;margin:0 0 18px;">
        ${facts.map(([k, v]) => row(k, v)).join("")}
      </table>
      <p style="margin:0 0 10px;color:#26221c;font-size:14px;line-height:1.6;">${esc(opts.empty ? t("reportEmail.empty", lang) : attachedLine)}</p>
      <ul style="margin:0 0 18px;padding-left:18px;color:#6b6356;font-size:13px;line-height:1.7;">
        ${opts.files.map((f) => `<li>${esc(f)}</li>`).join("")}
      </ul>
      <p style="margin:0 0 6px;color:#6b6356;font-size:13px;line-height:1.6;">${esc(inactive)}</p>
      <p style="margin:0;color:#6b6356;font-size:13px;line-height:1.6;">${esc(t("reportEmail.stop", lang))}</p>
    </td></tr>
    <tr><td style="padding:14px 24px;background:#f4f2ee;color:#9a9083;font-size:12px;line-height:1.5;">${esc(t("reportEmail.footer", lang))}</td></tr>
  </table>
</div>`;

  return { subject, html, text };
}

// ── The worker ───────────────────────────────────────────────────────────────

export type DeliveryResult = {
  runId: string;
  status: "sent" | "failed";
  sent: number;
  failed: number;
  error: string | null;
};

/**
 * Build one claimed run and email it.
 *
 * Outcome rule, stated because it is a judgement: a run counts as SENT if at least one
 * address took it, and the addresses that bounced are recorded on the run row for the
 * owner to see. Marking a part-delivered period FAILED would make it eligible for a
 * retry, and a retry re-sends to everyone who already has it — a duplicate report in an
 * accountant's inbox is worse than one recorded bounce somebody can act on. Only a run
 * where NOTHING went out is failed, and that one genuinely should be tried again.
 */
export async function deliverReportRun(
  supabase: SupabaseClient,
  run: ClaimedRun,
): Promise<DeliveryResult> {
  const finish = async (r: Omit<DeliveryResult, "runId">, extra: Record<string, unknown> = {}) => {
    await supabase
      .from("report_schedule_runs")
      .update({
        status: r.status,
        error: r.error,
        sent_at: r.status === "sent" ? new Date().toISOString() : null,
        ...extra,
      })
      .eq("id", run.run_id);
    return { runId: run.run_id, ...r };
  };

  if (!emailConfigured()) {
    // No silent success. The run row says exactly why nothing left the building.
    return finish({ status: "failed", sent: 0, failed: run.recipients.length, error: "email-not-configured" });
  }

  let attachments: EmailAttachment[];
  let empty: boolean;
  let rowCount: number;
  try {
    const data = await getReportData(
      supabase,
      {
        from: run.period_start,
        to: run.period_end,
        includeInactive: run.include_inactive,
        group: run.site,
      },
      run.farm_id,
    );
    const grids = reportGrids(data, run.report_key);
    empty = gridsAreEmpty(grids);
    rowCount = grids.reduce((n, g) => n + g.count, 0);

    if (run.output_format === "csv") {
      attachments = grids.map((g) => ({ filename: stamp(g.filename, run.period_start), content: csvBytes(g) }));
    } else if (run.output_format === "xlsx") {
      attachments = [{
        filename: stamp("fleetwise-reports.xlsx", run.period_start),
        content: buildReportWorkbook(data, run.report_key),
      }];
    } else {
      attachments = [{
        filename: stamp("fleetwise-report.pdf", run.period_start),
        content: await buildReportPdf(data, run.report_key, {
          farmName: run.farm_name,
          scheduleName: run.schedule_name,
          periodFrom: run.period_start,
          periodTo: run.period_end,
          site: run.site,
          includeInactive: run.include_inactive,
        }),
      }];
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "build-failed";
    return finish({ status: "failed", sent: 0, failed: run.recipients.length, error: `build: ${message}` });
  }

  const body = reportEmailBody(run, { empty, files: attachments.map((a) => a.filename) });
  const from = fromAddress(run.farm_name);
  const bytes = attachments.reduce((n, a) => n + a.content.byteLength, 0);

  let sent = 0;
  let providerId: string | null = null;
  const failures: string[] = [];
  for (const to of run.recipients) {
    const res = await sendEmail({ to, from, subject: body.subject, html: body.html, text: body.text, attachments });
    if (res.ok) {
      sent += 1;
      providerId = providerId ?? res.id;
    } else {
      failures.push(`${to}: ${res.error}`);
    }
  }

  return finish(
    {
      status: sent > 0 ? "sent" : "failed",
      sent,
      failed: failures.length,
      error: failures.length ? failures.join("; ").slice(0, 900) : null,
    },
    { row_count: rowCount, bytes, provider: "resend", provider_id: providerId },
  );
}

/**
 * The nightly step (spliced into /api/cron/nightly).
 *
 * The SQL claims every due period in ONE transaction — so a second cron firing at the
 * same moment finds nothing left to claim — and this then builds and sends them one at a
 * time. A build or a bounce on one farm's report cannot stop another farm's: each run
 * carries its own outcome row.
 */
export async function runDueReportSchedules(
  supabase: SupabaseClient,
): Promise<{ claimed: number; sent: number; failed: number; error?: string }> {
  const { data, error } = await supabase.rpc("cron_run_due_report_schedules");
  if (error) return { claimed: 0, sent: 0, failed: 0, error: error.message };

  const runs = (data ?? []) as ClaimedRun[];
  let sent = 0;
  let failed = 0;
  for (const run of runs) {
    const r = await deliverReportRun(supabase, run);
    if (r.status === "sent") sent += 1;
    else failed += 1;
  }
  return { claimed: runs.length, sent, failed };
}
