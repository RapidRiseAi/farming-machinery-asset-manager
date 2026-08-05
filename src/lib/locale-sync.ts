import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@/lib/locale";
import type { Locale } from "@/lib/i18n";

/**
 * Reconcile the device's language choice with the profile's, at sign-in.
 *
 * The bug this exists to close: someone opens the login page in Afrikaans, taps AF,
 * reads a fully Afrikaans login screen, signs in — and every page after that is English.
 * `users.language` is `not null default 'en'`, so a profile nobody had ever configured
 * outranked the only language choice the person had actually made. Worse, `<html lang>`
 * kept reading the cookie, so the page announced itself as Afrikaans to a screen reader
 * while rendering English.
 *
 * The rule, in one place:
 *
 *   - The person has chosen a language before (`language_set_at` set) → their profile
 *     wins, and the cookie is corrected to match it. This is what protects a shared
 *     farm-office machine: an Afrikaans worker's cookie cannot re-language the owner.
 *   - They have never chosen (`language_set_at` null) and this device carries an explicit
 *     choice → adopt it and stamp it, because that tap is the only evidence we have.
 *   - Neither → write the profile's language to the cookie so the two always agree.
 *
 * Called from the two — and only two — places a session comes into being: the password
 * sign-in action and the magic-link callback. Both may set cookies; a Server Component
 * may not, which is why this cannot live in `getProfile`.
 */
export async function syncLocaleOnSignIn(): Promise<void> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return;

  const { data } = await supabase
    .from("users")
    .select("language, language_set_at")
    .eq("id", uid)
    .maybeSingle();
  if (!data) return;

  const profileLang = isLocale(data.language) ? (data.language as Locale) : "en";
  const store = await cookies();
  const deviceRaw = store.get(LOCALE_COOKIE)?.value;
  const device = isLocale(deviceRaw) ? deviceRaw : null;
  const everChosen = !!data.language_set_at;

  let effective: Locale = profileLang;
  if (!everChosen && device && device !== profileLang) {
    // Their one explicit signal. Adopt it, and record that it was theirs, so the next
    // person to use this device cannot quietly change it back.
    const { error } = await supabase
      .from("users")
      .update({ language: device, language_set_at: new Date().toISOString() })
      .eq("id", uid);
    if (!error) effective = device;
  }

  // Always leave the cookie equal to what the pages will actually render in, so
  // `<html lang>` can never contradict the words on the screen.
  store.set(LOCALE_COOKIE, effective, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
  });
}
