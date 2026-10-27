/**
 * Whether Supabase Auth failed to answer, as opposed to answering "no session".
 *
 * A missing session (AuthSessionMissingError) and a refused token (a 4xx) mean signed out.
 * Auth unreachable (AuthRetryableFetchError: status 0, or a 5xx) or answering something
 * unreadable (no status at all) means we do not know, and a signed-in person must not be
 * sent to the sign-in page for it: they would see a sign-in form that cannot work while
 * Auth is down, and nothing saying why.
 *
 * Its own module, with no imports, because the middleware (which runs before every
 * protected page) needs the same answer as lib/auth and cannot load that module.
 */
export function authUnanswered(error: { name?: string; status?: number } | null | undefined): boolean {
  if (!error || error.name === "AuthSessionMissingError") return false;
  return typeof error.status !== "number" || error.status === 0 || error.status >= 500;
}
