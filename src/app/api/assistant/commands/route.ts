import { NextResponse } from "next/server";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { loadAssistantMachines } from "@/lib/assistant/data";
import { aiHelpOn, transcriptionVocabulary } from "@/lib/assistant/transcription";
import { hearCommand } from "@/lib/assistant/command-transcribe";
import { captureError } from "@/lib/observability";
import { createServiceClient } from "@/lib/supabase/service";
import { commitUpload, storageReader, verifyUpload } from "@/lib/upload/server";
import { COMMAND_JOB_LEASE_MS } from "@/lib/limits";
import { isUuid } from "@/lib/upload/protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// One run hears one recording (at most 240 s of provider time) inside a single function call.
export const maxDuration = 300;

const HEADERS = { "Cache-Control": "private, no-store, max-age=0" } as const;
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: HEADERS });

type Job = {
  id: string; status: string; attempts: number; max_attempts: number; transcript: string | null;
  error_code: string | null; recover_until: string; audio_removed_at: string | null; intent_id: string;
  duration_ms: number | null; locale: "en-ZA" | "af-ZA";
};

/** What the browser is told about a job: never another person's, never the audio. */
const view = (job: Job | null) => job && {
  id: job.id, status: job.status, attempts: job.attempts, maxAttempts: job.max_attempts,
  transcript: job.status === "transcribed" || job.status === "completed" ? job.transcript : null,
  error: job.error_code, recoverUntil: job.recover_until, audioKept: job.audio_removed_at === null,
};

