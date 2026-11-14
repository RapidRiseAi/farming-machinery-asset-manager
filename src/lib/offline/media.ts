// A captured fault's photo and voice note, sent after the fault itself through the direct
// upload pipeline (src/lib/upload/client.ts) rather than inside the sync request, which a
// Vercel function cuts off at 4.5 MB.
//
// The request id of each file comes from the capture's own client id and the file's facts,
// so the online attempt and its offline replay (and every retry of either) are one upload:
// begin answers the same intent, a finished one answers its attachment, nothing is stored
// twice. A transient failure leaves the capture queued; a refusal is reported once.

import { stableRequestId, uploadFile, type UploadInput } from "@/lib/upload/client";
import type { UploadCode } from "@/lib/upload/protocol";
import type { QueuedMutation } from "./types";

const TRANSIENT = new Set<string>(["upload-interrupted", "upload-unavailable", "paused", "upload-not-received", "upload-too-many"]);

export type MediaResult = { state: "done" } | { state: "transient" } | { state: "refused"; code: UploadCode };

export async function sendCaptureMedia(
  m: Pick<QueuedMutation, "client_id" | "photo" | "voice">,
  fault: { id: string; farmId: string },
  deps: Partial<Pick<UploadInput, "fetchImpl" | "transport" | "storage" | "onProgress">> = {},
): Promise<MediaResult> {
  const files: Array<{ field: "photo" | "voice"; blob: Blob }> = [];
  if (m.photo && m.photo.size > 0) files.push({ field: "photo", blob: m.photo });
  if (m.voice && m.voice.size > 0) files.push({ field: "voice", blob: m.voice });
  for (const { field, blob } of files) {
    const mime = (blob.type || (field === "photo" ? "image/jpeg" : "audio/webm")).split(";")[0].toLowerCase();
    const outcome = await uploadFile({
      file: blob,
      mime: mime === "video/webm" ? "audio/webm" : mime,
      mediaClass: field === "photo" ? "photo" : "voice",
      target: { kind: "fault", id: fault.id, farmId: fault.farmId },
      label: field,
      requestId: await stableRequestId(`${m.client_id}|${field}`, blob),
      finish: "generic",
      attachmentKind: field,
      ...deps,
    });
    if (outcome.ok) continue;
    if (TRANSIENT.has(outcome.code)) return { state: "transient" };
    return { state: "refused", code: outcome.code as UploadCode };
  }
  return { state: "done" };
}
