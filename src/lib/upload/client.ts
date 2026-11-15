/**
 * The browser half of the direct upload pipeline (docs/LIMITS.md, "How a file travels").
 *
 *   1. POST /api/uploads/begin: the server reserves the space and signs one exact path.
 *   2. The file goes straight to Supabase Storage: one signed PUT up to 6 MB, TUS above it
 *      (resumable after a dropped connection, a pause, or a page reload of the same file).
 *   3. POST /api/uploads/finalise (ordinary attachments), or the caller's own route with the
 *      intent id (job cards, documents, receipts): the server judges the real bytes.
 *
 * Every step can be repeated: the request id makes begin answer the same intent, the
 * upload URL is remembered per intent, and finalise answers its first result again. A
 * refusal returns a code with a translated sentence (errors.ts), never throws, so the
 * form around it keeps the person's text and chosen file.
 */

import type { MediaClass } from "@/lib/limits";
import { getSupabaseEnv } from "@/lib/env";
import type { BeginAnswer, TargetKind, UploadCode } from "./protocol";
import { signedPut, tusUpload, UploadHttpError, xhrTransport, type Transport } from "./tus";

export type UploadTarget = { kind: TargetKind; id: string; farmId?: string | null; workshopId?: string | null };

export type UploadPhase = "starting" | "sending" | "checking" | "done" | "paused" | "failed";
export type UploadProgress = { phase: UploadPhase; sent: number; total: number };

export type UploadOutcome =
  | { ok: true; intentId: string; recordId: string | null }
  | { ok: false; code: UploadCode | "paused"; intentId?: string };

export type UploadInput = {
  file: Blob;
  mime: string;
  mediaClass: MediaClass;
  target: UploadTarget;
  /** The word in the stored name: photo, voice, quote, invoice, document, receipt, proof, ... */
  label: string;
  requestId: string;
  /** "generic" finishes an ordinary attachment here; "caller" leaves it to the caller's route. */
  finish: "generic" | "caller";
  attachmentKind?: "photo" | "voice" | "doc" | "invoice";
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /** For tests. */
  transport?: Transport;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
};

const RESUME_KEY = (intentId: string) => `fleetwise:upload:${intentId}`;

function safeStorage(input: UploadInput): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  if (input.storage !== undefined) return input.storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** What a failed storage request means for the person. */
function codeForHttp(error: unknown): UploadCode | "paused" {
  if (error instanceof DOMException && error.name === "AbortError") return "paused";
  if (error instanceof UploadHttpError) {
    if (error.status === 413) return "upload-too-large-for-storage";
    if (error.status === 415) return "upload-wrong-type";
    if (error.status === 401 || error.status === 403) return "upload-expired";
  }
  return "upload-interrupted";
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown, signal?: AbortSignal) {
  const response = await fetchImpl(url, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, json };
}

export async function uploadFile(input: UploadInput): Promise<UploadOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch.bind(globalThis);
  const transport = input.transport ?? xhrTransport;
  const store = safeStorage(input);
  const total = input.file.size;
  const tell = (phase: UploadPhase, sent = 0) => input.onProgress?.({ phase, sent, total });

  tell("starting");
  let begun: { ok: boolean; status: number; json: Record<string, unknown> | null };
  try {
    begun = await postJson(fetchImpl, "/api/uploads/begin", {
      target: { kind: input.target.kind, id: input.target.id, farmId: input.target.farmId ?? null, workshopId: input.target.workshopId ?? null },
      label: input.label, mediaClass: input.mediaClass, mime: input.mime, bytes: total, requestId: input.requestId,
    }, input.signal);
  } catch (error) {
    tell("failed");
    return { ok: false, code: error instanceof DOMException && error.name === "AbortError" ? "paused" : "upload-interrupted" };
  }
  if (!begun.ok || !begun.json) {
    tell("failed");
    return { ok: false, code: (begun.json?.error as UploadCode | undefined) ?? "upload-unavailable" };
  }
  const answer = begun.json as unknown as BeginAnswer;

  if (answer.state === "upload") {
    const { anonKey } = getSupabaseEnv();
    try {
      tell("sending", 0);
      const onProgress = (sent: number) => tell("sending", sent);
      if (answer.resumable) {
        await tusUpload(input.file, transport, {
          endpoint: answer.tusEndpoint, token: answer.token, apiKey: anonKey, bucket: answer.bucket,
          path: answer.path, contentType: input.mime, chunkBytes: answer.chunkBytes, signal: input.signal,
          resumeUrl: store?.getItem(RESUME_KEY(answer.intentId)) ?? null,
          onUploadUrl: (url) => { try { store?.setItem(RESUME_KEY(answer.intentId), url); } catch { /* optional */ } },
          onProgress,
        });
      } else {
        await signedPut(input.file, transport, {
          signedUrl: answer.signedUrl, apiKey: anonKey, contentType: input.mime, signal: input.signal, onProgress,
        });
      }
    } catch (error) {
      const code = codeForHttp(error);
      tell(code === "paused" ? "paused" : "failed");
      return { ok: false, code, intentId: answer.intentId };
    }
  }

  // The caller's own route judges the bytes and saves its record with the intent id.
  if (input.finish === "caller") {
    tell("done", total);
    return { ok: true, intentId: answer.intentId, recordId: null };
  }

  tell("checking", total);
  let finished: { ok: boolean; status: number; json: Record<string, unknown> | null };
  try {
    finished = await postJson(fetchImpl, "/api/uploads/finalise", { intentId: answer.intentId, attachmentKind: input.attachmentKind }, input.signal);
  } catch (error) {
    tell("failed");
    return { ok: false, code: error instanceof DOMException && error.name === "AbortError" ? "paused" : "upload-interrupted", intentId: answer.intentId };
  }
  if (!finished.ok) {
    tell("failed");
    return { ok: false, code: (finished.json?.error as UploadCode | undefined) ?? "upload-unavailable", intentId: answer.intentId };
  }
  try { store?.removeItem(RESUME_KEY(answer.intentId)); } catch { /* optional */ }
  tell("done", total);
  return { ok: true, intentId: answer.intentId, recordId: (finished.json?.recordId as string | null | undefined) ?? null };
}

/**
 * A request id that stays the same for the same file in the same place, across a dropped
 * response, a reload, and an offline capture replayed later: a UUID shaped from a hash of
 * `scope` (for example the offline capture's client id and the field) and the file's facts.
 */
export async function stableRequestId(scope: string, file?: Blob & { name?: string; lastModified?: number }): Promise<string> {
  const facts = file ? `|${file.size}|${file.type}|${file.name ?? ""}|${file.lastModified ?? ""}` : "";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope + facts)));
  const hex = Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
