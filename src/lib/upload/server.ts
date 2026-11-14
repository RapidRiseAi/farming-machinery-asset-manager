import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleKey, getSupabaseEnv } from "@/lib/env";
import {
  MEDIA_CLASSES, RESUMABLE_CHUNK_BYTES, RESUMABLE_THRESHOLD_BYTES, SNIFF_HEAD_BYTES, SNIFF_TAIL_BYTES,
  STORAGE_GLOBAL_LIMIT_NEEDED_BYTES, type MediaClass,
} from "@/lib/limits";
import { captureError } from "@/lib/observability";
import { inspect } from "./sniff";
import {
  extensionFor, isTargetKind, isUuid, LABEL_PATTERN, type BeginAnswer, type TargetKind, type UploadCode,
} from "./protocol";

/**
 * The server half of the direct upload pipeline (docs/LIMITS.md, "How a file travels").
 *
 *   beginUpload    the person's session reserves (database: upload_begin); the service key
 *                  signs an upload for exactly the reserved path (2 hours, no overwrite).
 *   verifyUpload   the service key reads the stored object's real size, head and tail, and
 *                  judges them (sniff.ts); the database records the facts or the refusal.
 *   commitUpload   the person's session again (database: upload_commit), so membership,
 *                  the pay gate and the record are checked at the moment it is saved.
 *
 * Nothing here trusts the browser's file name, declared type or size: those only choose
 * what to reserve. A refused or abandoned file is removed and its reservation released.
 */

export type Refusal = { state: "refused"; code: UploadCode; status: number };
const refuse = (code: UploadCode, status: number): Refusal => ({ state: "refused", code, status });

/** Reads a stored object's bytes, by range. Null when there is no such object. */
export type ObjectReader = {
  read(bucket: string, path: string, start: number, end: number): Promise<{ bytes: Uint8Array; total: number } | null>;
};

type DbError = { code?: string; message?: string } | null;

/** A database refusal as the code the browser shows a sentence for. */
export function refusalFromDb(error: DbError): Refusal {
  const message = error?.message ?? "";
  if (error?.code === "42501") return message === "farm-not-active" ? refuse("farm-not-active", 402) : refuse("forbidden", 403);
  const reason = /^upload:([a-z_]+)$/.exec(message)?.[1];
  switch (reason) {
    case "too_large": return refuse("upload-too-large", 413);
    case "wrong_type": return refuse("upload-wrong-type", 415);
    case "storage_full": return refuse("upload-storage-full", 507);
    case "target": return refuse("upload-target", 404);
    case "too_many": return refuse("upload-too-many", 429);
    case "request_reused": return refuse("upload-request-reused", 409);
    case "expired": return refuse("upload-expired", 410);
    case "too_long": return refuse("upload-too-long", 413);
    case "not_uploaded": return refuse("upload-not-received", 409);
    case undefined: return refuse("upload-unavailable", 503);
    default: return refusalFromFailure(reason);
  }
}

/** A failure recorded on an intent (or found by sniffing) as the code the browser shows. */
export function refusalFromFailure(reason: string | null | undefined): Refusal {
  switch (reason) {
    case "too_large": return refuse("upload-too-large", 413);
    case "wrong_type": return refuse("upload-wrong-type", 415);
    case "storage_full": return refuse("upload-storage-full", 507);
    case "too_long": return refuse("upload-too-long", 413);
    case "malformed": return refuse("upload-malformed", 422);
    case "too_many_pixels": return refuse("upload-too-many-pixels", 422);
    case "unsupported_codec": return refuse("upload-unsupported-codec", 415);
    case "video_not_supported": return refuse("upload-video-not-supported", 415);
    case "empty": return refuse("upload-empty", 422);
    case "forbidden": return refuse("forbidden", 403);
    case "expired": return refuse("upload-expired", 410);
    default: return refuse("upload-failed", 422);
  }
}

/**
 * The largest file the project's Storage takes (its global limit, a dashboard setting no
 * API we hold can read). `UPLOAD_GLOBAL_LIMIT_BYTES` states it when it is below what the app
 * accepts, so a file above it is refused up front rather than after it was sent.
 */
export function storageGlobalLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.UPLOAD_GLOBAL_LIMIT_BYTES);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : STORAGE_GLOBAL_LIMIT_NEEDED_BYTES;
}

export type BeginInput = {
  target: { kind: TargetKind; id: string; farmId: string | null; workshopId: string | null };
  label: string;
  mediaClass: MediaClass;
  mime: string;
  bytes: number;
  requestId: string;
};

