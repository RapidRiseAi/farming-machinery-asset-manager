import "server-only";

import { transcribe } from "ai";
import {
  configuredTranscribeModels, openAiTranscribePrompt, transcribeOptionsFor,
} from "@/lib/assistant/transcription";
import type { AssistantLocale } from "@/lib/assistant/types";
import { loadFarmOpenAiKey, markFarmKeyFailed } from "@/lib/ai-usage/farm-key";
import { gatewayCallCost } from "@/lib/ai-usage/gateway-cost";
import { gatewayOptions } from "@/lib/ai-usage/gateway-options";
import { hearingHoldUnits } from "@/lib/ai-usage/hold-units";
import { holdBudget, settleHold, type Attempt, type HoldRefusal } from "@/lib/ai-usage/ledger";
import { farmOpenAi, openAiModelId, transcriptionResponseBody, transcriptionTokenUnits } from "@/lib/ai-usage/openai-direct";
import { classifyAiFailure } from "@/lib/ai-usage/outcome";
import type { Units } from "@/lib/ai-usage/ledger";
import { COMMAND_AUDIO_MAX_MS } from "@/lib/limits";

/**
 * The AI hearing of one recorded spoken command, up to ten minutes (decision 11), run
 * inside the command job's request (src/app/api/assistant/commands/route.ts) on the
 * server's own deadline, well inside a Vercel function's 300 s.
 *
 * One file, one call: OpenAI's transcription takes files up to 25 MB in flac, mp3, mp4,
 * m4a, ogg, wav and webm (https://developers.openai.com/api/docs/guides/speech-to-text,
 * read 2026-11-14), and a ten-minute recording at the recorder's bitrate is about 3.6 MB
 * (20 MB at most), so nothing is cut into pieces mid-sentence. The provider documents no
 * duration limit; ten minutes through a real key is still to be heard (PROGRESS).
 *
 * Paid work goes through the AI usage ledger exactly as the instant hearing does
 * (docs/AI_USAGE.md): a hold sized for the recording's whole length (the length its
 * container states, or the ten-minute ceiling when it states none) before each call, on
 * the credential really used, then a settlement. The fallback model is tried only when the
 * first fails, never when it was refused for budget, and never after a farm's own key
 * failed when its owner chose to pause.
 */

export type HearInput = {
  farmId: string;
  userId: string;
  audio: Uint8Array;
  durationMs: number | null;
  terms: string[];
  locale: AssistantLocale;
};

export type HearResult =
  | { state: "heard"; text: string; model: string }
  | { state: "refused"; reason: HoldRefusal | "own_key_broken" | "transcription_unavailable" }
  | { state: "failed"; code: string };

type CallResult = { text: string; costUsd: number | null; generationId: string | null; tokens: Units | null };

export type HearDeps = {
  models: () => string[];
  farmKey: typeof loadFarmOpenAiKey;
  hold: typeof holdBudget;
  settle: typeof settleHold;
  call: (args: { model: string; audio: Uint8Array; terms: string[]; locale: AssistantLocale; farmId: string; ownKey: string | null; signal: AbortSignal }) => Promise<CallResult>;
  markKeyFailed: typeof markFarmKeyFailed;
  deadlineMs: number;
};

const defaultCall: HearDeps["call"] = async ({ model, audio, terms, locale, farmId, ownKey, signal }) => {
  const directId = ownKey ? openAiModelId(model) : null;
  const answer = ownKey && directId
    ? await transcribe({
        model: farmOpenAi(ownKey).transcription(directId),
        audio,
        providerOptions: transcribeOptionsFor(model, terms, {}, locale) as Parameters<typeof transcribe>[0]["providerOptions"],
        maxRetries: 0,
        abortSignal: signal,
      })
    : await transcribe({
        model,
        audio,
        providerOptions: transcribeOptionsFor(model, terms, gatewayOptions({
          farmId, userId: null, feature: "ai_hearing", zeroDataRetention: process.env.ASSISTANT_TRANSCRIBE_ZDR === "1",
        }), locale) as Parameters<typeof transcribe>[0]["providerOptions"],
        maxRetries: 0,
        abortSignal: signal,
      });
  const { costUsd, generationId } = gatewayCallCost(answer.providerMetadata);
  const tokens = ownKey && directId ? transcriptionTokenUnits(transcriptionResponseBody(answer)) : null;
  return { text: answer.text.trim(), costUsd, generationId, tokens };
};

