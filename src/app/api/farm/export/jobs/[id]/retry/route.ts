import { NextResponse } from "next/server";

import { exportAccess, NO_STORE } from "@/lib/farm-export/access";
import { PUBLIC_JOB_COLUMNS } from "@/lib/farm-export/job";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/** The files a finished export reported missing, tried again (and a new manifest after them). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "missing-id" }, { status: 400, headers: NO_STORE });
  const session = await createClient();
  const { data: own } = await session.from("farm_export_jobs").select("farm_id").eq("id", id).maybeSingle();
  if (!own) return NextResponse.json({ error: "not-found" }, { status: 404, headers: NO_STORE });
  const access = await exportAccess((own as { farm_id: string }).farm_id);
  if (!access.ok) return access.response;
  const { error } = await createServiceClient().rpc("export_job_retry_missing", { p_by: access.userId, p_job: id });
  if (error) return NextResponse.json({ error: error.message?.startsWith("export-") ? error.message : "export-failed" }, { status: 409, headers: NO_STORE });
  const { data: job } = await access.session.from("farm_export_jobs").select(PUBLIC_JOB_COLUMNS).eq("id", id).maybeSingle();
  return NextResponse.json({ job }, { headers: NO_STORE });
}