/** Checks the shape of a begin request before anything is asked of the database. */
export function parseBeginInput(body: unknown): BeginInput | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const target = (b.target ?? {}) as Record<string, unknown>;
  const kind = target.kind;
  const farmId = target.farmId == null ? null : String(target.farmId);
  const workshopId = target.workshopId == null ? null : String(target.workshopId);
  const mediaClass = b.mediaClass;
  const mime = typeof b.mime === "string" ? b.mime.split(";")[0].trim().toLowerCase() : "";
  const bytes = Number(b.bytes);
  if (!isTargetKind(kind) || !isUuid(target.id) || (farmId !== null && !isUuid(farmId))
      || (workshopId !== null && !isUuid(workshopId)) || (farmId === null) === (workshopId === null)) return null;
  if (typeof mediaClass !== "string" || !(mediaClass in MEDIA_CLASSES)) return null;
  if (typeof b.label !== "string" || !LABEL_PATTERN.test(b.label) || !isUuid(b.requestId)) return null;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return null;
  return {
    target: { kind, id: String(target.id), farmId, workshopId },
    label: b.label, mediaClass: mediaClass as MediaClass, mime, bytes, requestId: String(b.requestId),
  };
}

type BeginRow = { id: string; bucket: string; object_path: string; expires_at: string; status: string; failure: string | null };

export async function beginUpload(
  db: SupabaseClient, svc: SupabaseClient, input: BeginInput, supabaseUrl: string, globalLimit = storageGlobalLimit(),
): Promise<BeginAnswer | Refusal> {
  const ext = extensionFor(input.mime);
  const cls = MEDIA_CLASSES[input.mediaClass];
  if (!ext || !(cls.mimes as readonly string[]).includes(input.mime)) return refuse("upload-wrong-type", 415);
  if (input.bytes > cls.maxBytes) return refuse("upload-too-large", 413);
  if (input.bytes > globalLimit) return refuse("upload-too-large-for-storage", 413);

  const { data, error } = await db.rpc("upload_begin", {
    p_farm: input.target.farmId, p_workshop: input.target.workshopId, p_target_kind: input.target.kind,
    p_target_id: input.target.id, p_label: input.label, p_media_class: input.mediaClass, p_mime: input.mime,
    p_bytes: input.bytes, p_request: input.requestId, p_ext: ext,
  });
  if (error) {
    const refusal = refusalFromDb(error);
    if (refusal.code === "upload-unavailable") captureError(error, { where: "upload:begin", extra: { code: error.code ?? null } });
    return refusal;
  }
  const row = data as BeginRow;
  if (row.status === "finalised") return { state: "finalised", intentId: row.id };
  if (row.status === "uploaded") return { state: "uploaded", intentId: row.id };
  if (row.status === "failed") return refusalFromFailure(row.failure);

  const signed = await svc.storage.from(row.bucket).createSignedUploadUrl(row.object_path);
  if (signed.error || !signed.data) {
    captureError(signed.error ?? new Error("upload: no signed url"), { where: "upload:sign" });
    return refuse("upload-unavailable", 503);
  }
  return {
    state: "upload",
    intentId: row.id,
    bucket: row.bucket,
    path: row.object_path,
    token: signed.data.token,
    signedUrl: signed.data.signedUrl,
    resumable: input.bytes > RESUMABLE_THRESHOLD_BYTES,
    tusEndpoint: `${supabaseUrl.replace(/\/$/, "")}/storage/v1/upload/resumable/sign`,
    chunkBytes: RESUMABLE_CHUNK_BYTES,
    expiresAt: row.expires_at,
  };
}

export type IntentRow = {
  id: string; user_id: string; farm_id: string | null; workshop_id: string | null; target_kind: TargetKind; target_id: string;
  bucket: string; object_path: string; media_class: MediaClass; declared_mime: string; status: string;
  failure: string | null; actual_bytes: number | null; actual_mime: string | null; duration_ms: number | null;
  record_id: string | null;
};
const INTENT_COLUMNS =
  "id,user_id,farm_id,workshop_id,target_kind,target_id,bucket,object_path,media_class,declared_mime,status,failure,actual_bytes,actual_mime,duration_ms,record_id";

/** Removes a refused object; a failure to remove is left to the nightly sweep and reported. */
async function removeObject(svc: SupabaseClient, intent: Pick<IntentRow, "bucket" | "object_path">): Promise<void> {
  const { error } = await svc.storage.from(intent.bucket).remove([intent.object_path]);
  if (error) captureError(error, { where: "upload:remove" });
}

/** Records a refusal on the intent (its reservation stops counting) and removes the object. */
export async function failUpload(svc: SupabaseClient, intent: IntentRow, reason: string): Promise<void> {
  const { error } = await svc.rpc("upload_fail", { p_intent: intent.id, p_reason: reason });
  if (error) captureError(error, { where: "upload:fail" });
  await removeObject(svc, intent);
}

/**
 * Reads the stored object back and judges it. Idempotent: an intent already verified or
 * finalised answers as it is, so a retry after a lost response does no second work.
 */