const DEFAULT_DEPS: HearDeps = {
  models: () => configuredTranscribeModels(),
  farmKey: loadFarmOpenAiKey,
  hold: holdBudget,
  settle: settleHold,
  call: defaultCall,
  markKeyFailed: markFarmKeyFailed,
  // Well inside the function's 300 s, leaving room to fetch the file and record the answer.
  deadlineMs: 240_000,
};

export async function hearCommand(input: HearInput, deps: Partial<HearDeps> = {}): Promise<HearResult> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const farmKey = await d.farmKey(input.farmId);
  if (farmKey.state === "unavailable") return { state: "refused", reason: "transcription_unavailable" };
  if (farmKey.state === "broken" && farmKey.fallback === "pause") return { state: "refused", reason: "own_key_broken" };
  const ownKey = farmKey.state === "active" ? farmKey.key : null;
  const pauseIfKeyFails = farmKey.state === "active" && farmKey.fallback === "pause";
  // The hold covers the whole recording: its stated length, or the ten-minute ceiling.
  const durationMs = input.durationMs && input.durationMs > 0 ? Math.min(input.durationMs, COMMAND_AUDIO_MAX_MS) : COMMAND_AUDIO_MAX_MS;
  const promptChars = openAiTranscribePrompt(input.terms, input.locale).length;
  const started = Date.now();
  let lastCode = "transcription_failed";

  for (const model of d.models().slice(0, 2)) {
    const useOwnKey = Boolean(ownKey && openAiModelId(model));
    const held = hearingHoldUnits(model, durationMs, promptChars);
    const hold = await d.hold({
      farmId: input.farmId, userId: input.userId, feature: "ai_hearing", model, units: held,
      credential: useOwnKey ? "farm_openai" : "platform",
    });
    if (!hold.ok) return { state: "refused", reason: hold.reason };
    const remaining = d.deadlineMs - (Date.now() - started);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, remaining));
    const t0 = Date.now();
    let settlement: Attempt;
    try {
      const result = await d.call({
        model, audio: input.audio, terms: input.terms, locale: input.locale, farmId: input.farmId,
        ownKey: useOwnKey ? ownKey : null, signal: controller.signal,
      });
      settlement = {
        model,
        outcome: result.text ? "ok" : "failed",
        errorCode: result.text ? undefined : "empty_transcript",
        ...(result.costUsd !== null
          ? { costUsd: result.costUsd, units: { audio_ms: durationMs }, measured: "gateway" as const }
          : result.tokens ? { units: result.tokens, measured: "server" as const } : { units: held, measured: "estimated" as const }),
        generationId: result.generationId,
        latencyMs: Date.now() - t0,
      };
      await d.settle(hold.id, [settlement]);
      clearTimeout(timer);
      if (result.text) return { state: "heard", text: result.text, model };
      lastCode = "empty_transcript";
    } catch (error) {
      clearTimeout(timer);
      const failure = classifyAiFailure(error, useOwnKey);
      const timedOut = controller.signal.aborted || failure.outcome === "timeout";
      await d.settle(hold.id, [{
        model, outcome: timedOut ? "timeout" : failure.outcome, errorCode: timedOut ? "timeout" : failure.code,
        // Sent and cut off: the provider probably charged; recorded as an estimate, billed nothing extra.
        ...(timedOut ? { units: held, measured: "estimated" as const } : {}),
        latencyMs: Date.now() - t0,
      }]);
      lastCode = timedOut ? "timeout" : failure.code;
      if (useOwnKey && failure.outcome === "key_invalid") {
        await d.markKeyFailed(input.farmId, failure.code === "farm_key_quota" ? "farm_key_quota" : "farm_key_refused");
        if (pauseIfKeyFails) return { state: "refused", reason: "own_key_broken" };
      }
    }
    if (Date.now() - started > d.deadlineMs - 5_000) break;
  }
  return { state: "failed", code: lastCode.replace(/[^a-z_]/g, "_").slice(0, 40) || "transcription_failed" };
}
