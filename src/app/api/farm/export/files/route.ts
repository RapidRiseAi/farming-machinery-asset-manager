import { NextResponse } from "next/server";

import { accessibleFarms, currentFarmId, effectiveFarmRole, getProfile } from "@/lib/auth";
import { isUuid } from "@/lib/ids";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { farmLifecycle } from "@/lib/billing/service";
import { exportRefusal } from "@/lib/farm-export-policy";
import { readExportFiles } from "@/lib/farm-export-files";
import { zipStream } from "@/lib/zip";
import { businessExportFiles } from "@/lib/chat/privacy";

/**
 * A business's own files, one kind at a time. The JSON export holds the records and only the
 * names of files, and an owner closing their account is about to lose the files themselves.
 *
 * One bucket per download keeps each one inside what a single request can carry. Like the
 * export, this works while an account is closed: API routes sit outside the billing gate.
 */
export const maxDuration = 300;

type StoredFile = { bucket_id: string; name: string; size: number };

export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return NextResponse.json({ error: "auth" }, { status: 401 });

  const url = new URL(request.url);
  const asked = url.searchParams.get("farm");
  const bucket = url.searchParams.get("bucket") ?? "";
  const farmId = isUuid(asked) && (await accessibleFarms(profile)).some((f) => f.id === asked)
    ? asked
    : await currentFarmId(profile);
  if (!farmId) return NextResponse.json({ error: "no-farm" }, { status: 403 });

  const role = await effectiveFarmRole(farmId, profile);
  if (role !== "owner" && role !== "manager" && role !== "rr_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const session = await createClient();
  const lifecycle = role === "rr_admin" ? null : await farmLifecycle(session, farmId);
  const refusal = exportRefusal(role, lifecycle?.gate ?? null, lifecycle);
  if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });

  const svc = createServiceClient();
  // The list decides what is served, so a bucket or path typed into the address reaches nothing
  // that is not already this business's own.
  const { data, error } = await svc.rpc("farm_file_objects", { p_farm: farmId });
  if (error) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  // Owning the business does not grant access to its staff's private conversations.
  const files = businessExportFiles((data as StoredFile[] | null) ?? [], bucket);
  if (files.length === 0) return NextResponse.json({ error: "empty" }, { status: 404 });

  // The service inventory is not permission to read its files. Storage must check the
  // requester's own session for every object, including restricted finance documents.
  return new NextResponse(zipStream(readExportFiles(session, files, farmId)), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="fleetwise-files-${bucket}.zip"`,
      "cache-control": "no-store, private",
    },
  });
}
