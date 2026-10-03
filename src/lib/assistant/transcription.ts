import type { AssistantMachine } from "./types";

/**
 * The AI transcription pass: the recording, plus the farm's own machine names as
 * vocabulary, sent to speech models through the Vercel AI Gateway, for people who
 * allowed it. Measured on 90 recordings of mixed Afrikaans/English farm requests
 * (2026-10-03, scored with the app's own matcher):
 *
 *   Azure as configured before, with the old matcher ................... 43%
 *   the same, with the improved matcher and parser ...................... 54%
 *   MAI-Transcribe-2 with the farm's names as a phrase list ............ 96%
 *   gpt-4o-transcribe with the names in its prompt ..................... 96%
 *   both, each hearing weighed against the other ....................... 99%, none wrong
 *
 * Azure stays the live recogniser for everyone; this only adds hearings.
 */

/** Consent covering the recording and machine names. `voice-ai-v1` covered transcript text only. */
export const AUDIO_CONSENT_VERSION = "voice-ai-v2";

type ConsentProfile = {
  ai_processing_opt_in: boolean | null;
  ai_processing_consent_version: string | null;
  ai_processing_withdrawn_at?: string | null;
};

export function allowsAudioTranscription(profile: ConsentProfile): boolean {
  return Boolean(
    profile.ai_processing_opt_in &&
      !profile.ai_processing_withdrawn_at &&
      profile.ai_processing_consent_version === AUDIO_CONSENT_VERSION,
  );
}

/** The two that measured best, in the order their hearings are tried: MAI first, for its numbers. */
const DEFAULT_MODELS = ["microsoft/mai-transcribe-2", "openai/gpt-4o-transcribe"];

/** `ASSISTANT_TRANSCRIBE_MODELS` (comma separated gateway ids) swaps models without a deploy. */
export function configuredTranscribeModels(raw = process.env.ASSISTANT_TRANSCRIBE_MODELS): string[] {
  const models = (raw ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter((model) => /^[a-z0-9-]+\/[a-z0-9.-]+$/i.test(model));
  return (models.length ? models : DEFAULT_MODELS).slice(0, 3);
}

/** Words people say about machines in both languages, so a model keeps them as said. */
const GLOSSARY = [
  "bakkie", "trekker", "stroper", "sleepwa", "spuitwa", "sproeier", "trok", "vragmotor",
  "ure", "uur", "kilometer", "diens", "band", "olie", "remme", "ratkas", "stukkend", "lek", "pap",
];

/**
 * The farm's vocabulary, most identifying first: names and aliases, then makes and
 * models, then the glossary. Models do best with a short list (Gemini documents 100 or
 * fewer), so a large fleet keeps its names and drops the generic words.
 */
export function transcriptionVocabulary(machines: readonly AssistantMachine[], limit = 100): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const add = (value: string | null | undefined) => {
    const term = value?.trim().replace(/\s+/g, " ");
    if (!term || term.length > 60) return;
    const key = term.toLocaleLowerCase("en-ZA");
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(term);
  };
  for (const machine of machines) {
    add(machine.name);
    machine.aliases.forEach(add);
  }
  for (const machine of machines) {
    add(machine.make);
    add(machine.model);
  }
  GLOSSARY.forEach(add);
  return terms.slice(0, limit);
}

/**
 * Each provider takes vocabulary differently; these shapes are the ones the gateway
 * was seen to forward (a wrong key is accepted and silently ignored, or refused).
 */
type OptionValue = string | boolean | string[] | { [key: string]: string[] };
export type TranscribeOptions = Record<string, Record<string, OptionValue>>;

export function transcribeOptionsFor(model: string, terms: readonly string[], zeroDataRetention: boolean): TranscribeOptions {
  const options: TranscribeOptions = {};
  // Vercel only routes zero-data-retention requests on Pro and Enterprise plans; on
  // Hobby the request is refused outright, so it is opt-in (ASSISTANT_TRANSCRIBE_ZDR=1).
  if (zeroDataRetention) options.gateway = { zeroDataRetention: true };
  if (model.startsWith("microsoft/")) options.azure = { phraseList: { phrases: [...terms] } };
  else if (model.startsWith("google/")) options.google = { mode: "VERBATIM", customVocabulary: [...terms] };
  else if (model.startsWith("openai/")) {
    // A prompt reads as text the speaker might have said before, so it is phrased as
    // context, and short: whisper-family prompts are cut at about 224 tokens.
    const names = terms.join(", ").slice(0, 700);
    options.openai = { prompt: `South African farm voice note, English and Afrikaans mixed. Machine names and words: ${names}.` };
  }
  return options;
}