/**
 * A spoken command longer than the instant hearing (docs/LIMITS.md, "Command audio"):
 *
 *   start   the recording was uploaded (purpose command_audio): judge it, finish the
 *           upload, open its job (one per recording, however often this is called).
 *   run     claim the job (a lease, an attempt counted) and hear it now, in this request.
 *           Called by the browser and called again while it is queued; a run whose
 *           function vanished is taken over when its lease lapses.
 *   status  where it is.
 *   done    the transcript was handed to the assistant: completed, and its audio removed.
 *   cancel, retry   the person's own choice; retry only within the recovery window.
 *
 * The transcript is only ever the person's request: the assistant's confirmation before
 * any change applies to it exactly as to typed or live-dictated words.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return answer({ error: "forbidden" }, 403);
  const body = (await request.json().catch(() => null)) as { action?: string; intentId?: string; jobId?: string; locale?: string } | null;
  const action = body?.action ?? "";
  // Cancelling one's own command stays possible on a stopped account; everything else
  // needs the assistant to be available to this person on this farm.
  const context = await getAssistantContext({ allowStoppedFarm: action === "cancel" });
  if (!context) return answer({ error: "forbidden" }, 403);
  const db = context.supabase;
  const svc = createServiceClient();

  if (action === "start") {
    if (!isUuid(body?.intentId) || (body?.locale !== "en-ZA" && body?.locale !== "af-ZA")) return answer({ error: "bad_request" }, 400);
    const verified = await verifyUpload(svc, storageReader(), body.intentId, context.profile.id);
    if (verified.state === "refused") return answer({ error: verified.code }, verified.status);
    if (verified.intent.target_kind !== "assistant_command") return answer({ error: "upload-target" }, 400);
    const committed = await commitUpload(db, svc, verified.intent, { recordId: verified.intent.id });
    if (committed.state === "refused") return answer({ error: committed.code }, committed.status);
    const { data, error } = await db.rpc("assistant_command_start", { p_intent: verified.intent.id, p_locale: body.locale });
    if (error) return answer({ error: error.code === "42501" ? "forbidden" : "command_unavailable" }, error.code === "42501" ? 403 : 503);
    return answer({ job: view(data as Job) });
  }

  if (!isUuid(body?.jobId)) return answer({ error: "bad_request" }, 400);
  const jobId = body.jobId;

  if (action === "status") {
    const { data, error } = await db.from("assistant_command_jobs").select("*").eq("id", jobId).maybeSingle();
    if (error) return answer({ error: "command_unavailable" }, 503);
    if (!data) return answer({ error: "not_found" }, 404);
    return answer({ job: view(data as Job) });
  }

  if (action === "cancel" || action === "retry") {
    const { data, error } = await db.rpc(action === "cancel" ? "assistant_command_cancel" : "assistant_command_retry", { p_job: jobId });
    if (error) {
      const expired = error.message === "command:expired";
      return answer({ error: expired ? "command_expired" : error.code === "42501" ? "forbidden" : "command_unavailable" }, expired ? 410 : error.code === "42501" ? 403 : 503);
    }
    const job = data as Job;
    if (action === "cancel") await removeAudio(svc, job);
    return answer({ job: view(job) });
  }

  if (action === "done") {
    const { data: own, error: ownError } = await db.from("assistant_command_jobs").select("*").eq("id", jobId).maybeSingle();
    if (ownError) return answer({ error: "command_unavailable" }, 503);
    if (!own) return answer({ error: "not_found" }, 404);
    const { data, error } = await svc.rpc("assistant_command_record", { p_job: jobId, p_outcome: "completed" });
    if (error) return answer({ error: "command_unavailable" }, 503);
    const job = data as Job;
    // Done: the transcript and the assistant's record of what was confirmed stay; the
    // temporary audio goes now (the nightly sweep retries a removal that fails).
    if (job.status === "completed") await removeAudio(svc, job);
    return answer({ job: view(job) });
  }

  if (action !== "run") return answer({ error: "bad_request" }, 400);
  if (!aiHelpOn(context.profile)) return answer({ error: "notice_required" }, 403);
  const { data: claimed, error: claimError } = await db.rpc("assistant_command_claim", {
    p_job: jobId, p_lease_seconds: Math.round(COMMAND_JOB_LEASE_MS / 1000),
  });
  if (claimError) {
    const stopped = claimError.message === "farm-not-active";
    return answer({ error: stopped ? "farm-not-active" : claimError.code === "42501" ? "forbidden" : "command_unavailable" },
      stopped ? 402 : claimError.code === "42501" ? 403 : 503);
  }
  const claim = claimed as { claimed: boolean; job: Job };
  if (!claim.claimed) return answer({ job: view(claim.job) });
  const job = claim.job;

  const record = async (outcome: "transcribed" | "retry" | "failed", transcript: string | null, code: string | null) => {
    const { data, error } = await svc.rpc("assistant_command_record", { p_job: job.id, p_outcome: outcome, p_transcript: transcript, p_error: code });
    if (error) captureError(error, { where: "assistant:command-record" });
    return (data as Job | null) ?? job;
  };

  try {
    const { data: intent, error: intentError } = await svc.from("upload_intents")
      .select("bucket, object_path, duration_ms, user_id").eq("id", job.intent_id).maybeSingle();
    if (intentError || !intent || intent.user_id !== context.profile.id) {
      return answer({ job: view(await record("retry", null, "audio_unavailable")) });
    }
    const download = await svc.storage.from(intent.bucket as string).download(intent.object_path as string);
    if (download.error || !download.data) return answer({ job: view(await record("retry", null, "audio_unavailable")) });
    const audio = new Uint8Array(await download.data.arrayBuffer());

    const machines = await loadAssistantMachines(db, context.farmId, { role: context.role, userId: context.profile.id });
    const heard = await hearCommand({
      farmId: context.farmId, userId: context.profile.id, audio,
      durationMs: (intent.duration_ms as number | null) ?? job.duration_ms, terms: transcriptionVocabulary(machines), locale: job.locale,
    });
    if (heard.state === "heard") return answer({ job: view(await record("transcribed", heard.text, null)) });
    // A spending limit or a switched-off AI is not something retrying fixes: the audio is
    // kept for the recovery window and the person told; anything else is tried again.
    if (heard.state === "refused") return answer({ job: view(await record("failed", null, heard.reason)) });
    return answer({ job: view(await record("retry", null, heard.code)) });
  } catch (failure) {
    captureError(failure, { where: "assistant:command-run" });
    return answer({ job: view(await record("retry", null, "run_failed")) });
  }
}

async function removeAudio(svc: ReturnType<typeof createServiceClient>, job: Job): Promise<void> {
  const { data: intent } = await svc.from("upload_intents").select("bucket, object_path").eq("id", job.intent_id).maybeSingle();
  if (!intent) return;
  const { error } = await svc.storage.from(intent.bucket as string).remove([intent.object_path as string]);
  if (error) {
    captureError(error, { where: "assistant:command-audio-remove" });
    return;
  }
  const { error: markError } = await svc.rpc("cron_command_audio_removed", { p_intents: [job.intent_id] });
  if (markError) captureError(markError, { where: "assistant:command-audio-mark" });
}
