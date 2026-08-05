import en from "./en.json";
import af from "./af.json";
import enPro from "./en.professional.json";
import afPro from "./af.professional.json";

export const locales = ["en", "af"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export const tones = ["friendly", "professional"] as const;
export type Tone = (typeof tones)[number];
export const defaultTone: Tone = "friendly";

/**
 * What `t()` actually renders in: a language, optionally in the professional register.
 *
 * `Locale` is assignable to `Lang`, so every existing `t(key, locale)` call site stays
 * correct as written — tone reaches them by what gets passed in, not by a new argument
 * threaded through hundreds of components.
 */
export type Lang = Locale | `${Locale}-pro`;

/** Compose the render language from the two independent choices. */
export function langOf(locale: Lang, tone: Tone): Lang {
  return tone === "professional" ? (`${locale}-pro` as Lang) : locale;
}

/** The plain language behind a `Lang` — what belongs in `<html lang>`. */
export function localeOf(lang: Lang): Locale {
  return lang.endsWith("-pro") ? (lang.slice(0, -4) as Locale) : (lang as Locale);
}

export function toneOf(lang: Lang): Tone {
  return lang.endsWith("-pro") ? "professional" : "friendly";
}

export function isTone(value: string | null | undefined): value is Tone {
  return !!value && (tones as readonly string[]).includes(value);
}

const base: Record<Locale, unknown> = { en, af };
/**
 * Professional wording is an OVERLAY, not a translation: it holds only the keys whose
 * register actually differs. Everything else — nouns, machine types, field labels —
 * resolves to the one dictionary, so there is no third and fourth file to keep at
 * parity and no way for a professional-tone user to hit an untranslated string.
 */
const overlay: Record<Locale, unknown> = { en: enPro, af: afPro };

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
 * Translate a dot-path key (e.g. "auth.signIn").
 *
 * Resolution: professional overlay for this language → this language → English →
 * the key itself. Deliberately tiny — no runtime i18n library — to keep the mobile
 * bundle small (Scope §7).
 */
export function t(key: string, lang: Lang = defaultLocale): string {
  const parts = key.split(".");
  const locale = localeOf(lang);
  if (toneOf(lang) === "professional") {
    const pro = lookup(overlay[locale], parts) ?? lookup(overlay.en, parts);
    if (pro !== undefined) return pro;
  }
  return lookup(base[locale], parts) ?? lookup(base.en, parts) ?? key;
}
