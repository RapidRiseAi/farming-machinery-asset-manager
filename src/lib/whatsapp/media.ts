import "server-only";
import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { whatsappConfig } from "./config";

/**
 * WhatsApp voice notes and photos (20261104210000). The webhook stores only Meta's media
 * id; the worker fetches the file here once the sender is a live, authorised link.
 *
 * What is trusted about a file is what its own bytes say: the declared MIME type picks
 * nothing, the image signature and the Ogg/Opus header do. Meta's access token is sent
 * only to Meta's own hosts, never to whatever URL a response names.
 */

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];
/** The fault-photo limit (src/lib/fault-media.ts), so a WhatsApp photo fits where it goes. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/** A three-minute voice note is well under this at WhatsApp's Opus bitrate. */
export const MAX_VOICE_BYTES = 4 * 1024 * 1024;
export const MAX_VOICE_MS = 180_000;
export const MIN_VOICE_MS = 300;

/** Fixed codes only, so a failure can be logged without the file or the sender. */
export class MediaError extends Error {
  constructor(readonly code: "media_lookup_failed" | "media_untrusted_host" | "media_too_large" | "media_download_failed") {
    super(code);
    this.name = "MediaError";
  }
}

/** The image type its first bytes declare, or null for anything that is not one of ours. */
export function imageMimeFromBytes(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  return null;
}

/**
 * How long an Ogg/Opus voice note lasts, from its own headers: the last page's granule
 * position less the pre-skip, at Opus's fixed 48 kHz. Null when the bytes are not an
 * Ogg/Opus stream (a forwarded MP3 or M4A, a corrupt file), which the caller refuses
 * rather than guessing a length to hold the AI budget against.
 */
export function oggOpusDurationMs(bytes: Uint8Array): number | null {
  if (bytes.length < 47 || ascii(bytes, 0, 4) !== "OggS") return null;
  // The first page carries the OpusHead packet: "OpusHead", version, channels, pre-skip.
  const segments = bytes[26];
  const head = 27 + segments;
  if (head + 19 > bytes.length || ascii(bytes, head, 8) !== "OpusHead") return null;
  const preSkip = bytes[head + 10] | (bytes[head + 11] << 8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The last page whose granule position is set (-1 means no packet ends on that page).
  for (let i = bytes.length - 27; i >= 0; i--) {
    if (bytes[i] !== 0x4f || ascii(bytes, i, 4) !== "OggS" || bytes[i + 4] !== 0) continue;
    const granule = view.getBigInt64(i + 6, true);
    if (granule < BigInt(0)) continue;
    const samples = Number(granule) - preSkip;
    return samples > 0 ? Math.round(samples / 48) : 0;
  }
  return null;
}

/** Meta serves media from its own CDN hosts; the bearer token goes nowhere else. */
export function trustedMediaHost(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    return [".fbsbx.com", ".facebook.com", ".fbcdn.net", ".whatsapp.net"].some(
      (suffix) => url.hostname.endsWith(suffix) && url.hostname.length > suffix.length,
    );
  } catch {
    return false;
  }
}

/**
 * Fetch one media file Meta announced in a verified webhook. Two calls, both with the
 * business token: the media id resolves to a short-lived URL, and that URL serves the
 * bytes. The size is checked against Meta's own figure before downloading and again,
 * on the stream itself, while it arrives.
 */
