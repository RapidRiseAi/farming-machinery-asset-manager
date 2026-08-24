import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { captureError } from "@/lib/observability";
import { deliverPush } from "@/lib/push/deliver";
import { runDueReportSchedules } from "@/lib/scheduled-reports";

/**
 * Nightly maintenance cron (Scope §4.3 nightly recompute, §4.7 alerts).
 *
 * Runs, in order, as the service role (bypasses RLS via trusted server code):
 *   1. cron_recalc_all_due            — recompute calendar/hour dues (calendar drifts nightly)
 *   2. cron_enqueue_service_notifications — due-soon/overdue in-app notifications (deduped)
 *   3. cron_enqueue_stale_meter_nudges    — one "reading outdated" nudge per farm
 *   4. cron_enqueue_fuel_anomalies        — fuel leak/theft anomalies (deduped, F4)
 *   5. cron_enqueue_expiry_notifications  — warranty/licence expiry reminders (deduped, F6)
 *   6. cron_enqueue_work_request_reminders — outstanding quote/invoice chasers (deduped, F13)
 *   7. cron_enqueue_aarto_nominations     — AARTO nomination-deadline reminders (deduped, G2)
 *   8. cron_enqueue_document_reminders   — expire stale quotes, chase overdue invoices (G2)
 *   9. cron_generate_recurring_invoices   — standing invoices due today (idempotent, G8)
 *  10. cron_enqueue_low_stock             — parts at or below their reorder point (0451)
 *  11. cron_enqueue_stock_shortfall       — parts the next N days of services need (0503)
 *  12. cron_enqueue_weekly_digest         — Mondays only (Africa/Johannesburg)
 *  13. push delivery                      — Web Push for the freshly-queued rows (F6)
 *
 * Scheduled report delivery runs after the database steps and before push delivery.
 *
 * Auth: requires `Authorization: Bearer ${CRON_SECRET}`. Vercel Cron automatically
 * sends this header when a CRON_SECRET env var is set (see docs/CRON.md), so the same
 * check covers Vercel's scheduler and any external pinger.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const steps: Record<string, string> = {};

  const run = async (name: string, fn: string): Promise<void> => {
    const { error } = await supabase.rpc(fn);
    steps[name] = error ? `error: ${error.message}` : "ok";
    if (error) {
      // A step failing at 03:01 has been completely invisible until now: this response body
      // goes back to Vercel's scheduler and nobody ever reads it, so a broken engine could
      // stay broken for weeks while the other twelve kept working.
      //
      // Reported, and deliberately NOT rethrown — step 7 failing must not stop steps 8
      // through 13. A partial night is worth much more than no night.
      captureError(new Error(error.message), { where: `cron:${name}`, extra: { rpc: fn } });
    }
  };

  await run("recalc_all_due", "cron_recalc_all_due");
  await run("service_notifications", "cron_enqueue_service_notifications");
  await run("stale_meter_nudges", "cron_enqueue_stale_meter_nudges");
  await run("fuel_anomalies", "cron_enqueue_fuel_anomalies");
  await run("expiry_notifications", "cron_enqueue_expiry_notifications");
  await run("work_request_reminders", "cron_enqueue_work_request_reminders");
  await run("aarto_nominations", "cron_enqueue_aarto_nominations");
  await run("document_reminders", "cron_enqueue_document_reminders");
  // Standing invoices whose date has come round. Safe to re-run: the generator keys on
  // the period it last raised, so a double-fired night cannot bill anybody twice.
  await run("recurring_invoices", "cron_generate_recurring_invoices");

  // Costs that repeat (G19). Same idempotency shape as the invoice generator above: it
  // keys on the period it last covered, so a double-fired night cannot book rent twice.
  await run("recurring_expenses", "cron_generate_recurring_expenses");

  // What the store is running out of (0451). Weekly per item, quiet hours honoured.
  await run("low_stock", "cron_enqueue_low_stock");

  // What the schedule has already spoken for (0503). Weekly per item, quiet hours honoured.
  await run("stock_shortfall", "cron_enqueue_stock_shortfall");

  // Weekly digest fires only on Mondays in SAST (the caller decides — the SQL just enqueues).
  const sastWeekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Johannesburg",
    weekday: "short",
  }).format(new Date());
  if (sastWeekday === "Mon") {
    await run("weekly_digest", "cron_enqueue_weekly_digest");
  } else {
    steps["weekly_digest"] = "skipped (not Monday SAST)";
  }

  // Claim, build and email report periods after the night's recalculations and recurring
  // entries, so every attachment reflects the same final state a person sees in /reports.
  // A failed report is recorded on its own run and does not stop push delivery.
  try {
    const reports = await runDueReportSchedules(supabase);
    if (reports.error) {
      steps["scheduled_reports"] = `error: ${reports.error}`;
      captureError(new Error(reports.error), { where: "cron:scheduled_reports" });
    } else if (reports.failed > 0) {
      steps["scheduled_reports"] = `error: ${reports.failed} of ${reports.claimed} run(s) failed`;
      captureError(new Error(steps["scheduled_reports"]), {
        where: "cron:scheduled_reports",
        extra: reports,
      });
    } else {
      steps["scheduled_reports"] = `ok (claimed ${reports.claimed}, sent ${reports.sent})`;
    }
  } catch (err) {
    steps["scheduled_reports"] = `error: ${err instanceof Error ? err.message : "unknown"}`;
    captureError(err, { where: "cron:scheduled_reports" });
  }

  // Web Push for everything just enqueued and now deliverable (no-op if VAPID unset).
  try {
    const push = await deliverPush(supabase);
    steps["push_delivery"] = push.skipped ? `skipped (${push.skipped})` : `ok (pushed ${push.pushed})`;
  } catch (err) {
    steps["push_delivery"] = `error: ${err instanceof Error ? err.message : "unknown"}`;
    // Same reasoning as `run` above: a delivery failure here means the whole night's alerts
    // reached nobody's phone, which is the one failure most worth hearing about.
    captureError(err, { where: "cron:push_delivery" });
  }

  const ok = Object.values(steps).every((s) => s === "ok" || s.startsWith("skipped") || s.startsWith("ok"));
  return NextResponse.json(
    { ok, ranAt: new Date().toISOString(), steps },
    { status: ok ? 200 : 500 }
  );
}
