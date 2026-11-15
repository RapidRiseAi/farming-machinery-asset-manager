/**
 * The browser side of a recorded spoken command (docs/LIMITS.md, "Command audio"): the
 * recording goes straight to Storage as temporary command audio, its job is started, and
 * the job is run and polled until it has a transcript, failed, or was cancelled. The
 * transcript is then handed back to the assistant as the person's spoken request, which
 * keeps its confirmation before any change. Every step can be repeated: the recording's
 * request id is its own capture id, so a retry is the same upload and the same job.
 */

import { mediaClassOf } from "@/lib/limits";
import { stableRequestId, uploadFile, type UploadInput, type UploadProgress } from "@/lib/upload/client";
import type { Transport } from "@/lib/upload/tus";
import type { UploadCode } from "@/lib/upload/protocol";
import type { AssistantLocale } from "@/lib/assistant/types";

export type CommandJobView = {
  id: string;
  status: "queued" | "running" | "transcribed" | "completed" | "failed" | "cancelled";
  attempts: number;
  maxAttempts: number;
  transcript: string | null;
  error: string | null;
  recoverUntil: string;
  audioKept: boolean;
};

export type CommandStage = "uploading" | "queued" | "hearing" | "heard" | "failed";

export type CommandOutcome =
  | { ok: true; job: CommandJobView }
  | { ok: false; code: UploadCode | "paused" | string; job?: CommandJobView };

type Deps = { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };

async function call(fetchImpl: typeof fetch, body: unknown, signal?: AbortSignal) {
  const response = await fetchImpl("/api/assistant/commands", {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body), signal,
  });
  const json = (await response.json().catch(() => null)) as { job?: CommandJobView; error?: string } | null;
  return { ok: response.ok, json };
}

export async function runRecordedCommand(
  input: {
    captureId: string;
    audio: Blob;
    mimeType: string;
    locale: AssistantLocale;
    farmId: string;
    onStage?: (stage: CommandStage, detail?: UploadProgress) => void;
    signal?: AbortSignal;
  },
  deps: Deps & { transport?: Transport; storage?: UploadInput["storage"] } = {},
): Promise<CommandOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const mime = input.mimeType.split(";")[0].trim().toLowerCase().replace("video/webm", "audio/webm");
  if (mediaClassOf(mime, "command_audio") !== "command_audio") return { ok: false, code: "upload-wrong-type" };

  input.onStage?.("uploading");
  const uploaded = await uploadFile({
    file: input.audio, mime, mediaClass: "command_audio", label: "command", finish: "caller",
    target: { kind: "assistant_command", id: input.captureId, farmId: input.farmId },
    requestId: await stableRequestId(`command:${input.captureId}`, input.audio),
    onProgress: (p) => input.onStage?.("uploading", p),
    signal: input.signal, fetchImpl: deps.fetchImpl, transport: deps.transport, storage: deps.storage,
  });
  if (!uploaded.ok) return { ok: false, code: uploaded.code };

  const started = await call(fetchImpl, { action: "start", intentId: uploaded.intentId, locale: input.locale }, input.signal);
  if (!started.ok || !started.json?.job) return { ok: false, code: started.json?.error ?? "command_unavailable" };
  let job = started.json.job;

  // Run it; a run that is already in hand elsewhere (another tab) answers its state, so
  // poll until it is heard or has stopped. Each run is one function call of its own.
  for (let round = 0; round < 40; round++) {
    if (job.status === "transcribed" || job.status === "completed") {
      input.onStage?.("heard");
      return { ok: true, job };
    }
    if (job.status === "failed" || job.status === "cancelled") {
      input.onStage?.("failed");
      return { ok: false, code: job.error ?? job.status, job };
    }
    input.onStage?.(job.status === "running" ? "hearing" : "queued");
    const ran = await call(fetchImpl, { action: job.status === "running" ? "status" : "run", jobId: job.id }, input.signal);
    if (!ran.ok || !ran.json?.job) return { ok: false, code: ran.json?.error ?? "command_unavailable", job };
    job = ran.json.job;
    if (job.status === "running") await sleep(Math.min(15_000, 2_000 + round * 1_000));
  }
  return { ok: false, code: "command_timeout", job };
}

/** Tell the server the transcript reached the assistant: the command is done, its audio removed. */
export async function finishRecordedCommand(jobId: string, deps: Deps = {}): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  try {
    const done = await call(fetchImpl, { action: "done", jobId });
    return done.ok;
  } catch {
    return false; // the nightly sweep removes it after the recovery window
  }
}

export async function retryRecordedCommand(jobId: string, deps: Deps = {}): Promise<CommandJobView | null> {
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  const retried = await call(fetchImpl, { action: "retry", jobId });
  return retried.ok ? retried.json?.job ?? null : null;
}

export async function cancelRecordedCommand(jobId: string, deps: Deps = {}): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  const cancelled = await call(fetchImpl, { action: "cancel", jobId });
  return cancelled.ok;
}
