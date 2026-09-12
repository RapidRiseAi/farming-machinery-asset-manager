import { createHash } from "node:crypto";
import type { createServiceClient } from "@/lib/supabase/service";

const MEDIA = [
  { field: "photo", bucket: "fault-photos", limit: 6 * 1024 * 1024 },
  { field: "voice", bucket: "fault-voice", limit: 8 * 1024 * 1024 },
] as const;

/** Stable attachment identity makes a lost response safe to replay without duplicates. */
export async function uploadFaultMedia(
  svc: ReturnType<typeof createServiceClient>, form: FormData, farmId: string,
  faultId: string, createdBy: string | null, retryId = crypto.randomUUID(),
): Promise<{ ok: boolean; failed: string[] }> {
  const failed: string[] = [];
  for (const spec of MEDIA) {
    const file = form.get(spec.field);
    if (!(file instanceof File) || file.size === 0) continue;
    const mime = file.type.split(";")[0].toLowerCase();
    const allowed = spec.field === "photo"
      ? ["image/jpeg", "image/png", "image/webp"]
      : ["audio/webm", "video/webm", "audio/ogg", "audio/mp4"];
    if (file.size > spec.limit || !allowed.includes(mime)) { failed.push(spec.field); continue; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = createHash("sha256").update(farmId + faultId + retryId + spec.field).update(bytes).digest("hex");
      const id = hash.slice(0,8) + "-" + hash.slice(8,12) + "-4" + hash.slice(13,16) + "-a" + hash.slice(17,20) + "-" + hash.slice(20,32);
      const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp"
        : mime === "image/jpeg" ? "jpg" : mime === "audio/ogg" ? "ogg" : mime === "audio/mp4" ? "m4a" : "webm";
      const path = farmId + "/" + faultId + "/" + spec.field + "-" + id + "." + ext;
      const existing = await svc.from("attachments").select("id").eq("id", id).is("deleted_at", null).maybeSingle();
      if (existing.error) { failed.push(spec.field); continue; }
      if (existing.data) continue;
      const uploaded = await svc.storage.from(spec.bucket).upload(path, bytes, { contentType: mime });
      // A previous attempt may have stored the same content but lost its response.
      if (uploaded.error && String(uploaded.error.statusCode) !== "409") { failed.push(spec.field); continue; }
      const saved = await svc.from("attachments").upsert({
        id, farm_id: farmId, parent_type: "fault", parent_id: faultId,
        kind: spec.field, storage_path: path, created_by: createdBy,
      }, { onConflict: "id", ignoreDuplicates: true });
      if (saved.error) failed.push(spec.field);
      // Keep this content-addressed object for retry if the database write failed.
      // Deleting it could race another successful replay of the same attachment.
    } catch { failed.push(spec.field); }
  }
  return { ok: failed.length === 0, failed };
}
