import assert from "node:assert/strict";
import test from "node:test";
import { missingFields, proposalFor, queryAnswer } from "./presentation";
import type { AssistantDraft, AssistantMachine } from "./types";

const machine: AssistantMachine = {
  id: "20000000-0000-0000-0000-000000000001",
  name: "Groen John Deere",
  make: "John Deere",
  model: "6120M",
  aliases: [],
  status: "out_of_service",
  meterType: "hours",
  currentReading: 4820,
  currentReadingDate: "2026-08-18",
  serviceStatus: null,
  nextDueDate: null,
  nextDueReading: null,
};

test("localizes machine status in assistant answers", () => {
  const draft = { intent: "query_asset_status" } as AssistantDraft;

  assert.match(queryAnswer(draft, machine, "en-ZA"), /is out of service\./);
  assert.match(queryAnswer(draft, machine, "af-ZA"), /status is buite werking\./);
});

test("localizes fault urgency in confirmation facts", () => {
  const draft = {
    intent: "report_fault",
    description: "Hydraulic leak",
    urgency: "can_work",
  } as AssistantDraft;

  const english = proposalFor("11111111-1111-4111-8111-111111111111", draft, machine, "en-ZA", "2026-08-20T15:00:00Z");
  const afrikaans = proposalFor("11111111-1111-4111-8111-111111111111", draft, machine, "af-ZA", "2026-08-20T15:00:00Z");

  assert.equal(english.facts.find((fact) => fact.label === "Urgency")?.value, "Can still work");
  assert.equal(afrikaans.facts.find((fact) => fact.label === "Dringendheid")?.value, "Kan nog werk");
});

test("asks for the actual problem before other missing fault details", () => {
  const draft = {
    intent: "report_fault",
    machineId: null,
    description: null,
    urgency: null,
  } as AssistantDraft;

  const english = missingFields(draft, [machine], "en-ZA");
  const afrikaans = missingFields(draft, [machine], "af-ZA");
  assert.equal(english?.question, "What is the problem?");
  assert.deepEqual(english?.fields.map((field) => field.name), ["description"]);
  assert.equal(afrikaans?.question, "Wat is die probleem?");
});

test("asks whether a faulted machine can still operate when urgency is unstated", () => {
  const draft = {
    intent: "report_fault",
    machineId: machine.id,
    description: "Broken window",
    urgency: null,
  } as AssistantDraft;
  const missing = missingFields(draft, [machine], "en-ZA");
  assert.equal(missing?.fields[0]?.name, "urgency");
  assert.match(missing?.question ?? "", /still operate safely/i);
});

test("walks a generic fault through one safe question at a time", () => {
  let draft = {
    intent: "report_fault",
    machineId: null,
    description: null,
    urgency: null,
  } as AssistantDraft;

  assert.deepEqual(missingFields(draft, [machine], "en-ZA")?.fields.map((field) => field.name), ["description"]);
  draft = { ...draft, description: "Broken window" };
  assert.deepEqual(missingFields(draft, [machine], "en-ZA")?.fields.map((field) => field.name), ["machineId"]);
  draft = { ...draft, machineId: machine.id };
  assert.deepEqual(missingFields(draft, [machine], "af-ZA")?.fields.map((field) => field.name), ["urgency"]);
  draft = { ...draft, urgency: "can_work" };
  assert.equal(missingFields(draft, [machine], "en-ZA"), null);
});
