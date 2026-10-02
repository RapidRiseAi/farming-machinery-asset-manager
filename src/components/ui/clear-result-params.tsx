"use client";

import { useEffect } from "react";
import { KEEP_RESULT_PARAMS_ATTR, RESULT_PARAMS, minusKept, withoutResultParams } from "./result-params";

/**
 * Takes an action's outcome (`?saved=1`, `?error=...`) out of the address bar once the page
 * has shown it, so a refresh, a Back or a shared link does not announce it again.
 *
 * Renders nothing. `Flash` mounts it beside any message it shows, and `SavedMessage`
 * beside its toast, so pages get this without a line of their own.
 *
 * == Why `window.history.replaceState(null, ...)` and nothing else ==================
 *
 * - NOT `router.replace`: that is a navigation. It refetches the page without the
 *   parameter, so the server-rendered message would vanish the instant it appeared, and
 *   it costs a round trip on a farm's connection.
 * - `null` as the state, not `window.history.state`: Next's patched `replaceState` only
 *   syncs its own router (`usePathname`, `useSearchParams`, `router.refresh()`) when the
 *   state is NOT its own. Passing its state back would leave the router holding the old
 *   URL, and its next history write would put `?saved=1` straight back.
 * - The sync is a restore against the router's existing cache: no fetch, no re-render of
 *   the page, the message stays exactly where it is for this view.
 *
 * == Why the effect has no dependency list ==========================================
 *
 * Save twice on the same page and the second redirect lands on the same URL with the same
 * message. React keeps this component mounted across that soft navigation, so an effect
 * that ran "on mount" would clear the first `?saved=1` and never the second. It re-runs
 * on every commit instead, and does nothing unless a result key is actually present.
 *
 * It runs in the commit that put the message on screen, before React handles the next
 * tap, which matters: a restore dispatched while a navigation is pending discards that
 * navigation (Next's action queue, and the freeze documented in `route-progress.tsx` is
 * the same family). Never move this call into a timer.
 */
export function ClearResultParams({ keys = RESULT_PARAMS }: { keys?: readonly string[] }) {
  useEffect(() => {
    // A `KeepResultParams` marker anywhere on the page wins over every Flash.
    const kept = Array.from(document.querySelectorAll(`[${KEEP_RESULT_PARAMS_ATTR}]`), (el) =>
      el.getAttribute(KEEP_RESULT_PARAMS_ATTR),
    );
    const next = withoutResultParams(window.location.href, minusKept(keys, kept));
    if (next !== null) window.history.replaceState(null, "", next);
  });
  return null;
}
