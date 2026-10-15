import type { AssistantTurnResponse, AssistantClarification } from "@/lib/assistant/types";
import { clarificationFromSpeech } from "@/lib/assistant/spoken-clarification";

export function confirmationAction(input: string, pending: AssistantTurnResponse | null) {
  if (pending?.kind !== "confirm") return null;
  if (Date.parse(pending.proposal.expiresAt) <= Date.now()) return null;
  const code = pending.proposal.proposalId.slice(0, 8).toUpperCase();
  if (input.trim().toUpperCase() === `CONFIRM ${code}`) return "confirm" as const;
  if (input.trim().toUpperCase() === `REJECT ${code}`) return "reject" as const;
  return null;
}

export function clarificationAnswer(input: string, pending: AssistantTurnResponse): AssistantClarification | null {
  if (pending.kind !== "clarify" || !pending.fields[0]) return null;
  const field = pending.fields[0];
  if (field.type === "select") {
    const index = /^\d+$/.test(input.trim()) ? Number(input.trim()) - 1 : -1;
    const option = field.options[index] ?? field.options.find(o => o.label.toLowerCase() === input.trim().toLowerCase());
    if (option) return { interactionId: pending.conversationId, [field.name]: option.value };
  }
  return clarificationFromSpeech(pending.conversationId, field, input);
}

export function renderWhatsAppResponse(response: AssistantTurnResponse, origin: string): string {
  switch (response.kind) {
    case "confirm": return [response.proposal.title, response.proposal.machineName,
      ...response.proposal.facts.map(f => `${f.label}: ${f.value}`),
      `Reply CONFIRM ${response.proposal.proposalId.slice(0, 8).toUpperCase()} to save, or REJECT ${response.proposal.proposalId.slice(0, 8).toUpperCase()} to discard.`,
    ].join("\n");
    case "clarify": {
      const field = response.fields[0];
      return [response.question, field?.label,
        ...(field?.type === "select" ? field.options.map((o, i) => `${i + 1}. ${o.label}`) : []),
        "Reply to this question, or type NEW to start over.",
      ].filter(Boolean).join("\n");
    }
    case "needs_consent": return `${response.explanation}\n${origin}/assistant`;
    case "answer": return `${response.message}${response.action && /^\/(?!\/)/.test(response.action.href) ? `\n${origin}${response.action.href}` : ""}`;
    case "error": return `${response.message}${response.code === "ai_paused" ? `\n${origin}/assistant` : ""}`;
  }
}
