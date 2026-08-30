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

const navigationSchema = z.enum(["none", "machines", "faults", "jobcards", "work", "documents"]);
const agentOutputSchema = z.object({
  kind: z.enum(["command", "answer"]),
  draft: parsedCommandSchema.nullable(),
  answer: z.string().max(2500).nullable(),
  navigation: navigationSchema,
});

export const LLM_AGENT_TIMEOUT_MS = 18_000;

export type AssistantAgentResult =
  | {
      kind: "command";
      draft: AssistantDraft;
      model: string;
      inputTokens: number | null;
      outputTokens: number | null;
      latencyMs: number;
    }
  | {
      kind: "answer";
      answer: string;
      navigation: z.infer<typeof navigationSchema>;
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

export async function runAssistantAgent(input: {
  text: string;
  locale: AssistantLocale;
  model?: string;
  abortSignal?: AbortSignal;
}): Promise<AssistantAgentResult> {
  const model = input.model ?? configuredLlmModel();
  const started = Date.now();
  const result = await generateText({
    model,
    output: Output.object({ schema: agentOutputSchema }),
    temperature: 0,
    maxOutputTokens: 900,
    abortSignal: input.abortSignal,
    timeout: { totalMs: LLM_AGENT_TIMEOUT_MS },
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
  });
  const output = result.output;
  const common = {
    model,
    inputTokens: result.usage.inputTokens ?? null,
    outputTokens: result.usage.outputTokens ?? null,
    latencyMs: Date.now() - started,
  };

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
  throw new Error("assistant_agent_invalid_output");
}
