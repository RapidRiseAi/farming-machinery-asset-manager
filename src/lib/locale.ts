import { cookies, headers } from "next/headers";
import { locales, defaultLocale, type Locale } from "./i18n";

/**
 * Device-level language, for the screens that run before we know who the user is.
 *
 * The app is at EN/AF parity and invites default to Afrikaans, but the login screen and
 * the public QR pages called `t()` with no locale — because language lives on
 * `users.language` and there is no profile before sign-in. So a bilingual product opened
 * in English for every Afrikaans farm, with no way to change it (audit bug 2).
 *
 * Resolution order: an explicit choice (cookie) → the phone's own `Accept-Language` →
 * English. Signed-in users are unaffected: their profile language still wins on every
 * app surface; `setLanguage` just mirrors their choice into this cookie so it survives
 * sign-out and reaches the login screen next time.
 */
export const LOCALE_COOKIE = "fw_lang";

/** One year — this is a preference, not a session. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}

/**
 * Best supported locale named by an `Accept-Language` header, honouring q-weights.
 * `af-ZA` matches `af`. Returns null when the header names nothing we speak.
 */
export function parseAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      const weight = q === undefined ? 1 : Number(q);
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(weight) ? weight : 0 };
    })
    .filter((entry) => entry.tag && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const base = tag.split("-")[0];
    if (isLocale(base)) return base;
  }
  return null;
}

/** Resolve the locale for a visitor we cannot identify yet. Server-only. */
export async function deviceLocale(): Promise<Locale> {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(chosen)) return chosen;
  return parseAcceptLanguage((await headers()).get("accept-language")) ?? defaultLocale;
}
