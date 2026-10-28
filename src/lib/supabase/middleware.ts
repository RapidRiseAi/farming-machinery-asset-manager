import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authUnanswered } from "@/lib/auth-unanswered";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

const PROTECTED_PREFIXES = [
  "/accounting",
  "/admin",
  "/assistant",
  "/banking",
  "/billing",
  "/cashflow",
  "/checklists",
  "/contractor",
  "/dashboard",
  "/documents",
  "/driver",
  "/expenses",
  "/faults",
  "/finance",
  "/fines",
  "/fuel",
  "/home",
  "/inbox",
  "/install",
  "/jobcards",
  "/machines",
  "/money",
  "/notifications",
  "/onboarding",
  "/orders",
  "/partners",
  "/parts",
  "/recurring",
  "/recurring-expenses",
  "/reports",
  "/settings",
  "/statements",
  "/suppliers",
  "/team",
  "/vat",
  "/work",
] as const;

/**
 * Refreshes the Supabase auth session on each request and forwards the updated
 * cookies. No-op when Supabase env isn't configured yet, so the app still runs.
 * Route guards by role are layered on in the auth phase.
 */
/** The request header carrying the page asked for: see updateSession. */
export const PATH_HEADER = "x-fw-path";

export async function updateSession(request: NextRequest) {
  // The page asked for, for server components that send someone elsewhere and back (the
  // two-step sign-in gate in the app layout). Set here on every request, so a header a
  // client sent itself is overwritten, and only ever read as a same-site path.
  request.headers.set(PATH_HEADER, request.nextUrl.pathname + request.nextUrl.search);
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // Touch the session so refreshed tokens are written back to cookies.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  // Auth did not answer (unreachable, or a 5xx): not "signed out". The page runs, its own
  // profile read throws, and the person sees "try again" rather than a sign-in form that
  // cannot work during the outage (lib/auth-unanswered).
  if (authUnanswered(error)) return response;

  // Guard the authenticated areas. The public-lite QR page (/m/[token]) and the
  // auth routes stay open.
  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`)
  );
  if (!user && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}
