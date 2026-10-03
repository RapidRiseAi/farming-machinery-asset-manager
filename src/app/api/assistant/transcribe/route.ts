import { NextResponse } from "next/server";
import { transcribe } from "ai";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { loadAssistantMachines } from "@/lib/assistant/data";
import {
  allowsAudioTranscription,
  configuredTranscribeModels,
  transcribeOptionsFor,
  transcriptionVocabulary,
} from "@/lib/assistant/transcription";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The AI hearing of one spoken request: the browser posts the clip it recorded while
 * Azure was transcribing live, and gets back what the AI speech models heard, told the
 * farm's machine names. Only for someone whose active consent covers audio
 * (`voice-ai-v2`); the database profile is checked here, on every request. Nothing is
 * stored: the clip and its transcripts exist only for this request.
 */

const HEADERS = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" } as const;
// 60 s of 16 kHz mono 16-bit WAV is 1.92 MB; a little headroom for the header.
const MAX_AUDIO_BYTES = 2_000_000;
const MODEL_TIMEOUT_MS = 8_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 12;

type Bucket = { count: number; resetAt: number };
const store = globalThis as typeof globalThis & { __fleetwiseTranscribeRate?: Map<string, Bucket> };
const buckets = store.__fleetwiseTranscribeRate ?? new Map<string, Bucket>();
store.__fleetwiseTranscribeRate = buckets;

/** Per instance only, like the speech-token limit: it stops a runaway loop, not an attacker. */
function allowed(userId: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(userId);
  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size > 2_000) for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key);
    buckets.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_MAX;
}

const fail = (code: string, status: number) => NextResponse.json({ error: code }, { status, headers: HEADERS });

/** A RIFF/WAVE header: the only container the recorder produces and every model accepts. */
function isWav(bytes: Uint8Array): boolean {
  const tag = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
  return bytes.length > 44 && tag(0) === "RIFF" && tag(8) === "WAVE";
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail("forbidden", 403);
  const context = await getAssistantContext();
  if (!context) return fail("forbidden", 403);
  if (!allowsAudioTranscription(context.profile)) return fail("consent_required", 403);
  if (!allowed(context.profile.id)) return fail("rate_limited", 429);

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_AUDIO_BYTES) return fail("too_large", 413);
  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.byteLength > MAX_AUDIO_BYTES) return fail("too_large", 413);
  if (!isWav(audio)) return fail("bad_audio", 400);

  let terms: string[];
  try {
    const machines = await loadAssistantMachines(context.supabase, context.farmId, {
      role: context.role,
      userId: context.profile.id,
    });
    terms = transcriptionVocabulary(machines);
  } catch {
    return fail("fleet_unavailable", 503);
  }

  const zeroDataRetention = process.env.ASSISTANT_TRANSCRIBE_ZDR === "1";
  const started = Date.now();
  const results = await Promise.all(
    configuredTranscribeModels().map(async (model) => {
      try {
        const result = await transcribe({
          model,
          audio,
          providerOptions: transcribeOptionsFor(model, terms, zeroDataRetention),
          maxRetries: 0,
          abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]),
        });
        const text = result.text.trim();
        return text ? { model, text } : null;
      } catch {
        return null;
      }
    }),
  );
  const hearings = results.filter((result): result is { model: string; text: string } => Boolean(result));
  // Operational trace only: which models answered and how fast, never what was said.
  console.info(JSON.stringify({
    event: "assistant_transcribe",
    models: hearings.map((hearing) => hearing.model),
    failed: results.length - hearings.length,
    ms: Date.now() - started,
  }));
  if (!hearings.length) return fail("transcription_unavailable", 503);
  return NextResponse.json({ hearings }, { headers: HEADERS });
}
