import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * Refreshes the Supabase auth session on each request and forwards the updated
 * cookies. No-op when Supabase env isn't configured yet, so the app still runs.
 * Route guards by role are layered on in the auth phase.
 */
export async function updateSession(request: NextRequest) {
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
  } = await supabase.auth.getUser();

  // Guard the authenticated areas. The public-lite QR page (/m/[token]) and the
  // auth routes stay open.
  const path = request.nextUrl.pathname;
  const isProtected = ["/dashboard", "/machines", "/admin", "/jobcards", "/faults", "/team", "/reports", "/notifications", "/settings"].some(
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
