import { parseLocalReadRequest, type LocalReadRequest } from "./local-read";
import { matchMachine } from "./normalize";
import { parseDeterministic } from "./parser";
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
): AssistantMachine | null {
  if (!isAssistantWriteIntent(draft.intent)) return null;

  const byId = draft.machineId
    ? readableMachines.find((machine) => machine.id === draft.machineId) ?? null
    : null;
  const candidate = byId ?? matchMachine(draft.machineQuery ?? input, readableMachines).machine;
  if (!candidate || writableMachines.some((machine) => machine.id === candidate.id)) return null;
  return candidate;
}
