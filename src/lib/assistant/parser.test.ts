import assert from "node:assert/strict";
import test from "node:test";
import { matchMachine, normalizeAssistantText } from "./normalize";
import { parseDeterministic } from "./parser";
import { todayInSouthAfrica } from "./date";
import type { AssistantMachine } from "./types";

const machines: AssistantMachine[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "John Deere 6155R",
    make: "John Deere",
    model: "6155R",
    aliases: ["Big John"],
    status: "active",
    meterType: "hours",
    currentReading: 4300,
    currentReadingDate: "2026-08-01",
    serviceStatus: "due_soon",
    nextDueDate: null,
    nextDueReading: 4500,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Massey Ferguson 7618",
    make: "Massey Ferguson",
    model: "7618",
    aliases: ["Red tractor"],
    status: "active",
    meterType: "hours",
    currentReading: 4200,
    currentReadingDate: "2026-08-02",
    serviceStatus: "ok",
    nextDueDate: "2026-11-01",
    nextDueReading: 4450,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Mercedes-Benz Actros 2645",
    make: "Mercedes-Benz",
    model: "Actros 2645",
    aliases: ["Mercedes trok", "Blou trok", "Merc truck"],
    status: "active",
    meterType: "kilometres",
    currentReading: 120000,
    currentReadingDate: "2026-08-03",
    serviceStatus: "ok",
    nextDueDate: "2026-12-01",
    nextDueReading: 130000,
  },
];

test("normalizes observed Afrikaans John Deere transcription variants", () => {
  assert.equal(normalizeAssistantText("Djon Deer"), "john deere");
  assert.equal(normalizeAssistantText("jong deur"), "john deere");
  assert.equal(normalizeAssistantText("John Deer"), "john deere");
});

test("normalizes the observed English Massey transcription", () => {
  assert.equal(normalizeAssistantText("Macy Ferguson"), "massey ferguson");
});

test("normalizes common English-model Mercedes phonetic variants", () => {
  assert.equal(normalizeAssistantText("Mersadies trok"), "mercedes benz trok");
  assert.equal(normalizeAssistantText("mer say this truck"), "mercedes benz truck");
  assert.equal(normalizeAssistantText("verkeerdes trok"), "mercedes benz trok");
  assert.equal(normalizeAssistantText("merkie dis trok"), "mercedes benz trok");
});

test("matches canonical farm assets without changing their stored name", () => {
  const john = matchMachine("Ek het 'n probleem op die Djon Deer gevind", machines);
  assert.equal(john.machine?.name, "John Deere 6155R");
  const massey = matchMachine("Log engine hours for the Macy Ferguson", machines);
  assert.equal(massey.machine?.name, "Massey Ferguson 7618");
});

test("parses an Afrikaans fault deterministically", () => {
  const parsed = parseDeterministic("Ek het ’n hidrouliese probleem op die Djon Deer gevind.", "af-ZA");
  assert.equal(parsed.intent, "report_fault");
  assert.equal(parsed.category, "hydraulics");
  assert.equal(parsed.urgency, null);
});

test("treats a generic English fault request as intent rather than description", () => {
  const parsed = parseDeterministic("I want to report a problem", "en-ZA");
  assert.equal(parsed.intent, "report_fault");
  assert.equal(parsed.description, null);
  assert.equal(parsed.urgency, null);
});

test("treats a generic Afrikaans fault request as intent rather than description", () => {
  const parsed = parseDeterministic("Ek wil ’n probleem rapporteer", "af-ZA");
  assert.equal(parsed.intent, "report_fault");
  assert.equal(parsed.description, null);
});

test("preserves a real mixed-language fault and resolves its English brand", () => {
  const input = "Rapporteer ’n gebreekte venster op die Mercedes trok";
  const parsed = parseDeterministic(input, "af-ZA");
  const match = matchMachine(parsed.machineQuery ?? input, machines);
  assert.equal(parsed.intent, "report_fault");
  assert.match(parsed.description ?? "", /gebreekte venster/i);
  assert.equal(match.machine?.name, "Mercedes-Benz Actros 2645");
});

