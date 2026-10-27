// Server-only helper: imported solely from the "use server" checklists actions module,
// which keeps it off the client bundle (mirrors src/lib/machine-photo.ts).
import type { SupabaseClient } from "@supabase/supabase-js";
import { soft } from "@/lib/supabase/must";
import { captureError } from "@/lib/observability";

const MAX_PHOTO_BYTES = 6 * 1024 * 1024; // decoded cap (the client already compresses)

/**
 * Upload a checklist photo-field image supplied as a base64 `data:` URL (ferried
 * through the fill server action, since the instance, and its storage path, only
 * exists after insert) into the private `checklist-photos` bucket and record it in
 * `attachments` (parent_type=checklist_instance).
 *
 * Runs on the RLS-bound server client, writing under `{farm_id}/{instance_id}/…` so the
 * farm-scoped storage RLS (0291) governs reads. Returns the new attachment id, or null
 * on any problem (a bad photo must never block saving the checklist).
 */
export async function uploadChecklistPhotoDataUrl(
  supabase: SupabaseClient,
  farmId: string,
  instanceId: string,
  dataUrl: string | null,
  createdBy: string | null,
): Promise<string | null> {
  if (!dataUrl) return null;
  const m = /^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  const contentType = m[1].toLowerCase() === "image/jpg" ? "image/jpeg" : m[1].toLowerCase();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(m[2], "base64"));
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) return null;

  const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const path = `${farmId}/${instanceId}/photo-${crypto.randomUUID()}.${ext}`;
  const up = await supabase.storage.from("checklist-photos").upload(path, bytes, { contentType });
  // Best effort, as documented above, but heard of: a lost photo is otherwise invisible.
  if (up.error) {
    captureError(up.error, { where: "checklist-media:upload", farmId });
    return null;
  }

  const ins = await supabase
    .from("attachments")
    .insert({
      farm_id: farmId,
      parent_type: "checklist_instance",
      parent_id: instanceId,
      kind: "photo",
      storage_path: path,
      created_by: createdBy,
    })
    .select("id")
    .single();
  if (ins.error || !ins.data) {
    captureError(ins.error ?? new Error("checklist-media: attachment insert returned no row"), {
      where: "checklist-media:attachment",
      farmId,
      extra: { code: ins.error?.code ?? null },
    });
    return null;
  }
  return (ins.data as { id: string }).id;
}

/** Batch-sign checklist photo storage paths → short-lived signed URLs. */
export async function signChecklistPhotos(
  supabase: SupabaseClient,
  paths: (string | null)[],
): Promise<(string | null)[]> {
  return Promise.all(
    paths.map(async (p) => {
      if (!p) return null;
      // soft: a photo that will not sign shows as missing; the answers beside it still stand.
      const data = soft(await supabase.storage.from("checklist-photos").createSignedUrl(p, 3600), "checklist-media:sign");
      return data?.signedUrl ?? null;
    }),
  );
}
