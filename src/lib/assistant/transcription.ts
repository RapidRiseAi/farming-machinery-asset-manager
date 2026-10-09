import type { AssistantLocale, AssistantMachine } from "./types";

/**
 * The AI transcription pass: the recording, plus the farm's own machine names as
 * vocabulary, sent to speech models through the Vercel AI Gateway. Measured on 90
 * recordings of mixed Afrikaans/English farm requests (2026-10-03, scored with the app's
 * own matcher, every clip heard by AI):
 *
 *   Azure as configured before, with the old matcher ................... 43%
 *   the same, with the improved matcher and parser ...................... 54%
 *   MAI-Transcribe-2 with the farm's names as a phrase list ............ 96%
 *   gpt-4o-transcribe with the names in its prompt ..................... 96%
 *   both, each hearing weighed against the other ....................... 99%, none wrong
 *
 * Replayed end to end the way the app runs (only hard turns get an AI hearing, fused with
 * the two Azure hearings), one gpt-4o hearing scored the same as both models together:
 * 96%, none wrong, at half the calls. So one model is used, and MAI only when it fails
 * (docs/AI_USAGE.md). Azure stays the live recogniser for everyone.
 */

type AiHelpProfile = {
  ai_processing_opt_in: boolean | null;
  ai_processing_withdrawn_at?: string | null;
  ai_notice_seen_at?: string | null;
};

/**
 * AI help is on for this person: they have seen the notice (POPIA s18: told before
 * anything leaves the country), it is on, and they have not switched it off. Any consent
 * version counts; the notice is what covers the recording. The database's hold applies
 * the same rule again, and the farm's own switch and limits, on every call.
 */
export function aiHelpOn(profile: AiHelpProfile): boolean {
  return Boolean(profile.ai_notice_seen_at && profile.ai_processing_opt_in && !profile.ai_processing_withdrawn_at);
}

/** The hearing first, then its fallback when the first fails or is slow. */
const DEFAULT_MODELS = ["openai/gpt-4o-transcribe", "microsoft/mai-transcribe-2"];

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
export type TranscribeOptions = Record<string, Record<string, unknown>>;

/**
 * The prompt an OpenAI transcriber is given. It reads as text the speaker might have said
 * before, so it is phrased as context, and short: whisper-family prompts are cut at about
 * 224 tokens. Its length also sizes the hearing's budget hold (ai-usage/hold-units.ts).
 *
 * Written in the language the person chose to speak, because these models continue in
 * the prompt's language: "English and Afrikaans mixed" invited an Afrikaans transcript of
 * English speech (2026-10-09). Without a locale (an older app) it stays bilingual.
 */
export function openAiTranscribePrompt(terms: readonly string[], locale?: AssistantLocale): string {
  const names = terms.join(", ").slice(0, 700);
  if (locale === "en-ZA") {
    return `A South African farmer speaking English, with some Afrikaans machine words. Machine names and words: ${names}.`;
  }
  if (locale === "af-ZA") {
    return `'n Suid-Afrikaanse boer wat Afrikaans praat, met party Engelse woorde. Masjienname en woorde: ${names}.`;
  }
  return `South African farm voice note, English and Afrikaans mixed. Machine names and words: ${names}.`;
}

/** ISO 639-1, as OpenAI's transcription `language` takes it. */
export function transcriptionLanguage(locale: AssistantLocale | undefined): "en" | "af" | undefined {
  return locale === "en-ZA" ? "en" : locale === "af-ZA" ? "af" : undefined;
}

/**
 * `gateway`: the options every call on the platform's credential carries
 * (ai-usage/gateway-options.ts): the tags the monthly reconciliation groups by, and zero
 * data retention when ASSISTANT_TRANSCRIBE_ZDR=1 (Vercel refuses it on Hobby). A call on a
 * farm's own OpenAI key goes to OpenAI directly and passes none.
 */
export function transcribeOptionsFor(
  model: string,
  terms: readonly string[],
  gateway: Record<string, unknown> = {},
  locale?: AssistantLocale,
): TranscribeOptions {
  const options: TranscribeOptions = {};
  if (Object.keys(gateway).length) options.gateway = { ...gateway };
  if (model.startsWith("microsoft/")) options.azure = { phraseList: { phrases: [...terms] } };
  else if (model.startsWith("google/")) options.google = { mode: "VERBATIM", customVocabulary: [...terms] };
  else if (model.startsWith("openai/")) {
    // The chosen language as well as the prompt: an English speaker is transcribed in
    // English, however South African the accent.
    const language = transcriptionLanguage(locale);
    options.openai = { prompt: openAiTranscribePrompt(terms, locale), ...(language ? { language } : {}) };
  }
  return options;
}
