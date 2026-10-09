import "server-only";

/**
 * The model settings and result types the assistant's AI shares.
 *
 * The AI itself is agent.ts: it reads the farm through tools on the person's own session.
 * The single-call interpreter that lived here until 2026-10-05 read the words of a hard
 * request and nothing else, which is why the assistant could not answer a fuel or cost
 * question at all.
 */

/** What a run cost, for the AI usage ledger. */
export type AgentUsage = {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  costUsd: number | null;
  generationId: string | null;
};

/**
 * The model answered, and was paid for, but with nothing usable: an empty reply, or a
 * proposal it could not express. Carries what the run used, so the ledger records its
 * cost (the farm is not billed for it).
 */
export class AssistantAgentInvalidOutput extends Error {
  constructor(readonly usage: AgentUsage) {
    super("assistant_agent_invalid_output");
    this.name = "AssistantAgentInvalidOutput";
  }
}

export function configuredLlmModel(): string {
  const model = process.env.LLM_MODEL?.trim();
  if (!model) throw new Error("LLM_MODEL is not configured.");
  return model;
}

/**
 * The model an AI answer falls back to when the Gateway refuses the configured one
 * outright, for example "Free tier users do not have access to this model" (seen in
 * production on 2026-10-05 with LLM_MODEL set to a paid-tier model). `LLM_FALLBACK_MODEL`,
 * else gpt-4.1-mini, which the free tier accepts; null when it is the same model.
 */
export function configuredLlmFallbackModel(primary: string): string | null {
  const fallback = process.env.LLM_FALLBACK_MODEL?.trim() || "openai/gpt-4.1-mini";
  return fallback && fallback !== primary ? fallback : null;
}

/**
 * Models the Gateway refused outright on our account, remembered for a while per server
 * instance. Measured on 2026-10-09: every one of 16 answers in the ledger first tried the
 * configured model, was refused ("Free tier users do not have access to this model"), and
 * only then held budget again and called the fallback, a wasted round trip on every turn.
 * Remembered, the turn goes straight to the fallback; forgotten after REFUSAL_MEMORY_MS so
 * adding Gateway credit puts the configured model back without a deploy.
 */
const REFUSAL_MEMORY_MS = 10 * 60_000;
const refusalStore = globalThis as typeof globalThis & { __fleetwiseRefusedModels?: Map<string, number> };
const refusedModels = refusalStore.__fleetwiseRefusedModels ?? new Map<string, number>();
refusalStore.__fleetwiseRefusedModels = refusedModels;

export function rememberRefusedModel(model: string, now = Date.now()): void {
  refusedModels.set(model, now + REFUSAL_MEMORY_MS);
}

export function recentlyRefused(model: string, now = Date.now()): boolean {
  const until = refusedModels.get(model);
  if (until === undefined) return false;
  if (until <= now) {
    refusedModels.delete(model);
    return false;
  }
  return true;
}

/**
 * The model a platform answer starts on: the configured one, or its fallback while the
 * configured one is remembered as refused.
 */
export function platformAnswerModel(now = Date.now()): string {
  const configured = configuredLlmModel();
  const fallback = configuredLlmFallbackModel(configured);
  return fallback && recentlyRefused(configured, now) ? fallback : configured;
}
