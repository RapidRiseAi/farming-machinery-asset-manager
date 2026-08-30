import type { AssistantLocale, AssistantMachine } from "./types";

export type AssistantSpeechVoice = "willem" | "ollie";

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
 * Azure language identification works best with a short candidate list. The
 * selected locale is first (the likely language), while both South African
 * locales remain available for bilingual/code-switched commands.
 */
export function recognitionLocales(preferred: AssistantLocale): AssistantLocale[] {
  return preferred === "af-ZA" ? ["af-ZA", "en-ZA"] : ["en-ZA", "af-ZA"];
}

/** Farm names and bilingual domain terms are recognition hints, never stored-data replacements. */
export function speechVocabulary(machines: readonly AssistantMachine[]): string[] {
  const seen = new Set<string>();
  const phrases: string[] = [];
  // Reserve the front of Azure's 500-phrase allowance for the small bilingual
  // operations vocabulary so a large fleet cannot push these terms out.
  for (const phrase of BILINGUAL_DOMAIN_PHRASES) {
    const key = phrase.toLocaleLowerCase("en-ZA");
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
