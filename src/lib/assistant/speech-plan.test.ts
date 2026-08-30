import assert from "node:assert/strict";
import test from "node:test";
import { recognitionLocales, speechVocabulary, voiceForLocale } from "./speech-plan";
import type { AssistantMachine } from "./types";

const mercedes: AssistantMachine = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Mercedes-Benz Actros 2645",
  make: "Mercedes-Benz",
  model: "Actros 2645",
  aliases: ["Mercedes trok", "Blou trok", "Merc truck"],
  status: "active",
  meterType: "kilometres",
  currentReading: 1000,
  currentReadingDate: "2026-08-01",
  serviceStatus: "ok",
  nextDueDate: null,
  nextDueReading: 2000,
};

test("uses Willem for Afrikaans and Ollie for English", () => {
  assert.equal(voiceForLocale("af-ZA"), "willem");
  assert.equal(voiceForLocale("en-ZA"), "ollie");
});

test("always offers both recognition locales with the preference first", () => {
  assert.deepEqual(recognitionLocales("af-ZA"), ["af-ZA", "en-ZA"]);
  assert.deepEqual(recognitionLocales("en-ZA"), ["en-ZA", "af-ZA"]);
});

test("builds entity vocabulary from name, make, model and aliases", () => {
  const vocabulary = speechVocabulary([mercedes]);
  assert.deepEqual(vocabulary.slice(0, 4), [
    "broken window",
    "gebreekte venster",
    "hydraulic leak",
    "hidrouliese lek",
  ]);
  assert.ok(vocabulary.includes("Mercedes-Benz Actros 2645"));
  assert.ok(vocabulary.includes("Mercedes trok"));
  assert.ok(vocabulary.includes("Blou trok"));
  assert.ok(vocabulary.includes("Merc truck"));
  assert.ok(vocabulary.includes("broken window"));
  assert.ok(vocabulary.includes("gebreekte venster"));
  assert.ok(vocabulary.includes("work request"));
  assert.ok(vocabulary.includes("werkversoek"));
});
