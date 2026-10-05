import { after, NextResponse } from "next/server";
import { transcribe } from "ai";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { loadAssistantMachines } from "@/lib/assistant/data";
import {
  aiHelpOn,
  configuredTranscribeModels,
  openAiTranscribePrompt,
  transcribeOptionsFor,
  transcriptionVocabulary,
} from "@/lib/assistant/transcription";
import { loadFarmOpenAiKey, markFarmKeyFailed } from "@/lib/ai-usage/farm-key";
import { gatewayCallCost } from "@/lib/ai-usage/gateway-cost";
import { gatewayOptions } from "@/lib/ai-usage/gateway-options";
import { hearingHoldUnits } from "@/lib/ai-usage/hold-units";
import { holdBudget, settleHold, type Attempt, type HoldRefusal } from "@/lib/ai-usage/ledger";
import { farmOpenAi, openAiModelId, transcriptionResponseBody, transcriptionTokenUnits } from "@/lib/ai-usage/openai-direct";
import { classifyAiFailure } from "@/lib/ai-usage/outcome";
import { aiErrorForLog } from "@/lib/ai-usage/safe-log";
import { strictPcmDurationMs } from "@/lib/ai-usage/wav";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The AI hearing of one hard spoken request: the browser posts the clip it recorded while
 * Azure was transcribing live, and gets back what an AI speech model heard, told the
 * farm's machine names. Nothing is stored: the clip and its transcript exist only for this
 * request. What it cost goes in the ledger (docs/AI_USAGE.md).
 *
 * One model, then its fallback only when needed: gpt-4o-transcribe first; MAI starts only
 * if gpt-4o fails or has not answered in HEDGE_AFTER_MS, and whichever loses once a
 * hearing is in is cancelled. Each attempt takes its own budget hold before it calls
 * anything, on the credential it will really use: a farm's own OpenAI key covers gpt-4o,
 * called at OpenAI directly (never through the Gateway, which would fall back to ours),
 * and never MAI, so the MAI hold is always the platform's and always counts.
 */

const HEADERS = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" } as const;
// 60 s of 16 kHz mono 16-bit WAV is 1.92 MB; a little headroom for the header.
const MAX_AUDIO_BYTES = 2_000_000;
const HEDGE_AFTER_MS = 3_000;
/** The browser stops waiting 6.5 s after it posts (AI_HEARING_DEADLINE_MS); this counts from arrival. */
const RESPOND_BY_MS = 5_800;
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

const fail = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: code, ...extra }, { status, headers: HEADERS });

type Heard = { model: string; text: string };
type AttemptResult = { heard: Heard | null; refused: HoldRefusal | null; keyFailed: boolean };

const isEmptyTranscript = (error: unknown) =>
  Boolean(error && typeof error === "object" && "name" in error && String(error.name).includes("NoTranscriptGenerated"));

