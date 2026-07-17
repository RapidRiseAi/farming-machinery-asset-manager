import en from "./en.json";
import af from "./af.json";

export const locales = ["en", "af"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

const dictionaries: Record<Locale, unknown> = { en, af };

function lookup(dict: unknown, parts: string[]): string | undefined {
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

/**
 * Translate a dot-path key (e.g. "auth.signIn") for the given locale, falling
 * back to English and then to the key itself. Deliberately tiny — no runtime
 * i18n library — to keep the mobile bundle small (Scope §7).
 */
export function t(key: string, locale: Locale = defaultLocale): string {
  const parts = key.split(".");
  return lookup(dictionaries[locale], parts) ?? lookup(dictionaries.en, parts) ?? key;
}
