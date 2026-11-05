import { createHash } from "node:crypto";
import type { createServiceClient } from "@/lib/supabase/service";

const MAX_FILE = 8 * 1024 * 1024;

// UI upload kinds → attachment_kind enum (photo | invoice | doc).
const KIND_MAP: Record<string, "photo" | "invoice" | "doc"> = {
  photo: "photo",
  invoice: "invoice",
  quote: "doc",
};

/**
 * Upload a work-request quote / invoice / proof photo to the private `jobcard-photos`
 * bucket and record it in `attachments` (parent_type='work_request'). Mirrors the F1
 * `uploadJobCardMedia` service-role pattern: runs as the service role from a trusted
 * server route, writing under `{farm_id}/{work_request_id}/…` so the farm-scoped
 * storage RLS (0201) applies to reads. Returns true only after the attachment is saved.
 */
export async function uploadWorkRequestMedia(
  svc: ReturnType<typeof createServiceClient>,
  file: File | null,
  uiKind: string,
  farmId: string,
  workRequestId: string,
  createdBy: string | null,
): Promise<boolean> {
  const kind = KIND_MAP[uiKind] ?? "photo";
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_FILE) return false;

  const ext = file.type.includes("pdf") ? "pdf" : file.type.startsWith("image/") ? "jpg" : "bin";
  const buf = new Uint8Array(await file.arrayBuffer());
  // Content-addressed (repeat-tap follow-up): the same file for the same request and kind
  // is one attachment, so a double tap, a retried upload or a lost response stores it once.
  // The id and the object path both come from the hash, as fault media do.
  const hash = createHash("sha256").update(`${farmId}|${workRequestId}|${kind}|`).update(buf).digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const path = `${farmId}/${workRequestId}/${kind}-${id}.${ext}`;
  const existing = await svc.from("attachments").select("id").eq("id", id).is("deleted_at", null).maybeSingle();
  if (existing.error) return false;
  if (existing.data) return true;
  const up = await svc.storage.from("jobcard-photos").upload(path, buf, {
    contentType: file.type || "application/octet-stream",
  });
  // A previous attempt may have stored the same object and lost its response.
  const alreadyStored = Boolean(up.error) && String((up.error as { statusCode?: unknown }).statusCode) === "409";
  if (up.error && !alreadyStored) return false;

  try {
    const { error } = await svc.from("attachments").upsert({
      id,
      farm_id: farmId,
      parent_type: "work_request",
      parent_id: workRequestId,
      kind,
      storage_path: path,
      created_by: createdBy,
    }, { onConflict: "id", ignoreDuplicates: true });
    if (!error) return true;
  } catch {
    // A failed attachment write must never be reported as a completed upload.
  }
  // An object another attempt stored is that attempt's to keep: only remove our own.
  if (alreadyStored) return false;

  // This path was generated and uploaded by this request. Never remove caller paths.
  try {
    const { error } = await svc.storage.from("jobcard-photos").remove([path]);
    if (error) console.error("workrequest-media: orphan upload cleanup failed");
  } catch {
    console.error("workrequest-media: orphan upload cleanup failed");
  }
  return false;
}
