import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { deliverPush } from "@/lib/push/deliver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Run a Web-Push delivery pass on demand (service-role). Same auth as the nightly cron:
 * `Authorization: Bearer ${CRON_SECRET}`. The nightly route also calls deliverPush()
 * directly after enqueuing, so this exists mainly for external triggering / manual testing.
 * No-ops gracefully (skipped) when VAPID keys are unset.
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const supabase = createServiceClient();
  const result = await deliverPush(supabase);
  return NextResponse.json({ ranAt: new Date().toISOString(), ...result });
}

export const GET = handle;
export const POST = handle;
