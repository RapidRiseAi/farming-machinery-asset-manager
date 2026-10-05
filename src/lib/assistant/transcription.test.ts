import assert from "node:assert/strict";
import test from "node:test";
import { aiHelpOn, configuredTranscribeModels, openAiTranscribePrompt, transcribeOptionsFor, transcriptionVocabulary } from "./transcription";
import type { AssistantMachine } from "./types";

function machine(name: string, extra: Partial<AssistantMachine> = {}): AssistantMachine {
  return {
    id: `id-${name}`, name, make: null, model: null, aliases: [], status: "active", meterType: "hours",
    currentReading: null, currentReadingDate: null, serviceStatus: null, nextDueDate: null, nextDueReading: null,
    ...extra,
  };
}

test("AI help needs the notice seen, AI on, and no withdrawal; any consent version counts", () => {
  const seen = "2026-10-04T08:00:00Z";
  assert.equal(aiHelpOn({ ai_processing_opt_in: true, ai_notice_seen_at: seen }), true);
  assert.equal(aiHelpOn({ ai_processing_opt_in: true, ai_notice_seen_at: null }), false, "never told");
  assert.equal(aiHelpOn({ ai_processing_opt_in: false, ai_notice_seen_at: seen }), false, "switched off");
  assert.equal(aiHelpOn({ ai_processing_opt_in: true, ai_notice_seen_at: seen, ai_processing_withdrawn_at: seen }), false);
});

test("vocabulary puts names and aliases first, then makes and models, then the glossary", () => {
  const terms = transcriptionVocabulary([
    machine("Ou Blou", { make: "John Deere", model: "6120M", aliases: ["Blou Trekker"] }),
    machine("Rooi Bakkie", { make: "Toyota", model: "Hilux" }),
    machine("Hilux 2", { make: "Toyota", model: "Hilux" }),
  ]);
  assert.deepEqual(terms.slice(0, 4), ["Ou Blou", "Blou Trekker", "Rooi Bakkie", "Hilux 2"]);
  assert.ok(terms.indexOf("John Deere") > terms.indexOf("Hilux 2"));
  assert.equal(terms.filter((term) => term === "Toyota").length, 1, "duplicates are dropped");
  assert.ok(terms.includes("bakkie"));
});

test("a large fleet keeps its names and drops the generic words", () => {
  const fleet = Array.from({ length: 150 }, (_, i) => machine(`Trekker ${i}`));
  const terms = transcriptionVocabulary(fleet);
  assert.equal(terms.length, 100);
  assert.ok(terms.every((term) => term.startsWith("Trekker ")));
});

test("each provider gets vocabulary in the shape the gateway forwards, plus the call's gateway options", () => {
  const terms = ["Ou Blou", "Rooi Bakkie"];
  assert.deepEqual(transcribeOptionsFor("microsoft/mai-transcribe-2", terms), { azure: { phraseList: { phrases: terms } } });
  assert.deepEqual(transcribeOptionsFor("google/gemini-3.5-transcribe", terms), { google: { mode: "VERBATIM", customVocabulary: terms } });
  const openai = transcribeOptionsFor("openai/gpt-4o-transcribe", terms);
  assert.match(String(openai.openai.prompt), /Ou Blou, Rooi Bakkie/);
  assert.equal(openai.openai.prompt, openAiTranscribePrompt(terms));
  const gateway = { tags: ["farm:f1", "feature:ai_hearing"], user: "platform:ai_hearing" };
  assert.deepEqual(transcribeOptionsFor("openai/gpt-4o-transcribe", terms, gateway).gateway, gateway);
  assert.equal(transcribeOptionsFor("openai/gpt-4o-transcribe", terms, {}).gateway, undefined);
});

test("models come from the environment when valid, else gpt-4o with MAI as its fallback", () => {
  assert.deepEqual(configuredTranscribeModels(undefined), ["openai/gpt-4o-transcribe", "microsoft/mai-transcribe-2"]);
  assert.deepEqual(configuredTranscribeModels(" google/gemini-3.5-transcribe , nonsense "), ["google/gemini-3.5-transcribe"]);
  assert.equal(configuredTranscribeModels("a/1,b/2,c/3,d/4").length, 3);
});
