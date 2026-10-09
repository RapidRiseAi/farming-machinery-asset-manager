import type { AssistantLocale, AssistantMachine } from "./types";
import { shortSpokenForms } from "./spoken-forms";

export type AssistantSpeechVoice = "willem" | "ollie";

/**
 * Afrikaans words people drop into an English sentence ("the rooi bakkie's tyre"),
 * and their English counterparts. The phrase list only applies to the English model,
 * which is exactly the model that mishears them, so these are its warning.
 */
const CODE_SWITCH_WORDS = [
  "bakkie",
  "bakkies",
  "trekker",
  "trekkers",
  "stroper",
  "vragmotor",
  "trok",
  "sleepwa",
  "sproeier",
  "voorlaaier",
  "rooi",
  "wit",
  "groen",
  "blou",
  "swart",
  "geel",
  "grys",
  "band",
  "bande",
  "olie",
  "remme",
  "koppelaar",
  "ratkas",
  "stukkend",
  "werkswinkel",
  "plaas",
] as const;

const BILINGUAL_DOMAIN_PHRASES = [
  "broken window",
  "gebreekte venster",
  "hydraulic leak",
  "hidrouliese lek",
  "engine hours",
  "enjinure",
  "service due",
  "diens verskuldig",
  "fault report",
  "foutverslag",
  "job card",
  "werkkaart",
  "work request",
  "werkversoek",
  "quote request",
  "kwotasieversoek",
  "invoice",
  "faktuur",
] as const;

export function voiceForLocale(locale: AssistantLocale): AssistantSpeechVoice {
  return locale === "af-ZA" ? "willem" : "ollie";
}

/**
 * The languages the live recogniser may hear in.
 *
 * English: English only. It used to identify the language continuously between en-ZA and
 * af-ZA, and Azure does not weigh the candidates' order: South African English was
 * regularly identified as Afrikaans, the live transcript came out in the wrong language,
 * and the turn waited for the AI hearing to put it right (reported 2026-10-09). One fixed
 * language is also billed at Azure's base rate and finalises sooner. Afrikaans words
 * dropped into English ("the rooi bakkie") are what the English phrase list is for, and a
 * hard turn is still re-heard in Afrikaans by the second pass.
 *
 * Afrikaans: both, as before. Afrikaans speakers switch into English mid-sentence far more
 * than the other way round, and the runtime phrase list (the farm's machine names) only
 * applies through the en-ZA model (speech-client.ts), so a fixed af-ZA recogniser would
 * lose the names.
 */
export function recognitionLocales(preferred: AssistantLocale): AssistantLocale[] {
  return preferred === "af-ZA" ? ["af-ZA", "en-ZA"] : ["en-ZA"];
}

/** Farm names and bilingual domain terms are recognition hints, never stored-data replacements. */
export function speechVocabulary(machines: readonly AssistantMachine[]): string[] {
  const seen = new Set<string>();
  const phrases: string[] = [];
  // Reserve the front of Azure's 500-phrase allowance for the small bilingual
  // operations vocabulary so a large fleet cannot push these terms out.
  for (const phrase of [...BILINGUAL_DOMAIN_PHRASES, ...CODE_SWITCH_WORDS]) {
    const key = phrase.toLocaleLowerCase("en-ZA");
    if (seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
  }
  for (const machine of machines) {
    const candidates = [
      machine.name,
      machine.make,
      machine.model,
      machine.make && machine.model ? `${machine.make} ${machine.model}` : null,
      ...machine.aliases,
      // The way people actually say it: "rooi bakkie", "red bakkie".
      ...shortSpokenForms(machine.name),
      ...machine.aliases.flatMap(shortSpokenForms),
    ];
    for (const candidate of candidates) {
      const value = candidate?.trim().replace(/\s+/g, " ");
      if (!value) continue;
      const key = value.toLocaleLowerCase("en-ZA");
      if (seen.has(key)) continue;
      seen.add(key);
      phrases.push(value);
    }
  }
  return phrases;
}
