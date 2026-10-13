import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { drainNotifications } from "@/lib/notifications/drain-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One run's share of the minute: the next run starts while this one would still be going. */
const BUDGET_MS = 40_000;

/**
 * Run a Web-Push delivery pass on demand (service-role). Same auth as the nightly cron:
 * `Authorization: Bearer ${CRON_SECRET}`. The nightly route also calls deliverPush()
 * directly after enqueuing. Schedule this route externally every minute to drain batches,
 * deliver daytime notifications, and retry after the five-minute backoff (docs/CRON.md).
 * No-ops gracefully (skipped) when VAPID keys are unset.
 *
 * Each run drains: pass after pass of 25 while either channel came back full and time
 * remains (src/lib/notifications/drain-delivery.ts). One pass a run was 25 a minute at most.
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const supabase = createServiceClient();
  // Push, and the same alerts by email for whoever asked for them (20260920130000). Email
  // runs here as well as nightly so a service falling due at nine in the morning does not
  // wait until 03:01 for the one channel that reaches an owner who never opens the app.
  // Claims are leased, so two runs overlapping cannot send the same reminder twice.
  const drained = await drainNotifications(supabase, BUDGET_MS);
  return NextResponse.json(
    { ranAt: new Date().toISOString(), ...drained.push, email: drained.email, rounds: drained.rounds, more: drained.more },
    { status: drained.ok ? 200 : 503 },
  );
}

export const GET = handle;
export const POST = handle;
