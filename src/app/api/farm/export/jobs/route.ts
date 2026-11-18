import { NextResponse } from "next/server";

import { exportAccess, NO_STORE } from "@/lib/farm-export/access";
import { PUBLIC_JOB_COLUMNS, runExportStep } from "@/lib/farm-export/job";
import { readRequestId } from "@/lib/request-id";
import { captureError } from "@/lib/observability";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * The complete export (20261120110000): start one (POST) or see the person's recent ones for a
 * business (GET). Starting checks the role and the lifecycle, makes the job (one at a time per
 * business, idempotent by the screen's request id), lists the files with the requester's own
 * session and takes the first step. The page then moves it on, and the nightly worker finishes
 * the files of a job nobody is watching.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const access = await exportAccess(new URL(request.url).searchParams.get("farm"));
  if (!access.ok) return access.response;
  const { data, error } = await access.session
    .from("farm_export_jobs")
    .select(PUBLIC_JOB_COLUMNS)
    .eq("farm_id", access.farmId)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  return NextResponse.json({ jobs: data ?? [] }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { farm?: string };
  const access = await exportAccess(typeof body.farm === "string" ? body.farm : null);
  if (!access.ok) return access.response;
  const requestId = readRequestId(request.headers.get("x-request-id"));
  if (!requestId) return NextResponse.json({ error: "missing-id" }, { status: 400, headers: NO_STORE });

  const svc = createServiceClient();
  const { data, error } = await svc.rpc("export_job_create", { p_by: access.userId, p_farm: access.farmId, p_request: requestId });
  if (error) {
    const code = error.message === "export-limit" ? "export-limit" : error.message === "export-not-allowed" ? "export-not-allowed" : "export-failed";
    if (code === "export-failed") captureError(error, { where: "export:create" });
    return NextResponse.json({ error: code }, { status: code === "export-limit" ? 429 : code === "export-not-allowed" ? 403 : 500, headers: NO_STORE });
  }
  const created = data as { id: string; created: boolean; running?: boolean };
  // The first step: the requester's file list and the first records, with their own session.
  try {
    await runExportStep(svc, access.session, created.id, 20_000);
  } catch {
    // Recorded on the job (last_error); the page shows it and the next step tries again.
  }
  const { data: job } = await access.session.from("farm_export_jobs").select(PUBLIC_JOB_COLUMNS).eq("id", created.id).maybeSingle();
  return NextResponse.json({ job, running: created.running === true }, { headers: NO_STORE });
}
