"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@/lib/locale";

/**
 * Set the device language from a screen that runs before sign-in — the login page and
 * the public QR pages (audit bug 2). Writes only a preference cookie: no auth, no DB,
 * and in particular nothing that touches the zero-anon-DB property of the QR flow.
 */
export async function setDeviceLanguage(formData: FormData) {
  const lang = String(formData.get("lang") ?? "").trim();
  const next = String(formData.get("next") ?? "").trim();

  if (isLocale(lang)) {
    (await cookies()).set(LOCALE_COOKIE, lang, {
      path: "/",
      maxAge: LOCALE_COOKIE_MAX_AGE,
      sameSite: "lax",
    });
  }

  revalidatePath("/", "layout");
  // Only ever bounce back to a same-origin path the caller already came from.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/login");
}
