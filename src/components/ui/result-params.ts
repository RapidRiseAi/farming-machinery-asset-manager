/**
 * Which query parameters report the OUTCOME of an action, so the address bar can drop
 * them once the page has said so.
 *
 * Server actions here end in `redirect("/somewhere?saved=1")`, and the page turns that
 * parameter into a `Flash`. Left in the URL it replays: a refresh, a Back, a bookmark or
 * a link pasted to a colleague all announce "Saved" again, about something that happened
 * minutes or days ago. `ClearResultParams` removes these keys after the message is on
 * screen, and nothing else.
 *
 * Every key below was read from the pages as an outcome word (a past tense or an error),
 * never as state. Deliberately NOT here, because a page reads them to decide what to
 * SHOW: `status`, `q`, `from`, `to`, `type`, `kind`, `sort`, `page`, `open`, `edit`,
 * `retired` (the /machines filter, which looks like an outcome and is not), `checkout`
 * and `change` (the /billing return and step), `reset`, `resume` and `email` (the sign-in
 * flow), and `access` (too generic to own). Add a key here only after checking that no
 * page uses the same word as a filter or a step.
 *
 * No `"use client"`: this is a plain module so a Server Component can import the list
 * and the helper is testable in node.
 */
export const RESULT_PARAMS: readonly string[] = [
  "saved",
  "error",
  "added",
  "created",
  "deleted",
  "removed",
  "sent",
  "paid",
  "voided",
  "notice",
  "imported",
  "seen",
  "matched",
  "already",
  "undone",
  "aside",
  "invited",
  "erased",
  "permissionSaved",
  "converted",
  "accepted",
  "declined",
  "told",
  "staged",
  "revised",
  "written_off",
  "attached",
  "received",
  "raised",
  "nothing",
  "captured",
  "paused",
  "resumed",
  "synced",
  "failed",
  "connected",
  "disconnected",
  "asked",
  "revoked",
  "restored",
  "refunded",
  "reissued",
  "exited",
  "linkerror",
  "denied",
];

/**
 * The marker attribute `KeepResultParams` renders: a space-separated list of result keys
 * that must stay in the URL on this page (billing's "do not pay again" notice).
 */
export const KEEP_RESULT_PARAMS_ATTR = "data-keep-result-params";

/** `keys` minus every key some element on the page has asked to keep. */
export function minusKept(keys: readonly string[], keptLists: readonly (string | null | undefined)[]): string[] {
  const kept = new Set(keptLists.flatMap((list) => (list ?? "").split(/\s+/)).filter(Boolean));
  return keys.filter((key) => !kept.has(key));
}

/**
 * The same address without the given result keys, as a path plus query plus hash, or
 * `null` when none of them is present (so the caller does nothing at all).
 *
 * Every other parameter survives in its original order: a filter, a tab, a search or a
 * step the page relies on must still be there after a refresh.
 */
export function withoutResultParams(href: string, keys: readonly string[] = RESULT_PARAMS): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  let changed = false;
  for (const key of keys) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return null;
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}
