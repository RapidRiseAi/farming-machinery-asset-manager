import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { buildContentSecurityPolicy, createNonce, NONCE_HEADER } from "@/lib/security/csp";

/**
 * Every request gets a fresh nonce and the enforced content security policy built around it
 * (lib/security/csp.ts). Both go on the REQUEST before updateSession makes its response, so
 * every NextResponse.next({ request }) it builds forwards them to the page: Next.js reads the
 * nonce from the Content-Security-Policy request header for its own scripts, and the root
 * layout reads NONCE_HEADER for ours. A header of either name a client sent is overwritten.
 * The policy then goes on whatever response updateSession returns, the sign-in redirect and
 * the "auth did not answer" pass-through included.
 *
 * NEXT_PUBLIC_* values are fixed at build time, so setting the Turnstile site key in Vercel
 * needs a redeploy before the policy names Cloudflare.
 */
export async function middleware(request: NextRequest) {
  const nonce = createNonce();
  const policy = buildContentSecurityPolicy({
    nonce,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    turnstile: !!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim(),
    payfastSandbox: process.env.PAYFAST_SANDBOX === "1",
  });
  request.headers.set(NONCE_HEADER, nonce);
  request.headers.set("content-security-policy", policy);
  const response = await updateSession(request);
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  // Run on all routes except static assets. The public QR page (/m/[token]) is
  // handled inside route logic; role-based guards are added in the auth phase.
  // Skipped paths get no content security policy, which is fine: none of them is a page.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.svg|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
