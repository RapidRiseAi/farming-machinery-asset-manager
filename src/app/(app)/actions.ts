"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { CURRENT_FARM_COOKIE, SUPPORT_FARM_COOKIE, accessibleFarms } from "@/lib/auth";
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@/lib/locale";
import { isTone } from "@/lib/i18n";

/**
 * Switch this person's wording register between friendly and professional.
 *
 * Language and tone are deliberately independent: an Afrikaans user may want formal
 * wording, an English one may not. Tone needs no cookie — it never renders before
 * sign-in, because the QR and login screens are written for whoever picks up the phone.
 */
export async function setTone(formData: FormData) {
  const tone = String(formData.get("tone") ?? "").trim();
  const next = String(formData.get("next") ?? "").trim();
  if (isTone(tone)) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) await supabase.from("users").update({ tone }).eq("id", user.id);
  }
  revalidatePath("/", "layout");
  redirect(next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
}

export async function signOut() {
  const supabase = await createClient();
  const store = await cookies();
  const supportFarmId = store.get(SUPPORT_FARM_COOKIE)?.value;
  if (supportFarmId) {
    // Match the explicit support-mode exit path so signing out cannot leave an unpaired
    // impersonate event in the compliance log. This is deliberately best-effort: an
    // audit outage must not trap anyone in a signed-in session or stale farm context.
    await supabase.rpc("log_admin_farm_access", {
      p_farm: supportFarmId,
      p_action: "exit",
    });
  }
  await supabase.auth.signOut();
  // Farm/support context belongs to the signed-in person, not the browser. Leaving these
  // persistent cookies behind can open the next demo login on another farm and make gated
  // navigation appear to vanish even though that person's primary farm is entitled.
  store.delete(CURRENT_FARM_COOKIE);
  store.delete(SUPPORT_FARM_COOKIE);
  revalidatePath("/", "layout");
  redirect("/login");
}

/**
 * Switch the "current farm" a multi-site user is acting in (F7). The chosen id is
 * validated against the farms the user can actually access before it is stored — an
 * invalid choice is ignored (RLS is the real guard, but the cookie stays honest).
 */
/**
 * Switch the signed-in user's interface language (FR-18.1). Writes the chosen locale
 * to their own `users.language` row (RLS allows a self-update), then revalidates the
 * layout so every server-rendered surface re-renders through the new dictionary.
 */
export async function setLanguage(formData: FormData) {
  const lang = String(formData.get("lang") ?? "").trim();
  const next = String(formData.get("next") ?? "").trim();
  if (lang === "en" || lang === "af") {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      // Stamping the choice is what stops the next sign-in from treating this as an
      // unconfigured default and adopting whatever the device cookie happens to say
      // (migration 0370). A deliberate choice must outlive a shared computer.
      await supabase
        .from("users")
        .update({ language: lang, language_set_at: new Date().toISOString() })
        .eq("id", user.id);
    }
    // Mirror the choice onto the device so it survives sign-out and greets them in
    // their own language at the login screen next time (audit bug 2). The profile
    // remains the source of truth for every signed-in surface.
    (await cookies()).set(LOCALE_COOKIE, lang, {
      path: "/",
      maxAge: LOCALE_COOKIE_MAX_AGE,
      sameSite: "lax",
    });
  }
  revalidatePath("/", "layout");
  redirect(next && next.startsWith("/") ? next : "/dashboard");
}

export async function setCurrentFarm(formData: FormData) {
  const farmId = String(formData.get("farm_id") ?? "").trim();
  const next = String(formData.get("next") ?? "").trim();
  if (farmId) {
    const farms = await accessibleFarms();
    if (farms.some((f) => f.id === farmId)) {
      const store = await cookies();
      store.set(CURRENT_FARM_COOKIE, farmId, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365,
      });
    }
  }
  revalidatePath("/", "layout");
  redirect(next && next.startsWith("/") ? next : "/machines");
}
