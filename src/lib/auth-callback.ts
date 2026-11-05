/**
 * Why an emailed link could not sign somebody in, as far as the callback can tell without
 * calling the provider (pricing brief section 8, founder walkthrough of 29 October 2026).
 *
 * Supabase's emailed links (password reset, sign-in link) use PKCE: the browser that asked
 * for the link keeps a code-verifier cookie, and the link only works in that same browser.
 * Opened in another browser, another device, or outside the private window it was asked
 * from, the cookie is not there and the exchange fails, which used to be shown as "that
 * link has expired or has already been used". That sent people round in circles asking
 * for new links in the wrong place.
 *
 * Only the cookie's NAME is read, never its value, and nothing about the code is logged.
 */
export function missingCodeVerifier(cookieNames: readonly string[]): boolean {
  return !cookieNames.some((name) => /-code-verifier$/.test(name));
}
