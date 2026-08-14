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
];

test("normalizes observed Afrikaans John Deere transcription variants", () => {
  assert.equal(normalizeAssistantText("Djon Deer"), "john deere");
  assert.equal(normalizeAssistantText("jong deur"), "john deere");
  assert.equal(normalizeAssistantText("John Deer"), "john deere");
});

test("normalizes the observed English Massey transcription", () => {
  assert.equal(normalizeAssistantText("Macy Ferguson"), "massey ferguson");
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
  assert.equal(parsed.urgency, "can_work");
});

test("parses a South African English reading and thousands separator", () => {
  const parsed = parseDeterministic("Log 4,323 engine hours for the Macy Ferguson.", "en-ZA");
  assert.equal(parsed.intent, "log_reading");
  assert.equal(parsed.reading, 4323);
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

test("uses the South African calendar date around UTC midnight", () => {
  assert.equal(todayInSouthAfrica(new Date("2026-08-13T22:30:00.000Z")), "2026-08-14");
});