export async function POST(request: Request) {
  // Every deadline counts from arrival, as the browser's does from posting: upload and
  // setup come out of the same wait, so a paid hearing is not finished after nobody waits.
  const started = Date.now();
  const respondBy = started + RESPOND_BY_MS;
  if (!sameOrigin(request)) return fail("forbidden", 403);
  const context = await getAssistantContext();
  if (!context) return fail("forbidden", 403);
  if (!aiHelpOn(context.profile)) return fail("notice_required", 403);
  if (!allowed(context.profile.id)) return fail("rate_limited", 429);

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_AUDIO_BYTES) return fail("too_large", 413);
  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.byteLength > MAX_AUDIO_BYTES) return fail("too_large", 413);
  const durationMs = strictPcmDurationMs(audio);
  if (durationMs === null || durationMs < 200) return fail("bad_audio", 400);

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

  const farmId = context.farmId;
  const userId = context.profile.id;
  const zeroDataRetention = process.env.ASSISTANT_TRANSCRIBE_ZDR === "1";
  const farmKey = await loadFarmOpenAiKey(farmId);
  // Fails closed: a farm that linked its own key is never quietly billed on ours because
  // the key could not be read.
  if (farmKey.state === "unavailable") return fail("transcription_unavailable", 503);
  // A broken own key with "pause" chosen pauses AI help for the farm, the fallback hearing
  // included. Azure's own hearing still runs in the browser.
  if (farmKey.state === "broken" && farmKey.fallback === "pause") return fail("own_key_broken", 403);
  const ownKey = farmKey.state === "active" ? farmKey.key : null;
  const pauseIfKeyFails = farmKey.state === "active" && farmKey.fallback === "pause";

  const [primary, fallback] = configuredTranscribeModels();
  const promptChars = openAiTranscribePrompt(terms).length;
  const pending: Promise<unknown>[] = [];
  const controllers: AbortController[] = [];

  // One attempt: hold, call, settle. Never throws; settlement is awaited in after() when
  // the attempt outlives the response.
  const attempt = (model: string): Promise<AttemptResult> => {
    const directId = openAiModelId(model);
    const direct = ownKey && directId ? { key: ownKey, id: directId } : null;
    const useOwnKey = direct !== null;
    const held = hearingHoldUnits(model, durationMs, promptChars);
    const controller = new AbortController();
    controllers.push(controller);
    const work = (async (): Promise<AttemptResult> => {
      const hold = await holdBudget({
        farmId,
        userId,
        feature: "ai_hearing",
        model,
        units: held,
        credential: useOwnKey ? "farm_openai" : "platform",
      });
      if (!hold.ok) return { heard: null, refused: hold.reason, keyFailed: false };
      if (controller.signal.aborted) {
        // Another hearing won while this hold was being taken: nothing was sent.
        await settleHold(hold.id, [{ model, outcome: "cancelled", errorCode: "cancelled" }]);
        return { heard: null, refused: null, keyFailed: false };
      }
      // Budget is held: the call runs on the server's deadline, not the browser's, so it
      // can finish and be settled even if nobody is waiting any more.
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1_000, respondBy - Date.now()))]);
      const t0 = Date.now();
      let settlement: Attempt;
      let result: AttemptResult;
      try {
        const answer = direct
          ? await transcribe({
              model: farmOpenAi(direct.key).transcription(direct.id),
              audio,
              providerOptions: transcribeOptionsFor(model, terms) as Parameters<typeof transcribe>[0]["providerOptions"],
              maxRetries: 0,
              abortSignal: signal,
            })
          : await transcribe({
              model,
              audio,
              providerOptions: transcribeOptionsFor(model, terms, gatewayOptions({
                farmId, userId: null, feature: "ai_hearing", zeroDataRetention,
              })) as Parameters<typeof transcribe>[0]["providerOptions"],
              maxRetries: 0,
              abortSignal: signal,
            });
        const text = answer.text.trim();
        const { costUsd, generationId } = gatewayCallCost(answer.providerMetadata);
        const tokens = useOwnKey ? transcriptionTokenUnits(transcriptionResponseBody(answer)) : null;
        settlement = {
          model,
          outcome: text ? "ok" : "failed",
          errorCode: text ? undefined : "empty_transcript",
          // The provider's own measure when there is one; otherwise the held units, which
          // are an upper bound, marked as an estimate.
          ...(costUsd !== null
            ? { costUsd, units: { audio_ms: durationMs }, measured: "gateway" as const }
            : tokens
              ? { units: tokens, measured: "server" as const }
              : { units: held, measured: "estimated" as const }),
          generationId,
          latencyMs: Date.now() - t0,
        };
        result = { heard: text ? { model, text } : null, refused: null, keyFailed: false };
      } catch (error) {
        const failure = classifyAiFailure(error, useOwnKey);
        const cancelled = controller.signal.aborted;
        // Cut off after it was sent (our deadline, or the other hearing won), or heard and
        // empty: the provider probably charged, so the held units are recorded as its
        // estimated cost. Nothing is billed to the farm for a hearing it did not get.
        const charged = cancelled || failure.outcome === "timeout" || isEmptyTranscript(error);
        if (!cancelled) {
          console.warn(JSON.stringify({ event: "assistant_transcribe_failed", model, ...aiErrorForLog(error), outcome: failure.outcome }));
        }
        settlement = {
          model,
          outcome: cancelled ? "cancelled" : failure.outcome,
          errorCode: cancelled ? "cancelled" : isEmptyTranscript(error) ? "empty_transcript" : failure.code,
          ...(charged ? { units: held, measured: "estimated" as const } : {}),
          latencyMs: Date.now() - t0,
        };
        const keyFailed = useOwnKey && failure.outcome === "key_invalid";
        if (keyFailed) await markFarmKeyFailed(farmId, failure.code === "farm_key_quota" ? "farm_key_quota" : "farm_key_refused");
        result = { heard: null, refused: null, keyFailed };
      }
      await settleHold(hold.id, [settlement]);
      return result;
    })();
    pending.push(work);
    return work;
  };

  const remaining = () => Math.max(0, respondBy - Date.now());
  const first = attempt(primary);
  let second: Promise<AttemptResult> | null = null;
  // The fallback starts when the first FAILS, or is still running after HEDGE_AFTER_MS;
  // never when it was refused (a limit, AI switched off), because MAI is always on the
  // platform's account and would be refused the same; and never after the farm's own key
  // failed when its owner chose to pause rather than be billed on ours.
  const startFallback = (afterKeyFailure: boolean) => {
    if (second || !fallback || remaining() < 1_000) return;
    if (afterKeyFailure && pauseIfKeyFails) return;
    second = attempt(fallback);
  };

  let firstResult: AttemptResult | null = null;
  void first.then((result) => {
    firstResult = result;
    if (!result.heard && !result.refused) startFallback(result.keyFailed);
  });
  await Promise.race([first, new Promise((resolve) => setTimeout(resolve, Math.min(HEDGE_AFTER_MS, remaining())))]);
  if (!firstResult) startFallback(false);

  // From here the set of attempts is final. Answer with the first hearing, or once every
  // attempt has finished, or at the deadline, whichever comes first.
  const live = [first, second].filter((p): p is Promise<AttemptResult> => p !== null);
  const results = await new Promise<AttemptResult[]>((resolve) => {
    const done: AttemptResult[] = [];
    const timer = setTimeout(() => resolve([...done]), remaining());
    for (const p of live) {
      void p.then((result) => {
        done.push(result);
        if (result.heard || done.length === live.length) {
          clearTimeout(timer);
          resolve([...done]);
        }
      });
    }
  });

  // A hearing is in, or the wait is over: whatever is still running is cancelled (and
  // settled as such), then everything settles after the response.
  for (const controller of controllers) controller.abort();
  after(async () => {
    await Promise.allSettled(pending);
  });

  const hearings = results.map((result) => result.heard).filter((heard): heard is Heard => Boolean(heard));
  console.info(JSON.stringify({ event: "assistant_transcribe", models: hearings.map((h) => h.model), ms: Date.now() - started }));
  if (hearings.length) return NextResponse.json({ hearings }, { headers: HEADERS });

  const refusal = results.find((result) => result.refused)?.refused;
  if (refusal === "farm_limit" || refusal === "member_limit") {
    return fail("ai_limit_reached", 402, { scope: refusal === "farm_limit" ? "farm" : "member" });
  }
  if (refusal && refusal !== "unavailable") return fail(refusal, 403);
  return fail("transcription_unavailable", 503);
}