export async function verifyUpload(
  svc: SupabaseClient, reader: ObjectReader, intentId: string, userId: string,
): Promise<{ state: "verified"; intent: IntentRow } | Refusal> {
  if (!isUuid(intentId)) return refuse("upload-target", 404);
  const { data, error } = await svc.from("upload_intents").select(INTENT_COLUMNS).eq("id", intentId).maybeSingle();
  if (error) {
    captureError(error, { where: "upload:verify-read" });
    return refuse("upload-unavailable", 503);
  }
  const intent = data as IntentRow | null;
  if (!intent || intent.user_id !== userId) return refuse("forbidden", 403);
  if (intent.status === "uploaded" || intent.status === "finalised") return { state: "verified", intent };
  if (intent.status !== "reserved") return refusalFromFailure(intent.status === "expired" ? "expired" : intent.failure);

  let head: { bytes: Uint8Array; total: number } | null;
  try {
    head = await reader.read(intent.bucket, intent.object_path, 0, SNIFF_HEAD_BYTES - 1);
  } catch (failure) {
    captureError(failure, { where: "upload:verify-head" });
    return refuse("upload-unavailable", 503);
  }
  // Not there (yet): the upload did not finish. The reservation stands until it expires,
  // so the browser can resume or send it again.
  if (!head) return refuse("upload-not-received", 409);
  let tail = head.bytes;
  if (head.total > head.bytes.length) {
    try {
      const read = await reader.read(intent.bucket, intent.object_path, Math.max(0, head.total - SNIFF_TAIL_BYTES), head.total - 1);
      if (!read) return refuse("upload-not-received", 409);
      tail = read.bytes;
    } catch (failure) {
      captureError(failure, { where: "upload:verify-tail" });
      return refuse("upload-unavailable", 503);
    }
  }

  const judged = inspect(head.bytes, tail, head.total, intent.media_class);
  if (!judged.ok) {
    await failUpload(svc, intent, judged.reason);
    return refusalFromFailure(judged.reason);
  }
  const marked = await svc.rpc("upload_mark_verified", {
    p_intent: intent.id, p_actual_bytes: judged.bytes, p_actual_mime: judged.mime,
    p_duration_ms: judged.durationMs, p_width: judged.width, p_height: judged.height,
  });
  if (marked.error) {
    captureError(marked.error, { where: "upload:mark-verified" });
    return refuse("upload-unavailable", 503);
  }
  const answer = String(marked.data ?? "");
  if (answer.startsWith("failed:")) {
    await removeObject(svc, intent);
    return refusalFromFailure(answer.slice("failed:".length));
  }
  if (answer !== "uploaded" && answer !== "finalised") return refusalFromFailure(answer);
  return {
    state: "verified",
    intent: { ...intent, status: answer, actual_bytes: judged.bytes, actual_mime: judged.mime, duration_ms: judged.durationMs },
  };
}

/**
 * Saves a verified upload through the person's own session. Membership revoked or the
 * record gone since begin: the file is removed and its reservation released.
 */
export async function commitUpload(
  db: SupabaseClient, svc: SupabaseClient, intent: IntentRow,
  options: { attachmentKind?: "photo" | "voice" | "doc" | "invoice"; recordId?: string } = {},
): Promise<{ state: "finalised"; recordId: string | null } | Refusal> {
  const { data, error } = await db.rpc("upload_commit", {
    p_intent: intent.id, p_attachment_kind: options.attachmentKind ?? null, p_record: options.recordId ?? null,
  });
  if (error) {
    const refusal = refusalFromDb(error);
    if (refusal.code === "forbidden" || refusal.code === "upload-target") await failUpload(svc, intent, refusal.code);
    if (refusal.code === "upload-unavailable") captureError(error, { where: "upload:commit", extra: { code: error.code ?? null } });
    return refusal;
  }
  const answer = (data ?? {}) as { record_id?: string | null };
  return { state: "finalised", recordId: answer.record_id ?? null };
}

/** Reads Storage with the service key, by HTTP range, so a 50 MB file is never held whole. */
export function storageReader(): ObjectReader {
  const { url } = getSupabaseEnv();
  const key = getServiceRoleKey();
  return {
    async read(bucket, path, start, end) {
      const objectUrl = `${url.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`;
      const response = await fetch(objectUrl, {
        headers: { Authorization: `Bearer ${key}`, apikey: key, Range: `bytes=${start}-${end}` },
        cache: "no-store",
      });
      if (response.status === 404 || response.status === 400) return null;
      if (response.status === 416) return { bytes: new Uint8Array(0), total: 0 };
      if (!response.ok) throw new Error(`storage read ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const range = /\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "");
      const total = range ? Number(range[1]) : bytes.length;
      return { bytes: response.status === 200 ? bytes.subarray(start, end + 1) : bytes, total };
    },
  };
}
