import { NextResponse } from "next/server";

import { CRON_RPC } from "@/lib/cron/heartbeat";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Is the product up, and is it running its scheduled work? For an external uptime monitor.
 *
 * 503 when the database does not answer, or a scheduled route has not started within its
 * window, or its last run started over an hour ago and never finished (it crashed or hung).
 * A cron that stops firing produces no error anywhere (the billing pass writes nothing on a
 * quiet night, see src/lib/cron/heartbeat.ts), so watching this one URL from outside is
 * what turns "nothing happened" into an alert.
 *
 * A run that finished with a failed step is a WARNING, still 200: one bounced report email
 * must not show the whole product as down all day. Failed steps are reported where they
 * happen (Sentry, and the nightly alert email).
 *
 * Open to anyone, so it says nothing anyone could use: route names, whether each last run
 * finished and succeeded, and hours since it started. No farm, user, count or row content.
 */

export const dynamic = "force-dynamic";

/** The scheduled routes and the hours since their last start before the check fails: a
 *  daily schedule plus slack. */
const EXPECTED: Record<string, number> = {
  "/api/cron/nightly": 26,
  "/api/cron/billing": 26,
};

/** Long enough for a cold database, short enough that a monitor's own timeout is not hit. */
const DB_TIMEOUT_MS = 5_000;

type CronHealth = {
  route: string;
  last_finished_at: string | null;
  last_ok: boolean | null;
  hours_since: number | string | null;
};

export async function GET() {
  const problems: string[] = [];
  const warnings: string[] = [];
  let routes: CronHealth[] | null = null;
  try {
    const read = createServiceClient().rpc(CRON_RPC.health);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("database did not answer in time")), DB_TIMEOUT_MS),
    );
    const { data, error } = await Promise.race([read, timeout]);
    if (error) throw new Error("database refused the health read");
    routes = (data as CronHealth[] | null) ?? [];
  } catch (err) {
    problems.push(err instanceof Error ? err.message : "database unreachable");
  }

  const crons = Object.entries(EXPECTED).map(([route, maxHours]) => {
    const row = routes?.find((r) => r.route === route);
    const hours = row?.hours_since == null ? null : Number(row.hours_since);
    const finished = row?.last_finished_at != null;
    if (routes !== null) {
      if (!row || hours == null) problems.push(`${route} has no run on record`);
      else if (hours > maxHours) problems.push(`${route} last started ${hours} hours ago`);
      else if (!finished && hours > 1) problems.push(`${route} started ${hours} hours ago and never finished`);
      else if (finished && row.last_ok === false) warnings.push(`${route}: a step failed in the last run`);
    }
    return { route, hoursSince: hours, finished, lastOk: row?.last_ok ?? null };
  });

  const healthy = problems.length === 0;
  return NextResponse.json(
    { ok: healthy, checkedAt: new Date().toISOString(), problems, warnings, crons },
    { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
