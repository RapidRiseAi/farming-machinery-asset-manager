import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safePath } from "@/lib/safe-path";
import { syncLocaleOnSignIn } from "@/lib/locale-sync";

/**
 * `next` arrives from the query string and used to be concatenated onto the origin
 * unchecked. A value like `/\evil.com` or `//evil.com` is treated by browsers as a
 * protocol-relative URL, which turns the callback into an open redirect — and an open
 * redirect on the auth callback is worth more than most, because it is the URL users
 * are trained to click from their email.
 *
 * Exchanges the magic-link / OTP code for a session, then redirects onward.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safePath(searchParams.get("next"), "/home");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Same reconciliation as the password path — a magic link is the other way a
      // session begins, and the language chosen on this device must survive it.
      await syncLocaleOnSignIn();
      return NextResponse.redirect(new URL(next, origin));
    }
  }
  return NextResponse.redirect(new URL("/login?error=auth", origin));
}
