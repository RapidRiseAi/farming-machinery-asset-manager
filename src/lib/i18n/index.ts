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
 * What kind of business an account is, chosen at sign-up and changeable in Settings. It
 * decides the words on every screen, the vehicle types offered and which modules start on.
 * Until it is known (before sign-in, in emails, for contractors and Rapid Rise) the wording
 * is universal, so nobody ever reads the product as being for one industry.
 */
export const companyTypes = [
  "farm",
  "game_drive",
  "goods_transport",
  "delivery",
  "passenger_transport",
  "construction",
  "other",
] as const;
export type CompanyType = (typeof companyTypes)[number];

export function isCompanyType(value: string | null | undefined): value is CompanyType {
  return !!value && (companyTypes as readonly string[]).includes(value);
}

/**
 * What `t()` actually renders in: a language, optionally in the professional register,
 * optionally for one kind of company: `af-pro@goods_transport`.
 *
 * `Locale` is assignable to `Lang`, so every existing `t(key, locale)` call site stays
 * correct as written. Tone and company type reach them by what gets passed in, not by a new
 * argument threaded through hundreds of components.
 *
 * So a `Lang` is NOT a language tag: never hand one to `Intl` or compare it to "af".
 * `localeOf` is the language inside it.
 */
export type Lang =
  | Locale
  | `${Locale}-pro`
  | `${Locale}@${CompanyType}`
  | `${Locale}-pro@${CompanyType}`;

/** Compose the render language from the independent choices. */
export function langOf(locale: Lang, tone: Tone, company?: CompanyType | null): Lang {
  const base = tone === "professional" ? `${localeOf(locale)}-pro` : localeOf(locale);
  return (company ? `${base}@${company}` : base) as Lang;
}

/** The plain language behind a `Lang`, what belongs in `<html lang>`. */
export function localeOf(lang: Lang): Locale {
  return lang.slice(0, 2) as Locale;
}

export function toneOf(lang: Lang): Tone {
  return lang.includes("-pro") ? "professional" : "friendly";
}

/** The company type inside a `Lang`, or null when it is not known. */
export function companyOf(lang: Lang): CompanyType | null {
  const at = lang.indexOf("@");
  return at === -1 ? null : (lang.slice(at + 1) as CompanyType);
}

/** The words that change between kinds of company. See `wordsFor`. */
type Words = { org: string; orgs: string; on: string; asset: string; assets: string };
type WordSet = "farm" | "company" | "plant" | "general";

/**
 * In the dictionaries these are written {{org}}, {{orgs}}, {{on}}, {{asset}} and {{assets}},
 * with a capital for a capitalised word ({{Org}}). {{on}} is there because a person is ON a
 * farm but IN a company: "{{on}} this {{org}}". Keep to words that take "a", never "an", so
 * "a {{org}}" reads correctly in every set.
 */
const WORDS: Record<Locale, Record<WordSet, Words>> = {
  en: {
    farm: { org: "farm", orgs: "farms", on: "on", asset: "machine", assets: "machines" },
    company: { org: "company", orgs: "companies", on: "in", asset: "vehicle", assets: "vehicles" },
    plant: { org: "company", orgs: "companies", on: "in", asset: "machine", assets: "machines" },
    general: { org: "business", orgs: "businesses", on: "in", asset: "vehicle", assets: "vehicles" },
  },
  af: {
    farm: { org: "plaas", orgs: "plase", on: "op", asset: "masjien", assets: "masjiene" },
    company: { org: "maatskappy", orgs: "maatskappye", on: "in", asset: "voertuig", assets: "voertuie" },
    plant: { org: "maatskappy", orgs: "maatskappye", on: "in", asset: "masjien", assets: "masjiene" },
    general: { org: "besigheid", orgs: "besighede", on: "in", asset: "voertuig", assets: "voertuie" },
  },
};

function wordSetOf(company: CompanyType | null): WordSet {
  if (company === "farm") return "farm";
  if (company === "construction") return "plant";
  if (company === null || company === "other") return "general";
  return "company";
}

/** Fill the {{org}}-style words for this reader. Universal when the company is not known. */
export function wordsFor(text: string, lang: Lang): string {
  if (!text.includes("{{")) return text;
  const words = WORDS[localeOf(lang)][wordSetOf(companyOf(lang))];
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const word = words[name.toLowerCase() as keyof Words];
    if (word === undefined) return whole;
    return name[0] === name[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word;
  });
}

export function isTone(value: string | null | undefined): value is Tone {
  return !!value && (tones as readonly string[]).includes(value);
}

const base: Record<Locale, unknown> = { en, af };
/**
 * Professional wording is an OVERLAY, not a translation: it holds only the keys whose
 * register actually differs. Everything else, nouns, machine types, field labels -
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
 * the key itself. Deliberately tiny, no runtime i18n library, to keep the mobile
 * bundle small (Scope §7).
 */
export function t(key: string, lang: Lang = defaultLocale): string {
  const parts = key.split(".");
  const locale = localeOf(lang);
  if (toneOf(lang) === "professional") {
    const pro = lookup(overlay[locale], parts) ?? lookup(overlay.en, parts);
    if (pro !== undefined) return wordsFor(pro, lang);
  }
  return wordsFor(lookup(base[locale], parts) ?? lookup(base.en, parts) ?? key, lang);
}
