/**
 * The absolute URL a customer opens from an email.
 *
 * Server-rendered links inside the app can stay relative; an email cannot. `NEXT_PUBLIC_SITE_URL`
 * is already the variable the rest of the project uses for this, so it stays the one
 * source — a second variable would eventually disagree with the first.
 */
export function siteUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

/** The customer-facing page for a document, behind its unguessable token. */
export function publicDocumentUrl(token: string): string {
  return `${siteUrl()}/d/${token}`;
}
