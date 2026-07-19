import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Nightly maintenance cron (Scope §4.3 nightly recompute, §4.7 alerts).
 *
 * Runs, in order, as the service role (bypasses RLS via trusted server code):
 *   1. cron_recalc_all_due            — recompute calendar/hour dues (calendar drifts nightly)
 *   2. cron_enqueue_service_notifications — due-soon/overdue in-app notifications (deduped)
 *   3. cron_enqueue_stale_meter_nudges    — one "reading outdated" nudge per farm
 *   4. cron_enqueue_weekly_digest         — Mondays only (Africa/Johannesburg)
 *
 * Auth: requires `Authorization: Bearer ${CRON_SECRET}`. Vercel Cron automatically
 * sends this header when a CRON_SECRET env var is set (see docs/CRON.md), so the same
 * check covers Vercel's scheduler and any external pinger.
 */
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
  };

  await run("recalc_all_due", "cron_recalc_all_due");
  await run("service_notifications", "cron_enqueue_service_notifications");
  await run("stale_meter_nudges", "cron_enqueue_stale_meter_nudges");

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

  const ok = Object.values(steps).every((s) => s === "ok" || s.startsWith("skipped"));
  return NextResponse.json(
    { ok, ranAt: new Date().toISOString(), steps },
    { status: ok ? 200 : 500 }
  );
}
