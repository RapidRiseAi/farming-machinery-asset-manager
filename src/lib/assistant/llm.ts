import "server-only";

import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { gatewayCallCost } from "@/lib/ai-usage/gateway-cost";
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

const navigationSchema = z.enum(["none", "machines", "faults", "jobcards", "work", "documents"]);
const agentOutputSchema = z.object({
  kind: z.enum(["command", "answer"]),
  draft: parsedCommandSchema.nullable(),
  answer: z.string().max(2500).nullable(),
  navigation: navigationSchema,
});

export const LLM_AGENT_TIMEOUT_MS = 18_000;

/** What the call cost, for the AI usage ledger. */
type AgentUsage = {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  costUsd: number | null;
  generationId: string | null;
};

export type AssistantAgentResult =
  | ({ kind: "command"; draft: AssistantDraft } & AgentUsage)
  | ({ kind: "answer"; answer: string; navigation: z.infer<typeof navigationSchema> } & AgentUsage);

/**
 * The model answered, and was paid for, but with nothing usable: JSON that does not parse,
 * an answer cut off at the output ceiling, or a command with no intent. Carries what the
 * call used, so the ledger records its cost (the farm is not billed for it).
 */
export class AssistantAgentInvalidOutput extends Error {
  constructor(readonly usage: AgentUsage) {
    super("assistant_agent_invalid_output");
    this.name = "AssistantAgentInvalidOutput";
  }
}

/** The output ceiling, which is also what an AI answer's budget hold is sized on. */
export const LLM_MAX_OUTPUT_TOKENS = 900;

export function configuredLlmModel(): string {
  const model = process.env.LLM_MODEL?.trim();
  if (!model) throw new Error("LLM_MODEL is not configured.");
  return model;
}

export async function runAssistantAgent(input: {
  text: string;
  locale: AssistantLocale;
  /** The Gateway model id: what runs (unless `languageModel` is given) and what the ledger records. */
  model?: string;
  /** A model object to run instead, such as OpenAI called directly on a farm's own key (ai-usage/openai-direct.ts). */
  languageModel?: LanguageModel;
  abortSignal?: AbortSignal;
  /** Gateway options (reconciliation tags) on ours, or OpenAI's own options on a farm's key. */
  providerOptions?: Record<string, Record<string, unknown>>;
}): Promise<AssistantAgentResult> {
  const model = input.model ?? configuredLlmModel();
  const started = Date.now();
  const unusable = (usage: { inputTokens?: number; outputTokens?: number } | undefined, providerMetadata?: unknown) =>
    new AssistantAgentInvalidOutput({
      model,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      latencyMs: Date.now() - started,
      ...gatewayCallCost(providerMetadata),
    });
  const result = await generateText({
    model: input.languageModel ?? model,
    output: Output.object({ schema: agentOutputSchema }),
    temperature: 0,
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
    // No hidden retries: each attempt is held for and billed on its own, and the caller
    // decides about a fallback model. The SDK's default of two would make three billed
    // calls against a one-call hold.
    maxRetries: 0,
    abortSignal: input.abortSignal,
    timeout: { totalMs: LLM_AGENT_TIMEOUT_MS },
    // The SDK's ProviderOptions type is a nested record of JSON values; the gateway options
    // built in ai-usage/gateway-options.ts are exactly that.
    providerOptions: input.providerOptions as Parameters<typeof generateText>[0]["providerOptions"],
    system: [
      "You are FleetWise's farm-machinery operations assistant.",
      `Reply in ${input.locale === "af-ZA" ? "natural Afrikaans" : "South African English"}; keep brand, model, person and part names exactly as the user gives them.`,
      "Users may freely mix Afrikaans and English in one sentence.",
      "You receive only the difficult transcript text, selected language and current date. You have no database access and no tools. Machine lists and database records are never sent to you.",
      "Fleet and document questions are handled locally before this call. Never invent or claim knowledge of a fleet record, status, amount, person, contact detail or banking detail.",
      "You have no write tool and must never claim that you created, changed, sent, accepted, paid or deleted anything.",
      "A farm user can request a quote through a work request; only a workshop can issue an actual quote. If asked to create a quote here, explain that boundary and choose work navigation.",
      "If the user is making one of the five allowed commands, return kind=command and extract it: report_fault, log_reading, log_service, query_asset_status, query_service_due.",
      "A question or history request beginning with show, list, what, which, when, wys, lys, wat, watter or wanneer is not a write command even if it contains words such as report, log or completed.",
      "For a command, copy the spoken machine wording into machineQuery, never invent an ID, and use null for every unstated field.",
      "A generic phrase such as 'I want to report a problem' or 'Ek wil 'n probleem rapporteer' has description=null; it states intent but not the actual problem.",
      "Do not assume fault urgency. It is null unless the user explicitly says whether the machine stopped, is limited, or can still work.",
      "For a broader request that needs farm data, say that the safe local assistant could not map the wording and point to the most useful page. For a harmless general question, give a short factual answer without implying access to farm records.",
    ].join(" "),
    prompt: `Today in South Africa: ${todayInSouthAfrica()}\nUser request: ${input.text}`,
  }).catch((error: unknown) => {
    // A reply that does not parse still cost what it used.
    if (NoObjectGeneratedError.isInstance(error)) throw unusable(error.usage);
    throw error;
  });
  const common: AgentUsage = {
    model,
    inputTokens: result.usage.inputTokens ?? null,
    outputTokens: result.usage.outputTokens ?? null,
    latencyMs: Date.now() - started,
    ...gatewayCallCost(result.providerMetadata),
  };
  let output: z.infer<typeof agentOutputSchema>;
  try {
    output = result.output;
  } catch {
    // Cut off before it finished (the output ceiling reached during reasoning): no output.
    throw new AssistantAgentInvalidOutput(common);
  }

  if (output.kind === "command" && output.draft?.intent) {
    return {
      kind: "command",
      draft: { ...output.draft, machineId: null },
      ...common,
    };
  }
  if (output.kind === "answer" && output.answer?.trim()) {
    return {
      kind: "answer",
      answer: output.answer.trim(),
      navigation: output.navigation,
      ...common,
    };
  }
  throw new AssistantAgentInvalidOutput(common);
}
