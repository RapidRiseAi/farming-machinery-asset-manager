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
