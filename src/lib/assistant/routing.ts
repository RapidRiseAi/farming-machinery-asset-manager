import { parseLocalReadRequest, type LocalReadRequest } from "./local-read";
import { matchMachine, type MachineMatch } from "./normalize";
import { parseDeterministic } from "./parser";
import { questionNeedsAgent } from "./topics";
import type { AssistantDraft, AssistantLocale, AssistantMachine } from "./types";

export type AssistantRoutePlan =
  | { kind: "local"; request: LocalReadRequest; draft: AssistantDraft }
  | { kind: "deterministic"; draft: AssistantDraft }
  | { kind: "optional_ai"; draft: AssistantDraft };

/**
 * Local reads are deliberately classified before mutations. This prevents a
 * question such as "show open faults" from being mistaken for a new report and
 * makes the no-provider path explicit and independently testable.
 */
export function planAssistantRoute(input: string, locale: AssistantLocale): AssistantRoutePlan {
  const local = parseLocalReadRequest(input);
  const draft = parseDeterministic(input, locale);
  if (local) {
    return { kind: "local", request: local, draft: { ...draft, intent: null } };
  }
  if (draft.intent) return { kind: "deterministic", draft };
  return { kind: "optional_ai", draft };
}

/**
 * The same utterance, heard more than once: the live recogniser, a second pass in the
 * other fixed language, an AI transcriber. Intent comes from the first hearing that
 * yields one, in the order given (the shown transcript first), so a sentence the live
 * recogniser wrote in the wrong language ("Lok 3450 ouers...") still parses from the
 * English hearing instead of falling to the optional AI path.
 */
export function planAcrossHypotheses(
  input: string,
  locale: AssistantLocale,
  alternatives: ReadonlyArray<{ text: string; locale: AssistantLocale }> = [],
): { plan: AssistantRoutePlan; text: string } {
  const first = planAssistantRoute(input, locale);
  if (first.kind !== "optional_ai") return { plan: first, text: input };
  for (const alternative of alternatives) {
    const plan = planAssistantRoute(alternative.text, alternative.locale);
    if (plan.kind !== "optional_ai") return { plan, text: alternative.text };
  }
  return { plan: first, text: input };
}

/** A rival hearing within this of the best one is a doubt, not noise. */
const CROSS_HEARING_MARGIN = 0.05;

/**
 * Each recogniser keeps what another loses: the English model keeps the sentence and
 * garbles an Afrikaans name, the Afrikaans model the reverse. On recorded mixed speech,
 * the best hearing of the name was right far more often than any single transcript. The
 * most confident unambiguous machine wins; another hearing confidently naming a
 * DIFFERENT machine turns the answer into a question rather than a guess.
 */
export function matchAcrossHypotheses(texts: readonly string[], machines: AssistantMachine[]): MachineMatch {
  const results = texts.map((text) => text.trim()).filter(Boolean).map((text) => matchMachine(text, machines));
  if (!results.length) return { machine: null, score: 0, ambiguous: false, alternatives: [] };
  const resolved = results.filter((result) => result.machine).sort((a, b) => b.score - a.score);
  const top = resolved[0];
  if (!top?.machine) {
    return [...results].sort((a, b) => Number(b.ambiguous) - Number(a.ambiguous) || b.score - a.score)[0];
  }
  const topId = top.machine.id;
  const rivals = resolved.filter((result) => result.machine!.id !== topId && result.score >= top.score - CROSS_HEARING_MARGIN);
  // A hearing torn between machines, more confident than `top`, and not about it at all.
  const doubters = results.filter(
    (result) => !result.machine && result.ambiguous && result.score > top.score && !result.alternatives.some((m) => m.id === topId),
  );
  if (!rivals.length && !doubters.length) return top;
  const options = new Map<string, AssistantMachine>([[topId, top.machine]]);
  for (const result of rivals) options.set(result.machine!.id, result.machine!);
  for (const result of doubters) for (const machine of result.alternatives) options.set(machine.id, machine);
  return { machine: null, score: top.score, ambiguous: true, alternatives: [...options.values()].slice(0, 5) };
}

/**
 * Whether a turn goes to the AI agent. Free, instant answers stay free and instant: the
 * agent is asked only when the question needs what the local paths cannot do (topics.ts:
 * fuel, money, sums, comparisons, periods, follow-ups), or when nothing local understood
 * it at all. Writes the parser understood keep their own path: they are confirmed on a
 * card either way.
 */
export function routeWantsAgent(plan: AssistantRoutePlan, input: string): boolean {
  if (plan.kind === "optional_ai") return true;
  if (plan.kind === "local") {
    return !["help", "navigation", "quote_boundary"].includes(plan.request.kind) && questionNeedsAgent(input);
  }
  return !isAssistantWriteIntent(plan.draft.intent) && questionNeedsAgent(input);
}

export function isAssistantWriteIntent(intent: AssistantDraft["intent"]): boolean {
  return intent === "report_fault" || intent === "log_reading" || intent === "log_service";
}

export function machinesForAssistantDraft(
  draft: AssistantDraft,
  readableMachines: AssistantMachine[],
  writableMachines: AssistantMachine[],
): AssistantMachine[] {
  return isAssistantWriteIntent(draft.intent) ? writableMachines : readableMachines;
}

/** Returns a visible machine that the current user may read but not change. */
export function readOnlyWriteTarget(
  draft: AssistantDraft,
  input: string,
  readableMachines: AssistantMachine[],
  writableMachines: AssistantMachine[],
  alternativeTexts: readonly string[] = [],
): AssistantMachine | null {
  if (!isAssistantWriteIntent(draft.intent)) return null;

  const byId = draft.machineId
    ? readableMachines.find((machine) => machine.id === draft.machineId) ?? null
    : null;
  const candidate = byId ?? matchAcrossHypotheses([draft.machineQuery ?? input, ...alternativeTexts], readableMachines).machine;
  if (!candidate || writableMachines.some((machine) => machine.id === candidate.id)) return null;
  return candidate;
}

/**
 * Match writes against their writable scope without losing ambiguity that is
 * visible in the broader read scope. Removing a read-only candidate must never
 * make a vague phrase look uniquely assigned to a different machine.
 */
export function matchAssistantMachine(
  draft: AssistantDraft,
  input: string,
  readableMachines: AssistantMachine[],
  writableMachines: AssistantMachine[],
  alternativeTexts: readonly string[] = [],
): MachineMatch {
  const candidates = machinesForAssistantDraft(draft, readableMachines, writableMachines);
  if (draft.machineId) {
    const selected = candidates.find((machine) => machine.id === draft.machineId) ?? null;
    return {
      machine: selected,
      alternatives: selected ? [] : candidates,
      ambiguous: false,
      score: selected ? 1 : 0,
    };
  }

  const texts = [draft.machineQuery ?? input, ...alternativeTexts];
  if (isAssistantWriteIntent(draft.intent)) {
    const readableMatch = matchAcrossHypotheses(texts, readableMachines);
    if (readableMatch.ambiguous) return readableMatch;
  }
  return matchAcrossHypotheses(texts, candidates);
}
