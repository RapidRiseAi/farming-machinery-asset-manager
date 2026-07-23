import { createServiceClient } from "@/lib/supabase/service";

const MAX_FILE = 8 * 1024 * 1024;

// UI upload kinds → attachment_kind enum (photo | invoice | doc | voice).
const KIND_MAP: Record<string, "photo" | "invoice" | "doc"> = {
  photo: "photo",
  invoice: "invoice",
  quote: "doc",
};

/**
 * Upload a job-card quote / invoice / photo to the private `jobcard-photos` bucket and
 * record it in `attachments`. Mirrors the `uploadFaultMedia` service-role pattern
 * (0207): runs as the service role from a trusted server route, writing under
 * `{farm_id}/{job_card_id}/…` so the farm-scoped storage RLS (0201) applies to reads.
 * Returns true when a file was stored.
 */
export async function uploadJobCardMedia(
  svc: ReturnType<typeof createServiceClient>,
  file: File | null,
  uiKind: string,
  farmId: string,
  jobCardId: string,
  createdBy: string | null,
): Promise<boolean> {
  const kind = KIND_MAP[uiKind] ?? "photo";
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_FILE) return false;

  const ext = file.type.includes("pdf") ? "pdf" : file.type.startsWith("image/") ? "jpg" : "bin";
  const path = `${farmId}/${jobCardId}/${kind}-${crypto.randomUUID()}.${ext}`;
  const buf = new Uint8Array(await file.arrayBuffer());
  const up = await svc.storage.from("jobcard-photos").upload(path, buf, {
    contentType: file.type || "application/octet-stream",
  });
  if (up.error) return false;

  await svc.from("attachments").insert({
    farm_id: farmId,
    parent_type: "job_card",
    parent_id: jobCardId,
    kind,
    storage_path: path,
    created_by: createdBy,
  });
  return true;
}
