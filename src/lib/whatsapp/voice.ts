import "server-only";
import { transcribe as aiTranscribe } from "ai";
import { configuredTranscribeModels, openAiTranscribePrompt, transcribeOptionsFor } from "@/lib/assistant/transcription";
import { loadFarmOpenAiKey, markFarmKeyFailed } from "@/lib/ai-usage/farm-key";
import { gatewayCallCost } from "@/lib/ai-usage/gateway-cost";
import { gatewayOptions } from "@/lib/ai-usage/gateway-options";
import { hearingHoldUnits } from "@/lib/ai-usage/hold-units";
import { holdBudget, settleHold, type Attempt } from "@/lib/ai-usage/ledger";
import { farmOpenAi, openAiModelId, transcriptionResponseBody, transcriptionTokenUnits } from "@/lib/ai-usage/openai-direct";
import { classifyAiFailure } from "@/lib/ai-usage/outcome";

/**
 * A WhatsApp voice note, heard by the same speech models as the in-app assistant
 * (src/app/api/assistant/transcribe/route.ts) and paid for the same way: every attempt
 * takes its budget hold first, on the credential it will really use, and settles in the
 * AI ledger whatever happens (docs/AI_USAGE.md). A farm's own OpenAI key covers gpt-4o
 * and never MAI; a broken own key with "pause" chosen pauses this too.
 *
 * Unlike the in-app hearing nobody is waiting on a 6.5-second deadline, so there is no
 * hedge: the fallback runs only when the first model fails (never when it was refused,
 * because MAI is always on the platform's account and would be refused the same).
 *
 * Nothing is kept. The audio and the transcript live for this call; the caller decides
 * what to say, and the inbox's own retention covers the reply. No transcript is logged.
 */

type VoiceRefusal = "farm_limit" | "member_limit" | "ai_off" | "own_key_broken" | "unavailable";
export type VoiceResult = { ok: true; text: string } | { ok: false; reason: VoiceRefusal | "not_heard" };

type Transcribe = typeof aiTranscribe;

export async function transcribeVoiceNote(
  input: { farmId: string; userId: string; audio: Uint8Array; durationMs: number; terms: string[] },
  deps: { transcribe?: Transcribe } = {},
): Promise<VoiceResult> {
  const transcribe = deps.transcribe ?? aiTranscribe;
  const farmKey = await loadFarmOpenAiKey(input.farmId);
  // Fails closed, as the in-app hearing does: never quietly on our account.
  if (farmKey.state === "unavailable") return { ok: false, reason: "unavailable" };
  if (farmKey.state === "broken" && farmKey.fallback === "pause") return { ok: false, reason: "own_key_broken" };
  const ownKey = farmKey.state === "active" ? farmKey.key : null;
  const pauseIfKeyFails = farmKey.state === "active" && farmKey.fallback === "pause";
  // No language forced: a farmer may speak Afrikaans whatever the app is set to, and the
  // bilingual prompt is what the in-app hearing uses when no language was chosen.
  const promptChars = openAiTranscribePrompt(input.terms, undefined).length;

  let lastRefusal: VoiceRefusal | null = null;
  let keyFailed = false;
  for (const model of configuredTranscribeModels()) {
    if (keyFailed && pauseIfKeyFails) break;
    const directId = openAiModelId(model);
    const direct = ownKey && directId && !keyFailed ? { key: ownKey, id: directId } : null;
    const held = hearingHoldUnits(model, input.durationMs, promptChars);
    const hold = await holdBudget({
      farmId: input.farmId, userId: input.userId, feature: "ai_hearing", model, units: held,
      credential: direct ? "farm_openai" : "platform",
    });
    if (!hold.ok) {
      // A limit or a switch: the next model is refused the same, so stop here.
      return {
        ok: false,
        reason: hold.reason === "farm_limit" || hold.reason === "member_limit" ? hold.reason
          : hold.reason === "unavailable" ? "unavailable" : "ai_off",
      };
    }
    const t0 = Date.now();
    let settlement: Attempt;
    let text = "";
    try {
      const answer = direct
        ? await transcribe({
            model: farmOpenAi(direct.key).transcription(direct.id),
            audio: input.audio,
            providerOptions: transcribeOptionsFor(model, input.terms, {}, undefined) as Parameters<Transcribe>[0]["providerOptions"],
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(45_000),
          })
        : await transcribe({
            model,
            audio: input.audio,
            providerOptions: transcribeOptionsFor(model, input.terms, gatewayOptions({
              farmId: input.farmId, userId: null, feature: "ai_hearing",
              zeroDataRetention: process.env.ASSISTANT_TRANSCRIBE_ZDR === "1",
            }), undefined) as Parameters<Transcribe>[0]["providerOptions"],
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(45_000),
          });
      text = answer.text.trim();
      const { costUsd, generationId } = gatewayCallCost(answer.providerMetadata);
      const tokens = direct ? transcriptionTokenUnits(transcriptionResponseBody(answer)) : null;
      settlement = {
        model,
        outcome: text ? "ok" : "failed",
        errorCode: text ? undefined : "empty_transcript",
        ...(costUsd !== null
          ? { costUsd, units: { audio_ms: input.durationMs }, measured: "gateway" as const }
          : tokens
            ? { units: tokens, measured: "server" as const }
            : { units: held, measured: "estimated" as const }),
        generationId,
        latencyMs: Date.now() - t0,
      };
    } catch (error) {
      const failure = classifyAiFailure(error, Boolean(direct));
      // Timed out after it was sent, or heard and empty: the provider probably charged,
      // so the held units are its estimated cost. The farm is billed nothing for it.
      const empty = Boolean(error && typeof error === "object" && "name" in error
        && String((error as { name: unknown }).name).includes("NoTranscriptGenerated"));
      settlement = {
        model,
        outcome: failure.outcome,
        errorCode: empty ? "empty_transcript" : failure.code,
        ...(failure.outcome === "timeout" || empty ? { units: held, measured: "estimated" as const } : {}),
        latencyMs: Date.now() - t0,
      };
      if (direct && failure.outcome === "key_invalid") {
        keyFailed = true;
        await markFarmKeyFailed(input.farmId, failure.code === "farm_key_quota" ? "farm_key_quota" : "farm_key_refused");
      }
      lastRefusal = keyFailed && pauseIfKeyFails ? "own_key_broken" : "unavailable";
    }
    await settleHold(hold.id, [settlement]);
    if (text) return { ok: true, text };
    if (!lastRefusal) return { ok: false, reason: "not_heard" };
  }
  return { ok: false, reason: lastRefusal ?? "not_heard" };
}
