import assert from "node:assert/strict";
import test from "node:test";
import { matchMachine } from "./normalize";
import { assistantTurnRequestSchema } from "./request-schema";
import { matchAcrossHypotheses, planAcrossHypotheses } from "./routing";
import type { AssistantMachine } from "./types";

function machine(id: string, name: string, extra: Partial<AssistantMachine> = {}): AssistantMachine {
  return {
    id, name, make: null, model: null, aliases: [], status: "active", meterType: "hours",
    currentReading: null, currentReadingDate: null, serviceStatus: null, nextDueDate: null, nextDueReading: null,
    ...extra,
  };
}

const fleet = [
  machine("dddddddd-0000-4000-8000-000000000001", "Oom Piet se Trok", { make: "Mercedes-Benz", model: "Atego 1518", meterType: "km" }),
  machine("dddddddd-0000-4000-8000-000000000002", "Rooi Bakkie", { make: "Toyota", model: "Hilux", meterType: "km" }),
  machine("dddddddd-0000-4000-8000-000000000003", "Die Ou Massey", { make: "Massey Ferguson", model: "290" }),
  machine("dddddddd-0000-4000-8000-000000000004", "Witkop", { make: "New Holland", model: "T7.210" }),
];

// Quoted as Azure returned them for the same recording (2026-10-03 evaluation).
test("the hearing that got the name right wins: English garbles it, Afrikaans keeps it", () => {
  const english = "Log 125000 kilometers for um Pizza Druck.";
  const afrikaans = "Lok want toe 5 zero kilometers vir oompiet.se trok.";
  assert.equal(matchMachine(english, fleet).machine, null);
  assert.equal(matchAcrossHypotheses([english, afrikaans], fleet).machine?.name, "Oom Piet se Trok");
});

test("two hearings confidently naming different machines become a question", () => {
  const result = matchAcrossHypotheses(["report a leak on the rooi bakkie", "report a leak on witkop"], fleet);
  assert.equal(result.machine, null);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.alternatives.map((m) => m.name).sort(), ["Rooi Bakkie", "Witkop"]);
});

test("one hearing behaves exactly like the single-transcript matcher", () => {
  for (const text of ["service the witkop", "what is wrong", "die rooi bakkie se remme"]) {
    const one = matchAcrossHypotheses([text], fleet);
    const plain = matchMachine(text, fleet);
    assert.equal(one.machine?.id ?? null, plain.machine?.id ?? null);
    assert.equal(one.ambiguous, plain.ambiguous);
  }
});

test("intent comes from the first hearing that has one", () => {
  // Language ID put an English sentence through the Afrikaans model: no intent words left.
  const shown = "Lok 3450 ouers op die ou Massey.";
  const { plan, text } = planAcrossHypotheses(shown, "en-ZA", [{ text: "Log 3450 hours on the old Massey.", locale: "en-ZA" }]);
  assert.equal(plan.kind, "deterministic");
  assert.equal(plan.draft.intent, "log_reading");
  assert.equal(plan.draft.reading, 3450);
  assert.equal(text, "Log 3450 hours on the old Massey.");
  // A shown transcript that parses keeps priority over every alternative.
  const own = planAcrossHypotheses("Report a hydraulic leak on Witkop.", "en-ZA", [{ text: "Log 10 hours on Witkop.", locale: "en-ZA" }]);
  assert.equal(own.plan.draft.intent, "report_fault");
});

test("only a spoken request may carry other hearings, at most four", () => {
  const base = { input: "Log 4300 hours on Witkop", locale: "en-ZA", voiceCaptureId: "eeeeeeee-0000-4000-8000-000000000001" };
  const hearing = { text: "Log 4300 ure op Witkop", locale: "af-ZA", source: "second-pass" };
  assert.equal(assistantTurnRequestSchema.safeParse({ ...base, channel: "voice", alternatives: [hearing] }).success, true);
  assert.equal(assistantTurnRequestSchema.safeParse({ ...base, channel: "typed", voiceCaptureId: undefined, alternatives: [hearing] }).success, false);
  assert.equal(assistantTurnRequestSchema.safeParse({ ...base, channel: "voice", alternatives: Array(5).fill(hearing) }).success, false);
});
