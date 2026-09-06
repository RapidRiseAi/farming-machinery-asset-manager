/**
 * CSRF guard for state-changing Route Handlers that authenticate with cookies.
 *
 * Browsers control the Origin and Sec-Fetch-Site headers, so an exact origin match
 * prevents another site (including a sibling subdomain) from replaying the caller's
 * session cookies. Requests without Origin fail closed unless browser fetch metadata
 * explicitly identifies them as same-origin.
 */
export function sameOrigin(request: Request): boolean {
  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    return false;
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = request.headers.get("origin");
  if (!origin) return fetchSite === "same-origin";

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return parsed.origin === requestOrigin && parsed.href === `${parsed.origin}/`;
  } catch {
    return false;
  }
}
