import assert from "node:assert/strict";
import test from "node:test";
import { draftFromProposal, farmAgentTools } from "./agent";
import type { FarmDataScope } from "./farm-data";
import { parseLocalReadRequest } from "./local-read";
import { parseDeterministic } from "./parser";
import { missingFields, proposalFor } from "./presentation";
import { planAssistantRoute, routeWantsAgent } from "./routing";
import { clarificationFromSpeech } from "./spoken-clarification";
import type { AssistantDraft, AssistantMachine } from "./types";

const bakkie: AssistantMachine = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "White bakkie",
  type: "bakkie",
  make: "Toyota",
  model: "Hilux",
  aliases: [],
  status: "active",
  meterType: "km",
  currentReading: 52000,
  currentReadingDate: "2026-10-01",
  serviceStatus: "ok",
  nextDueDate: null,
  nextDueReading: 60000,
};
const TANKS = [
  { id: "33333333-3333-4333-8333-333333333331", name: "Main tank" },
  { id: "33333333-3333-4333-8333-333333333332", name: "Shed tank" },
];
const ELEVEN = ["category", "confidence", "description", "intent", "machineId", "machineQuery", "reading", "readingDate", "serviceDate", "urgency", "workPerformed"];

test("a diesel draw said aloud is understood without AI, in both languages", () => {
  for (const [said, locale, litres] of [
    ["I put 80 litres in the white bakkie", "en-ZA", 80],
    ["Filled the bakkie with 65.5 litres of diesel", "en-ZA", 65.5],
    ["Log 120 l diesel for the white bakkie", "en-ZA", 120],
    ["Gooi 90 liter diesel in die wit bakkie", "af-ZA", 90],
    ["Ek het honderd liter in die bakkie gegooi", "af-ZA", 100],
  ] as const) {
    const draft = parseDeterministic(said, locale);
    assert.equal(draft.intent, "log_fuel", said);
    assert.equal(draft.litres, litres, said);
    assert.equal(draft.tankId, null, said);
    assert.ok(draft.readingDate, said);
    // A draw the parser understood never costs an AI call.
    assert.equal(routeWantsAgent(planAssistantRoute(said, locale), said), false, said);
  }
});

test("a draw can carry the meter reading, and the litres are never taken for it", () => {
  const draft = parseDeterministic("I put 80 litres in the bakkie at 52700 km", "en-ZA");
  assert.equal(draft.litres, 80);
  assert.equal(draft.reading, 52700);
});

test("questions about litres are reads, not draws", () => {
  for (const said of ["How many litres did we use last month?", "Hoeveel liter diesel het die bakkie gebruik?", "Which machine used the most diesel?"]) {
    assert.notEqual(parseDeterministic(said, "en-ZA").intent, "log_fuel", said);
  }
  // And a spoken draw is never swallowed by the local reads first.
  assert.equal(parseLocalReadRequest("I put 80 litres in the white bakkie"), null);
  assert.equal(parseLocalReadRequest("Log 120 l diesel for the white bakkie"), null);
});

test("only a draw carries litres and a tank: every other draft keeps the eleven keys", () => {
  assert.deepEqual(Object.keys(parseDeterministic("The bakkie has a flat tyre", "en-ZA")).sort(), ELEVEN);
  assert.deepEqual(Object.keys(parseDeterministic("Log 3450 hours on the tractor", "en-ZA")).sort(), ELEVEN);
  assert.deepEqual(Object.keys(parseDeterministic("I put 80 litres in the bakkie", "en-ZA")).sort(), [...ELEVEN, "litres", "tankId"].sort());
});

test("the agent's draw proposal becomes a thirteen-key draft, dated today unless a past day was said", () => {
  const draft = draftFromProposal("propose_fuel_draw", { machine: "bakkie", litres: 80, tank: "shed tank", meterReading: 52700, date: null }, "2026-10-09");
  assert.ok(draft);
  assert.equal(draft.intent, "log_fuel");
  assert.equal(draft.litres, 80);
  assert.equal(draft.reading, 52700);
  assert.equal(draft.readingDate, "2026-10-09");
  assert.equal(draft.tankId, null);
  assert.deepEqual(Object.keys(draft).sort(), [...ELEVEN, "litres", "tankId"].sort());
  assert.equal(draftFromProposal("propose_fuel_draw", { machine: "bakkie", litres: -5 }, "2026-10-09")?.litres, null);
  assert.equal(draftFromProposal("propose_fuel_draw", { machine: "bakkie", litres: 10, date: "2026-12-01" }, "2026-10-09")?.readingDate, "2026-10-09");
});

test("an operator may propose a draw, as they may draw on the Fuel page", () => {
  const scope = { supabase: {} as FarmDataScope["supabase"], farmId: "f", role: "operator", machines: [bakkie], costsVisible: false } as FarmDataScope;
  assert.ok("propose_fuel_draw" in farmAgentTools(scope, "2026-10-09"));
});

test("the questions: litres first, then the tank only when there is more than one", () => {
  const draft: AssistantDraft = { ...parseDeterministic("I put fuel in the bakkie", "en-ZA"), intent: "log_fuel", machineId: bakkie.id, litres: null, tankId: null };
  assert.equal(missingFields(draft, [bakkie], "en-ZA", undefined, TANKS)?.fields[0].name, "litres");
  const withLitres = { ...draft, litres: 80 };
  const tank = missingFields(withLitres, [bakkie], "en-ZA", undefined, TANKS);
  assert.equal(tank?.fields[0].name, "tankId");
  assert.equal(tank?.fields[0].type === "select" ? tank.fields[0].options.length : 0, 2);
  assert.equal(missingFields(withLitres, [bakkie], "en-ZA", undefined, [TANKS[0]]), null);
  assert.equal(missingFields({ ...withLitres, tankId: TANKS[1].id }, [bakkie], "en-ZA", undefined, TANKS), null);
});

test("the card says what will be recorded", () => {
  const draft: AssistantDraft = { ...parseDeterministic("I put 80 litres in the bakkie at 52700 km", "en-ZA"), machineId: bakkie.id, tankId: TANKS[1].id };
  const card = proposalFor("p", draft, bakkie, "en-ZA", "2026-10-09T10:00:00Z", TANKS[1]);
  assert.equal(card.title, "Record this diesel draw?");
  const facts = Object.fromEntries(card.facts.map((fact) => [fact.label, fact.value]));
  assert.equal(facts.Machine, "White bakkie");
  assert.equal(facts.Litres, "80 L");
  assert.equal(facts.Tank, "Shed tank");
  assert.match(facts["Meter reading"], /52/);
  assert.equal(proposalFor("p", draft, bakkie, "af-ZA", "2026-10-09T10:00:00Z", TANKS[1]).title, "Teken hierdie dieseltrekking aan?");
});

test("litres and the tank can be answered aloud", () => {
  assert.equal(clarificationFromSpeech("i", { name: "litres", type: "number", label: "How many litres?" }, "eighty litres")?.litres, 80);
  assert.equal(clarificationFromSpeech("i", { name: "litres", type: "number", label: "Hoeveel liter?" }, "sewentig")?.litres, 70);
  const field = { name: "tankId" as const, type: "select" as const, label: "Which tank?", options: TANKS.map((t) => ({ value: t.id, label: t.name })) };
  assert.equal(clarificationFromSpeech("i", field, "the shed tank")?.tankId, TANKS[1].id);
  assert.equal(clarificationFromSpeech("i", field, "the tank"), null, "two tanks match: ask again");
});
