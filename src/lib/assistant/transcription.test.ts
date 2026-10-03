import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIO_CONSENT_VERSION,
  allowsAudioTranscription,
  configuredTranscribeModels,
  transcribeOptionsFor,
  transcriptionVocabulary,
} from "./transcription";
import type { AssistantMachine } from "./types";

function machine(name: string, extra: Partial<AssistantMachine> = {}): AssistantMachine {
  return {
    id: `id-${name}`, name, make: null, model: null, aliases: [], status: "active", meterType: "hours",
    currentReading: null, currentReadingDate: null, serviceStatus: null, nextDueDate: null, nextDueReading: null,
    ...extra,
  };
}

test("only active audio consent (v2) lets the recording leave Azure", () => {
  assert.equal(allowsAudioTranscription({ ai_processing_opt_in: true, ai_processing_consent_version: AUDIO_CONSENT_VERSION }), true);
  assert.equal(allowsAudioTranscription({ ai_processing_opt_in: true, ai_processing_consent_version: "voice-ai-v1" }), false);
  assert.equal(allowsAudioTranscription({ ai_processing_opt_in: false, ai_processing_consent_version: AUDIO_CONSENT_VERSION }), false);
  assert.equal(
    allowsAudioTranscription({ ai_processing_opt_in: true, ai_processing_consent_version: AUDIO_CONSENT_VERSION, ai_processing_withdrawn_at: "2026-10-03T10:00:00Z" }),
    false,
  );
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

test("each provider gets vocabulary in the shape the gateway forwards", () => {
  const terms = ["Ou Blou", "Rooi Bakkie"];
  assert.deepEqual(transcribeOptionsFor("microsoft/mai-transcribe-2", terms, false), { azure: { phraseList: { phrases: terms } } });
  assert.deepEqual(transcribeOptionsFor("google/gemini-3.5-transcribe", terms, false), { google: { mode: "VERBATIM", customVocabulary: terms } });
  const openai = transcribeOptionsFor("openai/gpt-4o-transcribe", terms, false);
  assert.match(String(openai.openai.prompt), /Ou Blou, Rooi Bakkie/);
  assert.deepEqual(transcribeOptionsFor("microsoft/mai-transcribe-2", terms, true).gateway, { zeroDataRetention: true });
  assert.equal(transcribeOptionsFor("openai/gpt-4o-transcribe", terms, false).gateway, undefined);
});

test("models come from the environment when valid, else the measured pair", () => {
  assert.deepEqual(configuredTranscribeModels(undefined), ["microsoft/mai-transcribe-2", "openai/gpt-4o-transcribe"]);
  assert.deepEqual(configuredTranscribeModels(" google/gemini-3.5-transcribe , nonsense "), ["google/gemini-3.5-transcribe"]);
  assert.equal(configuredTranscribeModels("a/1,b/2,c/3,d/4").length, 3);
});
