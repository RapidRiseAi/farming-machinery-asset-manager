import type { Units } from "./ledger";

/**
 * What a hold is sized on: an UPPER bound of what the call can consume, because the
 * farm's bill is clamped to its hold (a hold below the real cost bills less than the
 * call cost, and the margin goes with it). The nightly job raises `holds_clamped` when a
 * model's rows are clamped more than now and then, which is how a bound that is too low
 * shows itself.
 */

/** Characters per token, rounded down on purpose: English averages about four. */
const CHARS_PER_TOKEN = 3;

/**
 * An AI hearing. gpt-4o-transcribe is billed on audio tokens, the machine-name prompt
 * (text in) and the transcript (text out), so its hold carries all three: the audio at
 * OpenAI's per-second figure, the prompt's tokens, and a transcript allowance of 50 tokens
 * plus 6 a second (people say about 2.5 words, some 3.5 tokens, a second). Other models
 * (MAI) are billed on audio time alone.
 */
export function hearingHoldUnits(model: string, durationMs: number, promptChars: number): Units {
  const audio = Math.max(0, Math.round(durationMs));
  if (!model.startsWith("openai/")) return { audio_ms: audio };
  return {
    audio_ms: audio,
    input_tokens: Math.ceil(Math.max(0, promptChars) / CHARS_PER_TOKEN) + 20,
    output_tokens: 50 + Math.ceil((audio / 1000) * 6),
  };
}

/** An AI answer: the system prompt and the request as text in, the output ceiling out. */
export function answerHoldUnits(promptChars: number, maxOutputTokens: number): Units {
  return {
    input_tokens: Math.ceil(Math.max(0, promptChars) / CHARS_PER_TOKEN),
    output_tokens: Math.max(0, Math.round(maxOutputTokens)),
  };
}
