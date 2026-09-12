"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { syncLocaleOnSignIn } from "@/lib/locale-sync";
import { siteUrl } from "@/lib/env";

export async function signInWithPassword(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  // The password box is no longer `required` in HTML, because the same form now
  // also submits to the magic-link action, which does not want one. So the check
  // moves here — where it belonged anyway, since HTML validation is a courtesy
  // and not a guarantee.
  if (!email) redirect("/login?error=need-email");
  if (!password) redirect("/login?error=need-password");
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  // Honour a language chosen on the login screen instead of silently discarding it.
  await syncLocaleOnSignIn();
  revalidatePath("/", "layout");
  // /home dispatches by role — a driver must not land on the owner's money page.
  redirect("/home");
}

/**
 * Email a link that signs them in so they can set a new password.
 *
 * Deliberately lands on `/account`, where the password form already is — one place that
 * knows the rules, rather than a second screen repeating them.
 *
 * Whether the address exists is never revealed: the answer is the same either way, because
 * "no account with that address" on a reset form is an account-enumeration oracle.
 */
export async function sendPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) redirect("/login?error=need-email");

  // Configuration only — this URL goes in an email. See `siteUrl()`.
  const origin = siteUrl();
  if (!origin) redirect("/login?error=email-not-configured");

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/account%3Freset%3D1`,
  });
  // A rate limit is worth saying out loud; anything else is reported as sent, because the
  // alternative tells a stranger which addresses have accounts.
  if (error && /rate|too many/i.test(error.message)) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
  redirect("/login?reset=1");
}

export async function signInWithMagicLink(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) redirect("/login?error=need-email");
  const supabase = await createClient();
  const origin =
    (await headers()).get("origin") ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "";
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback?next=/home` },
  });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect("/login?sent=1");
}
