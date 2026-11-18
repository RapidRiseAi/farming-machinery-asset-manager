import { NextResponse } from "next/server";

import { exportAccess, NO_STORE } from "@/lib/farm-export/access";
import { PUBLIC_JOB_COLUMNS, runExportStep } from "@/lib/farm-export/job";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * One bounded step of the requester's own export, driven by their page: records with their
 * session, then files through their session, then the manifest. A step already running (another
 * tab, the worker) answers "busy" and the page simply asks again.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "missing-id" }, { status: 400, headers: NO_STORE });
  // Row security: the requester reads their own jobs only.
  const session = await createClient();
  const { data: own } = await session.from("farm_export_jobs").select("farm_id").eq("id", id).maybeSingle();
  if (!own) return NextResponse.json({ error: "not-found" }, { status: 404, headers: NO_STORE });
  const access = await exportAccess((own as { farm_id: string }).farm_id);
  if (!access.ok) return access.response;

  let outcome: string;
  try {
    outcome = (await runExportStep(createServiceClient(), access.session, id, 40_000)).status;
  } catch {
    outcome = "error";
  }
  const { data: job } = await access.session.from("farm_export_jobs").select(PUBLIC_JOB_COLUMNS).eq("id", id).maybeSingle();
  return NextResponse.json({ job, outcome }, { headers: NO_STORE });
}
