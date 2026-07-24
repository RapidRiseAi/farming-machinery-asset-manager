// Server-only helper: imported solely from the "use server" machines/actions module,
// which keeps it off the client bundle (mirrors src/lib/fault-media.ts).
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_PHOTO_BYTES = 6 * 1024 * 1024; // decoded size cap (client already compresses)

/**
 * Upload a machine photo supplied as a base64 `data:` URL (from the add-vehicle form,
 * where the machine — and its storage path — only exists after insert) into the
 * private `machine-photos` bucket and record it in `attachments`.
 *
 * Runs on the RLS-bound server client (the owner/manager creating the machine already
 * has farm access), writing under `{farm_id}/{machine_id}/…` so farm-scoped storage
 * RLS (0201) governs reads. Returns the new attachment id, or null on any problem
 * (a missing photo must never block machine creation).
 */
export async function uploadMachinePhotoDataUrl(
  supabase: SupabaseClient,
  farmId: string,
  machineId: string,
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
  const path = `${farmId}/${machineId}/photo-${crypto.randomUUID()}.${ext}`;
  const up = await supabase.storage.from("machine-photos").upload(path, bytes, { contentType });
  if (up.error) return null;

  const ins = await supabase
    .from("attachments")
    .insert({
      farm_id: farmId,
      parent_type: "machine",
      parent_id: machineId,
      kind: "photo",
      storage_path: path,
      created_by: createdBy,
    })
    .select("id")
    .single();
  if (ins.error || !ins.data) return null;
  return (ins.data as { id: string }).id;
}
