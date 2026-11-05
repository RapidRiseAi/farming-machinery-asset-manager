/**
 * Domain readiness: every link that leaves the app (emails, PDFs, printed QR labels, the
 * payment return page) is built from `NEXT_PUBLIC_SITE_URL`, so it must be the address
 * this deployment is reached at. A WARNING, not a failure: the product works either way,
 * but a mismatch prints labels and sends emails that point somewhere else. Says only
 * whether it matches, never either address. Localhost and preview hosts are not judged.
 */
export function siteUrlWarning(configured: string | undefined, requestHost: string | null): string | null {
  if (!configured) return "site_url_unset";
  let host: string;
  try {
    host = new URL(configured).host.toLowerCase();
  } catch {
    return "site_url_invalid";
  }
  const served = (requestHost ?? "").split(",")[0].trim().toLowerCase();
  if (!served || served.startsWith("localhost") || served.endsWith(".vercel.app")) return null;
  return served === host ? null : "site_url_mismatch";
}
