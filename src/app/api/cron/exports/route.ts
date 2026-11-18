import { NextResponse } from "next/server";

import { runExportWorker } from "@/lib/farm-export/job";
import { captureError } from "@/lib/observability";
import { bearerMatches } from "@/lib/security/bearer";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * The complete export worker on its own schedule (20261120110000). The nightly pass already runs
 * it for 45 seconds; a scheduler calling this every few minutes (same `CRON_SECRET` bearer as the
 * nightly route, docs/CRON.md) finishes large exports the same day without anyone watching. It
 * copies only files the requester's own session listed, and asks the database first whether the
 * requester may still export. Without a schedule, exports still finish: the page drives them
 * while it is open, and the nightly pass carries on.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runExportWorker(createServiceClient(), 90_000);
    return NextResponse.json({ ok: result.startsWith("ok"), result }, { status: result.startsWith("ok") ? 200 : 500 });
  } catch (error) {
    captureError(error, { where: "cron:exports" });
    return NextResponse.json({ error: "export_worker_failed" }, { status: 503 });
  }
}
