/**
 * A same-site path, or the fallback.
 *
 * Several server actions take a `back` field from the submitted form and redirect to it
 * (`redirect(`${back}?error=…`)`). A form field is attacker-influenced, and Next's
 * `redirect()` will happily send the browser to an absolute URL — so an unvalidated
 * `back` is an open redirect wearing a convenience feature's clothes.
 *
 * The rules are deliberately strict rather than clever: one leading slash, nothing that
 * a browser would read as scheme-relative (`//host`, `/\host`), and nothing that decodes
 * into an absolute URL. Anything else falls back.
 */
export function safePath(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  const value = raw.trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded.startsWith("//") ||
      decoded.startsWith("/\\") ||
      /^[a-z][a-z0-9+.-]*:/i.test(decoded)
    ) {
      return fallback;
    }
  } catch {
    return fallback;
  }
  return value;
}
