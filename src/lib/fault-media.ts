import { createServiceClient } from "@/lib/supabase/service";

const MAX_PHOTO = 6 * 1024 * 1024;
const MAX_VOICE = 8 * 1024 * 1024;

/**
 * Upload an optional fault photo + voice note to private Storage and record them
 * in `attachments`. Runs as the service role (called from trusted server routes),
 * writing under `{farm_id}/{fault_id}/…` so farm-scoped storage RLS applies to reads.
 */
export async function uploadFaultMedia(
  svc: ReturnType<typeof createServiceClient>,
  form: FormData,
  farmId: string,
  faultId: string,
  createdBy: string | null,
) {
  const photo = form.get("photo");
  const voice = form.get("voice");

  if (photo instanceof File && photo.size > 0 && photo.size <= MAX_PHOTO) {
    const path = `${farmId}/${faultId}/photo-${crypto.randomUUID()}.jpg`;
    const buf = new Uint8Array(await photo.arrayBuffer());
    const up = await svc.storage.from("fault-photos").upload(path, buf, { contentType: photo.type || "image/jpeg" });
    if (!up.error) {
      await svc.from("attachments").insert({ farm_id: farmId, parent_type: "fault", parent_id: faultId, kind: "photo", storage_path: path, created_by: createdBy });
    }
  }
  if (voice instanceof File && voice.size > 0 && voice.size <= MAX_VOICE) {
    const path = `${farmId}/${faultId}/voice-${crypto.randomUUID()}.webm`;
    const buf = new Uint8Array(await voice.arrayBuffer());
    const up = await svc.storage.from("fault-voice").upload(path, buf, { contentType: voice.type || "audio/webm" });
    if (!up.error) {
      await svc.from("attachments").insert({ farm_id: farmId, parent_type: "fault", parent_id: faultId, kind: "voice", storage_path: path, created_by: createdBy });
    }
  }
}
