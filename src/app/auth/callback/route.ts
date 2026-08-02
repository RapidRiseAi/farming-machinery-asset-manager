import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Only ever bounce to a path on THIS site.
 *
 * `next` arrives from the query string and used to be concatenated onto the origin
 * unchecked. A value like `/\evil.com` or `//evil.com` is treated by browsers as a
 * protocol-relative URL, which turns the callback into an open redirect — and an open
 * redirect on the auth callback is worth more than usual, because it is the URL users
 * are trained to click from their email. Anything that is not a plain same-site path
 * falls back to the role dispatcher.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/home";
  // Must be a single leading slash, and not the start of a scheme-relative URL.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/home";
  try {
    // Reject anything that decodes into an absolute URL or escapes the path.
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith("//") || decoded.startsWith("/\\") || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) {
      return "/home";
    }
  } catch {
    return "/home";
  }
  return raw;
}

/** Exchanges the magic-link / OTP code for a session, then redirects onward. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }
  return NextResponse.redirect(new URL("/login?error=auth", origin));
}
