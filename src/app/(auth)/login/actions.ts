"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { syncLocaleOnSignIn } from "@/lib/locale-sync";
import { siteUrl } from "@/lib/env";
import { safePath } from "@/lib/safe-path";
import { readAssurance } from "@/lib/mfa";
import { errorCode } from "@/lib/action-errors";

export async function signInWithPassword(formData: FormData) {
  const next=safePath(String(formData.get("next")??""),"/home");
  const loginError=(code:string)=>`/login?error=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`;
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  // The password box is no longer `required` in HTML, because the same form now
  // also submits to the magic-link action, which does not want one. So the check
  // moves here, where it belonged anyway, since HTML validation is a courtesy
  // and not a guarantee.
  if (!email) redirect(loginError("need-email"));
  if (!password) redirect(loginError("need-password"));
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(loginError(error.message));
  // Honour a language chosen on the login screen instead of silently discarding it.
  await syncLocaleOnSignIn();
  revalidatePath("/", "layout");
  // A code set up (B9): straight to the second step rather than through the app's gate.
  const assurance = await readAssurance(supabase);
  if (assurance.current === "aal1" && assurance.next === "aal2") {
    redirect(`/mfa/verify?next=${encodeURIComponent(next)}`);
  }
  // /home dispatches by role, a driver must not land on the owner's money page.
  redirect(safePath(String(formData.get("next") ?? ""), "/home"));
}

/**
 * Email a link that signs them in so they can set a new password.
 *
 * Deliberately lands on `/account`, where the password form already is, one place that
 * knows the rules, rather than a second screen repeating them.
 *
 * Whether the address exists is never revealed: the answer is the same either way, because
 * "no account with that address" on a reset form is an account-enumeration oracle.
 */
export async function sendPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) redirect("/login?error=need-email");

  // Configuration only, this URL goes in an email. See `siteUrl()`.
  const origin = siteUrl();
  if (!origin) redirect("/login?error=email-not-configured");

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/account%3Freset%3D1`,
  });
  // A rate limit is worth saying out loud; anything else is reported as sent, because the
  // alternative tells a stranger which addresses have accounts.
  if (error && /rate|too many/i.test(error.message)) {
    redirect(`/login?error=${errorCode(error, "auth/login/actions:sendPasswordReset")}`);
  }
  redirect("/login?reset=1");
}

/**
 * Email a sign-in link to an EXISTING account.
 *
 * `shouldCreateUser: false` because Supabase's default opens a new account for any address
 * typed here, with no plan, no terms and no farm, and emails it. On 5 November a demo
 * address typed back to front (`owner+therandomneon@gmail.com`) did exactly that, and the
 * link went to the stranger at `owner@gmail.com`. Accounts start at /signup.
 *
 * Like a reset, the screen says "sent" whether or not the address has an account; only a
 * rate limit or a real failure is reported.
 */
export async function signInWithMagicLink(formData: FormData) {
  const next=safePath(String(formData.get("next")??""),"/home");
  const email = String(formData.get("email") ?? "").trim();
  if (!email) redirect(`/login?error=need-email&next=${encodeURIComponent(next)}`);

  // Configuration only, this URL goes in an email. See `siteUrl()`. It used to come from
  // the request's Origin header, and a request from the old Vercel address asked Supabase
  // to send people there; Supabase refused it and fell back to the bare front page.
  const origin = siteUrl();
  if (!origin) redirect(`/login?error=email-not-configured&next=${encodeURIComponent(next)}`);

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      shouldCreateUser: false,
    },
  });
  if (error && !noSuchAccount(error)) {
    redirect(`/login?error=${errorCode(error, "auth/login/actions:signInWithMagicLink")}&next=${encodeURIComponent(next)}`);
  }
  redirect(`/login?sent=1&next=${encodeURIComponent(next)}`);
}

/** What Supabase answers when `shouldCreateUser: false` meets an unknown address. */
function noSuchAccount(error: { code?: string; message: string }): boolean {
  return error.code === "otp_disabled" || /signups? not allowed/i.test(error.message);
}
