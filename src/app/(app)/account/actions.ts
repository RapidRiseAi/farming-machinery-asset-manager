"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { sendVerificationEmail } from "@/lib/email/verify";

/**
 * A person's own account: their name, their address, their password.
 *
 * ── Why this did not exist ───────────────────────────────────────────────────
 * There was no way for anybody to change their own password or email address. The only
 * `updateUser` call in the whole codebase was the admin path on the team screen. Combined
 * with password recovery being the magic link, a typo'd address at sign-up was a permanent
 * lockout only Rapid Rise could undo — for somebody paying every month.
 *
 * ── Why the RLS client and not the service role ──────────────────────────────
 * `supabase.auth.updateUser` acts on the CALLER's own session. That is the whole guard:
 * there is no id parameter to get wrong, no way to aim it at somebody else, and no admin
 * privilege in the request path at all. The service client appears only where a
 * SECURITY DEFINER helper genuinely needs it — minting the verification hash.
 *
 * Changing an email through Supabase does NOT take effect until the new address is
 * confirmed from a link Supabase itself sends there. That is the correct behaviour and it
 * is why the screen says "we have sent a link" rather than "changed": an unconfirmed change
 * that silently took effect would be a way to lock somebody out of their own account by
 * typing a second wrong address.
 */

function bounce(code: string): never {
  redirect(`/account?error=${encodeURIComponent(code)}`);
}

export async function changeMyName(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) bounce("name-required");
  if (name.length > 120) bounce("too-long");

  const supabase = await createClient();
  const { error } = await supabase.from("users").update({ name }).eq("id", profile.id);
  if (error) bounce("save-failed");

  revalidatePath("/account");
  redirect("/account?saved=name");
}

export async function changeMyPassword(formData: FormData): Promise<void> {
  await requireProfile();
  const next = String(formData.get("password") ?? "");
  const again = String(formData.get("password_again") ?? "");

  // Matched here as well as in the browser: the browser check is a courtesy, and a form can
  // be submitted without it ever running.
  if (next.length < 8) bounce("password-short");
  if (next !== again) bounce("password-mismatch");

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) bounce("password-failed");

  redirect("/account?saved=password");
}

export async function changeMyEmail(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) bounce("signup-email");
  if (email === (profile.email ?? "").toLowerCase()) bounce("email-unchanged");

  const supabase = await createClient();
  // Supabase emails the NEW address and only swaps it once that link is followed, so
  // `public.users.email` is deliberately left alone here — it is updated when the change
  // actually lands, not when it is requested. Writing it now would leave the profile
  // claiming an address the account cannot receive mail at.
  const { error } = await supabase.auth.updateUser({ email });
  if (error) bounce("email-failed");

  redirect("/account?saved=email");
}

/** Send the verification link again — the address was mistyped, or the mail went missing. */
export async function resendVerification(): Promise<void> {
  const profile = await requireProfile();
  if (!profile.email) bounce("no-email");

  const service = createServiceClient();
  const sent = await sendVerificationEmail(service, {
    userId: profile.id,
    email: profile.email,
    name: profile.name,
    locale: profile.lang,
  });
  if (!sent.ok) {
    // An operator problem must not be reported to a farmer as though they did something
    // wrong: "our mail is not switched on" and "that address bounced" are different
    // sentences and only one of them is about them.
    const operatorProblem = sent.reason === "email-not-configured" || sent.reason === "no-site-url";
    bounce(operatorProblem ? "email-not-configured" : "email-failed");
  }

  redirect("/account?saved=verification");
}
