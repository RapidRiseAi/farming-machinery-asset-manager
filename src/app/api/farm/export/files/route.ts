import { NextResponse } from "next/server";

import { accessibleFarms, currentFarmId, effectiveFarmRole, getProfile } from "@/lib/auth";
import { isUuid } from "@/lib/ids";
import { createServiceClient } from "@/lib/supabase/service";
import { zipStream } from "@/lib/zip";

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

  const svc = createServiceClient();
  // The list decides what is served, so a bucket or path typed into the address reaches nothing
  // that is not already this business's own.
  const { data, error } = await svc.rpc("farm_file_objects", { p_farm: farmId });
  if (error) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const files = ((data as StoredFile[] | null) ?? []).filter((f) => f.bucket_id === bucket);
  if (files.length === 0) return NextResponse.json({ error: "empty" }, { status: 404 });

  async function* read() {
    for (const file of files) {
      const { data: blob, error: readError } = await svc.storage.from(file.bucket_id).download(file.name);
      if (readError || !blob) throw new Error(`could not read a file from ${file.bucket_id}`);
      yield {
        name: file.name.split("/").slice(1).join("/"),
        bytes: new Uint8Array(await blob.arrayBuffer()),
      };
    }
  }

  return new NextResponse(zipStream(read()), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="fleetwise-files-${bucket}.zip"`,
      "cache-control": "no-store, private",
    },
  });
}
