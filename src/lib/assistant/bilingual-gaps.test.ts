import assert from "node:assert/strict";
import test from "node:test";
import { replaceNumberWords } from "./numbers";
import { parseDeterministic } from "./parser";
import { answerLocalRead, parseLocalReadRequest } from "./local-read";
import type { AssistantMachine } from "./types";
import { clarificationFromSpeech } from "./spoken-clarification";
import type { AssistantField } from "./types";

// Each case failed even with a PERFECT transcript, found by probing mixed
// Afrikaans/English requests (2026-10-03). A miss sent a plain request to the
// optional AI path: a consent prompt, or a cross-border call it did not need.

const en = (text: string) => parseDeterministic(text, "en-ZA");
const af = (text: string) => parseDeterministic(text, "af-ZA");

test("symptoms in either language are fault reports", () => {
  assert.equal(en("Bles has a flat tyre and can't work.").intent, "report_fault");
  assert.equal(af("Bles se band is pap.").intent, "report_fault");
  assert.equal(af("Bles se band is stukkend.").intent, "report_fault");
  assert.equal(af("Old Faithful se battery is pap.").intent, "report_fault");
  assert.equal(en("Die rooi bakkie se check engine light is on.").intent, "report_fault");
});

test("'check engine light' inside an Afrikaans report is not a request to list faults", () => {
  assert.equal(parseLocalReadRequest("Die rooi bakkie se enjin het 'n probleem, die check engine light is aan."), null);
  assert.equal(af("Die rooi bakkie se enjin het 'n probleem, die check engine light is aan.").intent, "report_fault");
  // "check" leading a request still asks for a read.
  assert.notEqual(parseLocalReadRequest("Check the open faults on Ou Blou"), null);
});

test("'serviced' reports a finished service, and a question about it stays a read", () => {
  const done = en("We serviced the spuitwa today at 1210 hours.");
  assert.equal(done.intent, "log_service");
  assert.equal(done.reading, 1210);
  assert.equal(en("When was Witkop last serviced?").intent, null);
});

test("a service interval is not the meter reading", () => {
  const draft = en("The 500 hour service on Ou Blou is done at 4500 hours.");
  assert.equal(draft.intent, "log_service");
  assert.equal(draft.reading, 4500);
  assert.equal(en("The 250-hour service on Ou Blou is done.").reading, null);
  const afrikaans = af("Swartkat se 500 uur diens is klaar.");
  assert.equal(afrikaans.intent, "log_service");
  assert.equal(afrikaans.reading, null);
});

test("'uur' is an hours unit", () => {
  const draft = af("Teken 1 uur aan op Swartkat.");
  assert.equal(draft.intent, "log_reading");
  assert.equal(draft.reading, 1);
});

test("a reading said after the name, after a comma, is kept; a model number is not", () => {
  const draft = en("Log the hours for die groot trekker, 5320.");
  assert.equal(draft.intent, "log_reading");
  assert.equal(draft.reading, 5320);
  assert.equal(en("Log the hours on the Massey 290").reading, null);
});

test("spoken numbers become digits in both languages, ordinary words do not", () => {
  assert.equal(replaceNumberWords("four thousand three hundred hours"), "4300 hours");
  assert.equal(replaceNumberWords("nineteen hundred"), "1900");
  assert.equal(replaceNumberWords("three thousand four hundred and fifty"), "3450");
  assert.equal(replaceNumberWords("one hundred and twenty five thousand km"), "125000 km");
  assert.equal(replaceNumberWords("drie duisend vier honderd en vyftig ure"), "3450 ure");
  assert.equal(replaceNumberWords("vyf-en-twintig"), "25");
  assert.equal(replaceNumberWords("twaalfhonderd"), "1200");
  assert.equal(replaceNumberWords("one two five zero zero zero"), "125000");
  assert.equal(replaceNumberWords("the one with the flat tyre"), "the one with the flat tyre");
  assert.equal(replaceNumberWords("een van die trekkers"), "een van die trekkers");
  assert.equal(replaceNumberWords("bles and ou blou"), "bles and ou blou");
  assert.equal(en("Log four thousand three hundred hours on Ou Blou.").reading, 4300);
  assert.equal(af("Teken drie duisend vier honderd en vyftig ure aan op die ou Massey.").reading, 3450);
});

test("the symptom after 'problem with X,' is kept as the description", () => {
  assert.equal(en("Report a problem with Bles, it has a flat tyre.").description, "it has a flat tyre");
  assert.equal(en("Report a problem on Oom Piet se trok, the brakes are making a noise.").description, "the brakes are making a noise");
  assert.equal(en("Report a fault on the groot trekker, die hidrouliese pyp lek.").description, "die hidrouliese pyp lek");
  // With nothing after the machine reference there is still no description to save.
  assert.equal(en("Report a problem on the Mercedes truck.").description, null);
});

test("an unrecognised name in an Afrikaans possessive is not answered for the whole fleet", async () => {
  const machine = (id: string, name: string, serviceStatus: AssistantMachine["serviceStatus"]): AssistantMachine => ({
    id, name, make: "Toyota", model: "Land Cruiser", aliases: [], status: "active", meterType: "km",
    currentReading: 10000, currentReadingDate: "2026-09-01", serviceStatus, nextDueDate: null, nextDueReading: 15000,
  });
  const neverQuery = new Proxy({}, { get() { throw new Error("service attention must not query the database"); } });
  const scope = {
    supabase: neverQuery, farmId: "farm", role: "owner" as const,
    machines: [machine("11111111-1111-4111-8111-111111111111", "Klein Stroper", "due_soon"), machine("22222222-2222-4222-8222-222222222222", "Witkop", "overdue")],
  } as never;
  const request = parseLocalReadRequest("Wanneer is die hai luks se volgende diens?");
  assert.ok(request, "it is a local read");
  const answer = await answerLocalRead(request!, scope, "af-ZA");
  assert.doesNotMatch(answer.message, /Klein Stroper|Witkop/, "no fleet-wide answer for an unknown machine");
});

const readingField: AssistantField = { name: "reading", type: "number", label: "Reading", min: 0, step: 1 } as AssistantField;
const urgencyField = { name: "urgency", type: "select", label: "Urgency", options: [] } as unknown as AssistantField;

test("spoken answers: number words and natural yes/no to 'can it still work?'", () => {
  assert.equal(clarificationFromSpeech("i", readingField, "Three thousand four hundred and fifty.")?.reading, 3450);
  assert.equal(clarificationFromSpeech("i", readingField, "drie duisend vier honderd en vyftig")?.reading, 3450);
  assert.equal(clarificationFromSpeech("i", readingField, "1900.")?.reading, 1900);
  assert.equal(clarificationFromSpeech("i", urgencyField, "Yeah.")?.urgency, "can_work");
  assert.equal(clarificationFromSpeech("i", urgencyField, "Nee, dit staan.")?.urgency, "stopped");
  assert.equal(clarificationFromSpeech("i", urgencyField, "No.")?.urgency, "stopped");
  assert.equal(clarificationFromSpeech("i", urgencyField, "Ja, dit kan nog werk.")?.urgency, "can_work");
});
