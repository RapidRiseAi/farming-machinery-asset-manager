import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import type { Units } from "./ledger";

/**
 * A farm's own OpenAI key, called at OpenAI directly (docs/AI_USAGE.md).
 *
 * Never through the Gateway's request-scoped BYOK. The Gateway documents that a request
 * whose own credentials fail "may still fall back to use system credentials", and that
 * zero data retention skips such keys altogether: either way the farm's use would land on
 * Rapid Rise's account with no hold, no bill and no limit, while the ledger said the farm
 * paid. Called directly, a refused key is simply a failed call, and the owner's choice
 * (pause, or carry on billed on ours) decides what happens next.
 *
 * Retries are off at every call site (each attempt is one ledger row), and an own-key
 * answer asks OpenAI not to store the conversation (OWN_KEY_RESPONSE_OPTIONS).
 */
export function farmOpenAi(apiKey: string) {
  return createOpenAI({ apiKey });
}

/** OpenAI's own id for a Gateway model id ("openai/gpt-4o-transcribe" is "gpt-4o-transcribe"); null for any other provider. */
export function openAiModelId(gatewayId: string): string | null {
  const id = gatewayId.startsWith("openai/") ? gatewayId.slice("openai/".length) : "";
  return /^[a-z0-9][a-z0-9.-]*$/i.test(id) ? id : null;
}

/** Responses API options for an own-key answer: do not keep the conversation at OpenAI. */
export const OWN_KEY_RESPONSE_OPTIONS = { openai: { store: false } } as const;

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/**
 * The tokens an OpenAI transcription really used, from its raw response body:
 * gpt-4o-transcribe answers `usage: {type: "tokens", input_tokens, input_token_details:
 * {audio_tokens, text_tokens}, output_tokens}`. Null when the body says nothing usable, so
 * the caller settles on the units it held instead.
 */
export function transcriptionTokenUnits(body: unknown): Units | null {
  const usage = (body as { usage?: Record<string, unknown> } | null | undefined)?.usage;
  if (!usage || typeof usage !== "object" || usage.type !== "tokens") return null;
  const details = (usage.input_token_details ?? {}) as Record<string, unknown>;
  const input = count(usage.input_tokens);
  const audio = count(details.audio_tokens);
  const text = count(details.text_tokens) ?? (input !== undefined && audio !== undefined ? Math.max(0, input - audio) : undefined);
  const output = count(usage.output_tokens);
  if (audio === undefined && output === undefined) return null;
  const units: Units = {};
  if (audio !== undefined) units.audio_input_tokens = audio;
  else if (input !== undefined) units.audio_input_tokens = input;
  if (text !== undefined && audio !== undefined) units.input_tokens = text;
  if (output !== undefined) units.output_tokens = output;
  return units;
}

/** The raw body of a transcription's response, which the AI SDK passes through untyped. */
export function transcriptionResponseBody(result: { responses?: readonly unknown[] }): unknown {
  const first = result.responses?.[0] as { body?: unknown } | undefined;
  return first?.body;
}