export async function downloadWhatsAppMedia(mediaId: string, maxBytes: number): Promise<Uint8Array> {
  const config = whatsappConfig();
  if (!/^[A-Za-z0-9_.-]{1,300}$/.test(mediaId)) throw new MediaError("media_lookup_failed");
  const auth = { Authorization: `Bearer ${config.accessToken}` };
  const lookup = await fetch(`https://graph.facebook.com/${config.version}/${encodeURIComponent(mediaId)}`, {
    cache: "no-store", headers: auth, signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!lookup?.ok) throw new MediaError("media_lookup_failed");
  const meta = await lookup.json().catch(() => null) as { url?: unknown; file_size?: unknown } | null;
  if (typeof meta?.url !== "string") throw new MediaError("media_lookup_failed");
  if (!trustedMediaHost(meta.url)) throw new MediaError("media_untrusted_host");
  if (typeof meta.file_size === "number" && meta.file_size > maxBytes) throw new MediaError("media_too_large");

  // A redirect is followed (fetch drops the Authorization header across origins) but must
  // still land on one of Meta's hosts.
  const file = await fetch(meta.url, {
    cache: "no-store", headers: auth, signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!file?.ok || !file.body) throw new MediaError("media_download_failed");
  if (file.url && !trustedMediaHost(file.url)) {
    await file.body.cancel().catch(() => undefined);
    throw new MediaError("media_untrusted_host");
  }
  const reader = file.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new MediaError("media_too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

export type StagedPhoto = { id: string; storage_path: string; farm_id: string; state: string };

/**
 * Put a photo where a fault photo lives (the farm's folder of `fault-photos`, which the
 * storage policies read by its first segment) and record it as staged. Keyed on the inbox
 * message, so a replay of the same message stages the same object once.
 */
export async function stagePhoto(input: {
  inboxId: string; linkId: string; farmId: string; userId: string; bytes: Uint8Array; mime: ImageMime;
}): Promise<StagedPhoto> {
  const db = createServiceClient();
  const existing = await db.from("whatsapp_media").select("id,storage_path,farm_id,state")
    .eq("inbox_id", input.inboxId).maybeSingle();
  if (existing.error) throw new Error("whatsapp_media_unavailable");
  if (existing.data) return existing.data as StagedPhoto;
  const hash = createHash("sha256").update(input.inboxId).update(input.bytes).digest("hex").slice(0, 32);
  const ext = input.mime === "image/png" ? "png" : input.mime === "image/webp" ? "webp" : "jpg";
  const path = `${input.farmId}/whatsapp/${input.linkId}/${hash}.${ext}`;
  const uploaded = await db.storage.from("fault-photos").upload(path, input.bytes, { contentType: input.mime });
  // A previous attempt may have stored the same content and lost its response.
  if (uploaded.error && String((uploaded.error as { statusCode?: unknown }).statusCode) !== "409") {
    throw new Error("whatsapp_media_upload_failed");
  }
  const saved = await db.from("whatsapp_media").insert({
    inbox_id: input.inboxId, link_id: input.linkId, farm_id: input.farmId, user_id: input.userId,
    kind: "image", bucket: "fault-photos", storage_path: path, mime: input.mime, bytes: input.bytes.byteLength,
  }).select("id,storage_path,farm_id,state").single();
  if (saved.error || !saved.data) throw new Error("whatsapp_media_not_saved");
  return saved.data as StagedPhoto;
}

/** Remove a staged photo's object and mark it settled; never touches an attached one. */
export async function releasePhoto(mediaId: string, state: "discarded" | "expired"): Promise<void> {
  const db = createServiceClient();
  const row = await db.from("whatsapp_media").select("id,storage_path,state").eq("id", mediaId).maybeSingle();
  if (row.error) throw new Error("whatsapp_media_unavailable");
  if (!row.data || row.data.state !== "staged") return;
  const removed = await db.storage.from("fault-photos").remove([row.data.storage_path]);
  if (removed.error) throw new Error("whatsapp_media_remove_failed");
  const settled = await db.from("whatsapp_media").update({ state, settled_at: new Date().toISOString() })
    .eq("id", mediaId).eq("state", "staged");
  if (settled.error) throw new Error("whatsapp_media_not_settled");
}

/** Staged photos nobody chose a use for: removed once their conversation has lapsed. */
export async function expireStagedPhotos(limit = 20): Promise<number> {
  const db = createServiceClient();
  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data, error } = await db.from("whatsapp_media").select("id").eq("state", "staged")
    .lt("created_at", cutoff).order("created_at").limit(limit);
  if (error) throw new Error("whatsapp_media_unavailable");
  let expired = 0;
  for (const row of data ?? []) {
    await releasePhoto(row.id, "expired");
    expired++;
  }
  return expired;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = "";
  for (let i = at; i < at + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}
