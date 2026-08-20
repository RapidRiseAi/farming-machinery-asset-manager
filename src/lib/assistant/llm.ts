import "server-only";

import { generateText, Output } from "ai";
import { z } from "zod";
import { ASSISTANT_INTENTS, type AssistantDraft, type AssistantLocale } from "./types";
import { todayInSouthAfrica } from "./date";

const parsedCommandSchema = z.object({
  intent: z.enum(ASSISTANT_INTENTS).nullable(),
  machineQuery: z.string().max(160).nullable(),
  description: z.string().max(2000).nullable(),
  category: z.string().max(80).nullable(),
  urgency: z.enum(["can_work", "limping", "stopped"]).nullable(),
  reading: z.number().nonnegative().nullable(),
  readingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  workPerformed: z.string().max(2000).nullable(),
  confidence: z.number().min(0).max(1),
});

export const LLM_PARSE_TIMEOUT_MS = 12_000;

export type LlmParseResult = {
  draft: AssistantDraft;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
};

export function configuredLlmModel(): string {
  const model = process.env.LLM_MODEL?.trim();
  if (!model) throw new Error("LLM_MODEL is not configured.");
  return model;
}

export async function parseWithLlm(
  input: string,
  locale: AssistantLocale,
  model = configuredLlmModel(),
  abortSignal?: AbortSignal,
): Promise<LlmParseResult> {
  const started = Date.now();
  const result = await generateText({
    model,
    output: Output.object({ schema: parsedCommandSchema }),
    temperature: 0,
    maxOutputTokens: 500,
    abortSignal,
    timeout: { totalMs: LLM_PARSE_TIMEOUT_MS },
    system: [
      "You extract one FleetWise farm-machinery command. You never execute anything.",
      "Allowed intents: report_fault, log_reading, log_service, query_asset_status, query_service_due.",
      "The user may speak Afrikaans, South African English, or mix both.",
      "Copy the spoken machine name into machineQuery; never invent a database ID.",
      "A completed service needs the meter reading. A fault description must preserve the actual problem.",
      "Use null for information not stated. Dates are YYYY-MM-DD.",
    ].join(" "),
    prompt: `Locale: ${locale}\nToday: ${todayInSouthAfrica()}\nCommand: ${input}`,
  });

  const parsed = result.output;
  return {
    draft: {
      ...parsed,
      machineId: null,
    },
    model,
    inputTokens: result.usage.inputTokens ?? null,
    outputTokens: result.usage.outputTokens ?? null,
    latencyMs: Date.now() - started,
  };
}
