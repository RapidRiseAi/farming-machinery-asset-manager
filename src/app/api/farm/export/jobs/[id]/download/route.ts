import { NextResponse } from "next/server";

import { exportAccess, NO_STORE } from "@/lib/farm-export/access";
import { EXPORT_BUCKET, LINK_SECONDS, exportObjectPath, partName, type PartMeta } from "@/lib/farm-export/archive";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * A private link to one part of a finished export (`?part=N`, answered as JSON with a link
 * signed for ten minutes), or the manifest itself (`?manifest=1`, as a file). Only the person
 * who asked for the export, only while it is kept, and only while the lifecycle still lets them
 * export: after the owner's 90 days no link is made, whatever is still stored.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ready = { farm_id: string; status: string; parts: PartMeta[]; expires_at: string | null; removed_at: string | null; created_at: string };

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "missing-id" }, { status: 400, headers: NO_STORE });
  const session = await createClient();
  const { data } = await session
    .from("farm_export_jobs")
    .select("farm_id, status, parts, expires_at, removed_at, created_at")
    .eq("id", id)
    .maybeSingle();
  const job = data as Ready | null;
  if (!job) return NextResponse.json({ error: "not-found" }, { status: 404, headers: NO_STORE });
  const access = await exportAccess(job.farm_id);
  if (!access.ok) return access.response;
  if (job.status !== "ready" || job.removed_at || !job.expires_at || new Date(job.expires_at) <= new Date()) {
    return NextResponse.json({ error: "export-gone" }, { status: 410, headers: NO_STORE });
  }
  const url = new URL(request.url);
  const stamp = job.created_at.slice(0, 10);
  const svc = createServiceClient();

  if (url.searchParams.get("manifest") === "1") {
    const { data: blob, error } = await svc.storage.from(EXPORT_BUCKET).download(exportObjectPath(job.farm_id, id, "manifest.json"));
    if (error || !blob) return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
    return new NextResponse(blob, {
      status: 200,
      headers: {
        ...NO_STORE,
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="fleetwise-export-${stamp}-manifest.json"`,
      },
    });
  }

  const n = Number(url.searchParams.get("part"));
  const part = (job.parts ?? []).find((p) => p.n === n);
  if (!part) return NextResponse.json({ error: "not-found" }, { status: 404, headers: NO_STORE });
  const { data: signed, error } = await svc.storage
    .from(EXPORT_BUCKET)
    .createSignedUrl(exportObjectPath(job.farm_id, id, partName(n)), LINK_SECONDS, { download: `fleetwise-export-${stamp}-${partName(n)}` });
  if (error || !signed?.signedUrl) return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  return NextResponse.json({ url: signed.signedUrl, expires_in: LINK_SECONDS }, { headers: NO_STORE });
}
