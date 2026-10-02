/**
 * Where a detail page's back link goes: the list the person came from, filters and all,
 * when the page was opened with `?from=<that list's URL>`, otherwise the list root.
 *
 * `from` arrives in the query string, so anyone can write it, and a back link that
 * follows it blindly is an open redirect: `?from=//evil.example` or `?from=https://...`
 * would send a farmer off the product from a trusted button. Only a same-origin PATH is
 * honoured: it must start with exactly one `/`, contain no backslash (browsers read `/\`
 * as `//`), and no control character (browsers strip a tab or newline from a URL, which
 * turns `/<TAB>/evil.example` into `//evil.example` after the check has passed).
 *
 * Plain module (no `"use client"`), so a Server Component can call it.
 */
export function backHref(from: string | string[] | null | undefined, fallback: string): string {
  const value = Array.isArray(from) ? from[0] : from;
  if (typeof value !== "string" || value.length === 0) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return fallback;
  }
  return value;
}
