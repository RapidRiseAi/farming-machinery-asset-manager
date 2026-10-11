import assert from "node:assert/strict";
import test from "node:test";
import {
  matchAssistantMachine,
  machinesForAssistantDraft,
  planAssistantRoute,
  readOnlyWriteTarget,
  routeWantsAgent,
} from "./routing";
import type { AssistantDraft, AssistantMachine } from "./types";

const assigned: AssistantMachine = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "John Deere 6155R",
  make: "John Deere",
  model: "6155R",
  aliases: ["Djon Deer"],
  status: "active",
  meterType: "hours",
  currentReading: 4400,
  currentReadingDate: "2026-08-29",
  serviceStatus: "ok",
  nextDueDate: null,
  nextDueReading: 4500,
};

const readOnly: AssistantMachine = {
  ...assigned,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Mercedes-Benz Actros 2645",
  make: "Mercedes-Benz",
  model: "Actros 2645",
  aliases: ["Mercedes trok"],
};

function draft(overrides: Partial<AssistantDraft>): AssistantDraft {
  return {
    intent: null,
    machineQuery: null,
    machineId: null,
    description: null,
    category: null,
    urgency: null,
    reading: null,
    readingDate: null,
    serviceDate: null,
    workPerformed: null,
    confidence: 1,
    ...overrides,
  };
}

test("keeps see-all operator machines readable but out of write proposals", () => {
  const readable = [assigned, readOnly];
  const writable = [assigned];
  assert.deepEqual(
    machinesForAssistantDraft(draft({ intent: "query_asset_status" }), readable, writable),
    readable,
  );
  assert.deepEqual(
    machinesForAssistantDraft(draft({ intent: "report_fault" }), readable, writable),
    writable,
  );
});

test("detects an English read-only machine before offering a fault confirmation", () => {
  const target = readOnlyWriteTarget(
    draft({ intent: "report_fault", machineQuery: "Mercedes trok", description: "broken window" }),
    "Report a broken window on the Mercedes truck",
    [assigned, readOnly],
    [assigned],
  );
  assert.equal(target?.id, readOnly.id);
});

test("detects an Afrikaans read-only machine selected by id", () => {
  const target = readOnlyWriteTarget(
    draft({ intent: "report_fault", machineId: readOnly.id, description: "gebreekte venster" }),
    "Rapporteer 'n gebreekte venster op die Mercedes trok",
    [assigned, readOnly],
    [assigned],
  );
  assert.equal(target?.id, readOnly.id);
});

test("does not block an assigned write or any read", () => {
  const readable = [assigned, readOnly];
  assert.equal(
    readOnlyWriteTarget(
      draft({ intent: "report_fault", machineId: assigned.id }),
      "Report a fault on the John Deere",
      readable,
      [assigned],
    ),
    null,
  );
  assert.equal(
    readOnlyWriteTarget(
      draft({ intent: "query_asset_status", machineId: readOnly.id }),
      "What is the Mercedes status?",
      readable,
      [assigned],
    ),
    null,
  );
});

test("preserves ambiguity across assigned and read-only machines", () => {
  const secondJohnDeere: AssistantMachine = {
    ...readOnly,
    name: "John Deere 6120M",
    make: "John Deere",
    model: "6120M",
    aliases: [],
  };
  const match = matchAssistantMachine(
    draft({ intent: "report_fault", machineQuery: "John Deere", description: "broken window" }),
    "Report a broken window on John Deere",
    [assigned, secondJohnDeere],
    [assigned],
  );
  assert.equal(match.machine, null);
  assert.equal(match.ambiguous, true);
  assert.deepEqual(match.alternatives.map((machine) => machine.id).sort(), [assigned.id, secondJohnDeere.id].sort());
});

test("still resolves a read-only machine for a status question", () => {
  const match = matchAssistantMachine(
    draft({ intent: "query_asset_status", machineQuery: "Mercedes trok" }),
    "What is the status of the Mercedes truck?",
    [assigned, readOnly],
    [assigned],
  );
  assert.equal(match.machine?.id, readOnly.id);
});

test("questions about the records only the AI reads go to the AI, whatever the local reads think", async () => {
  const { detectFarmTopics } = await import("./topics");
  // Each answered "FleetWise has no record" in production before 2026-10-11, and the
  // drivers' one was taken by the local reader as a search for a machine.
  for (const [said, topic] of [
    ["Do any of our drivers' documents expire soon?", "compliance"],
    ["When does the bakkie's licence disc expire?", "compliance"],
    ["Which tyres need replacing?", "tyres"],
    ["How many oil filters do we have in stock?", "stock"],
    ["Are we over budget on parts?", "budget"],
    ["Do we have any outstanding traffic fines?", "incidents"],
    ["What is the tractor worth now?", "value"],
    ["Wanneer verval die bakkie se lisensie?", "compliance"],
    ["Watter onderdele raak min in die voorraad?", "stock"],
  ] as const) {
    assert.ok(detectFarmTopics(said).includes(topic), `${said} -> ${topic}`);
    assert.equal(routeWantsAgent(planAssistantRoute(said, said.startsWith("W") && /verval|onderdele/.test(said) ? "af-ZA" : "en-ZA"), said), true, said);
  }
  // A fault said as a statement is still a report for the parser, not a question for the AI.
  assert.equal(routeWantsAgent(planAssistantRoute("The bakkie has a flat tyre", "en-ZA"), "The bakkie has a flat tyre"), false);
});