test("resolves an Afrikaans alias inside an English fault", () => {
  const input = "Report a broken window on die blou trok";
  const parsed = parseDeterministic(input, "en-ZA");
  const match = matchMachine(parsed.machineQuery ?? input, machines);
  assert.equal(parsed.intent, "report_fault");
  assert.match(parsed.description ?? "", /broken window/i);
  assert.equal(match.machine?.name, "Mercedes-Benz Actros 2645");
});

test("keeps English fault words when the selected response language is Afrikaans", () => {
  const input = "Rapporteer 'n broken window op die Mercedes trok";
  const parsed = parseDeterministic(input, "af-ZA");
  assert.equal(parsed.intent, "report_fault");
  assert.match(parsed.description ?? "", /broken window/i);
});

test("recovers the Mercedes machine from the observed Afrikaans recognizer output", () => {
  const input = "Rapporteer 'n gebreekte venster op die verkeerdes trok";
  const parsed = parseDeterministic(input, "af-ZA");
  const match = matchMachine(parsed.machineQuery ?? input, machines);
  assert.equal(match.machine?.name, "Mercedes-Benz Actros 2645");
});

test("keeps Afrikaans fault words when the selected response language is English", () => {
  const input = "Report 'n gebreekte venster on the Mercedes truck";
  const parsed = parseDeterministic(input, "en-ZA");
  assert.equal(parsed.intent, "report_fault");
  assert.match(parsed.description ?? "", /gebreekte venster/i);
});

test("parses a mixed-language service question", () => {
  const parsed = parseDeterministic("Wat is the service status van die John Deere?", "af-ZA");
  assert.equal(parsed.intent, "query_service_due");
});

test("parses a South African English reading and thousands separator", () => {
  const parsed = parseDeterministic("Log 4,323 engine hours for the Macy Ferguson.", "en-ZA");
  assert.equal(parsed.intent, "log_reading");
  assert.equal(parsed.reading, 4323);
});

test("uses the unit-adjacent meter value instead of a numeric machine model", () => {
  const reading = parseDeterministic("Log 120,000 km for the Mercedes Actros 2645.", "en-ZA");
  assert.equal(reading.intent, "log_reading");
  assert.equal(reading.reading, 120000);

  const service = parseDeterministic("Service on the Actros 2645 completed at 125,000 km.", "en-ZA");
  assert.equal(service.intent, "log_service");
  assert.equal(service.reading, 125000);
});

test("asks for a reading instead of treating a numeric model as the meter", () => {
  const parsed = parseDeterministic("The service on the Actros 2645 is completed.", "en-ZA");
  assert.equal(parsed.intent, "log_service");
  assert.equal(parsed.reading, null);

  const reading = parseDeterministic("Log Actros 2645 reading", "en-ZA");
  assert.equal(reading.intent, "log_reading");
  assert.equal(reading.reading, null);

  const explicit = parseDeterministic("Log 4323 reading for the Actros 2645", "en-ZA");
  assert.equal(explicit.reading, 4323);
});

test("parses a completed Afrikaans service using the final meter number", () => {
  const parsed = parseDeterministic("Die 250-uur diens op die John Deere is klaar by 4 500 ure.", "af-ZA");
  assert.equal(parsed.intent, "log_service");
  assert.equal(parsed.reading, 4500);
});

test("distinguishes a service-due question from a completed service", () => {
  const parsed = parseDeterministic("Wanneer is die John Deere se volgende diens?", "af-ZA");
  assert.equal(parsed.intent, "query_service_due");
});

test("treats current-reading questions as reads even when a model number is present", () => {
  const parsed = parseDeterministic("Show the current reading on the Actros 2645", "en-ZA");
  assert.equal(parsed.intent, "query_asset_status");
  assert.equal(parsed.reading, null);
});

test("never turns a completed-service history question into a service write", () => {
  const parsed = parseDeterministic("What service was completed on the Mercedes?", "en-ZA");
  assert.equal(parsed.intent, null);
  assert.equal(parsed.reading, null);
});

test("uses the South African calendar date around UTC midnight", () => {
  assert.equal(todayInSouthAfrica(new Date("2026-08-13T22:30:00.000Z")), "2026-08-14");
});
