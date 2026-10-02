/**
 * Server-safe helpers for URL-synced `Tabs` (`<Tabs param="tab" ...>`).
 *
 *   // in a server action, after saving something on the Papers tab:
 *   redirect(withTab(`/machines/${id}?saved=licence`, "papers"));
 *
 *   // in the page:
 *   <Tabs param="tab" defaultTab={readTab(sp.tab, ["overview", "servicing", "papers"])} tabs={...} />
 *
 * Deliberately NOT in `tabs.tsx`: that module is "use client", and a plain function
 * exported from a client module is a client reference that throws when a server action
 * or a Server Component calls it (tsc and next build both pass). No "use client" here.
 */

/**
 * `url` with `?<param>=<key>` set (replacing any existing value), keeping every other
 * param and the hash. Works on a relative URL such as "/machines/42?saved=1".
 */
export function withTab(url: string, key: string, param = "tab"): string {
  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const qAt = noHash.indexOf("?");
  const path = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  const params = new URLSearchParams(qAt >= 0 ? noHash.slice(qAt + 1) : "");
  params.set(param, key);
  return `${path}?${params.toString()}${hash}`;
}

/**
 * The tab a page should open on, from a raw search-param value. Returns undefined for a
 * missing or unknown key, so a stale or hand-typed `?tab=` falls back to the first tab
 * instead of selecting nothing.
 */
export function readTab(
  value: string | string[] | null | undefined,
  keys: readonly string[],
): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && keys.includes(v) ? v : undefined;
}
