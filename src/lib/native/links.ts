// Links that open the Android app (App Links, task B6): an emailed sign-in, invite or reset link to
// the app's own address opens inside the app at the same page. Anything else is not ours to open.

/**
 * The page inside the app for a link, or null. Only the app's own https address counts; the path
 * must be a plain local path (no scheme-relative "//" trick), and it keeps its query and hash, which
 * carry sign-in codes.
 */
export function inAppPath(link: string, appOrigin: string): string | null {
  let url: URL;
  let origin: URL;
  try {
    url = new URL(link);
    origin = new URL(appOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.origin !== origin.origin) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
  return path;
}
