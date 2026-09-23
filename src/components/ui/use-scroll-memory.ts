"use client";

import { useEffect, useLayoutEffect, type RefObject } from "react";

/**
 * Remember where a scroll container was left, and put it back when it mounts again.
 *
 * == The two places this was measured to be wrong =============================
 * The sidebar nav is ~26 destinations, 909px of scroll on a 720px-tall laptop, so a
 * person working in the long tail (billing, settings, tyres, fines) scrolls down to
 * reach anything. Two paths reset that to the top, measured in Chrome over CDP:
 *
 *   desktop sidebar, HARD navigation : 909 -> 0   RESET
 *   mobile "More" sheet, reopened    : 943 -> 0   RESET
 *
 * A CLIENT-side navigation keeps the position for free, because React does not
 * unmount the container; that is why this looked fine and was not. But this is a PWA
 * relaunched from a home screen, a service worker serves the document, and any full
 * load remounts the nav. The sheet is worse: it mounts fresh on EVERY open, so the
 * reset is unconditional there, every single time.
 *
 * So the position is stored rather than left to React's reconciliation to preserve by
 * accident. `sessionStorage`, not `localStorage`: where you were in the menu is a
 * property of this visit, and a stale offset restored a week later is noise.
 *
 * Every read and write is wrapped, because `sessionStorage` throws outright in a
 * private window with site data blocked, and this is nav chrome: it must render.
 */

const PREFIX = "farmgear:scroll:";

function read(key: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function write(key: string, top: number) {
  try {
    window.sessionStorage.setItem(PREFIX + key, String(Math.round(top)));
  } catch {
    /* blocked or full: the position is a convenience, never a requirement */
  }
}

// Restore before paint, so the panel is never seen at the top and then jumping.
// Chosen at module scope rather than per render: a hook may not be called conditionally.
const useRestoreEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useScrollMemory(
  ref: RefObject<HTMLElement | null>,
  /** Omit (or pass undefined) to remember nothing, e.g. while a sheet is closed. */
  key: string | undefined,
  options: {
    /**
     * CSS selector for the element to bring into view when there is NOTHING
     * remembered yet, i.e. the first load of a session. Used for the nav's
     * `[aria-current="page"]`: arriving on /billing from an email link should not
     * show the top of a list whose active row is 600px below the fold.
     */
    reveal?: string;
  } = {},
) {
  const { reveal } = options;

  useRestoreEffect(() => {
    const el = ref.current;
    if (!el || !key) return;

    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) {
      const saved = read(key);
      if (saved !== null) {
        el.scrollTop = Math.min(saved, max);
      } else if (reveal) {
        const target = el.querySelector<HTMLElement>(reveal);
        if (target) {
          // Rect deltas, not `offsetTop`: `offsetTop` is measured from the nearest
          // POSITIONED ancestor, which for this nav is the wrapper outside the
          // scroller, so it happens to agree only while scrollTop is 0.
          const t = target.getBoundingClientRect();
          const c = el.getBoundingClientRect();
          const delta = t.top - c.top;
          const hidden = delta < 0 || delta + t.height > el.clientHeight;
          if (hidden) {
            const centred = el.scrollTop + delta - (el.clientHeight - t.height) / 2;
            el.scrollTop = Math.max(0, Math.min(centred, max));
          }
        }
      }
    }

    // One write per frame at most. A scroll fires per pixel of wheel travel and
    // `sessionStorage` is synchronous, so the unthrottled version is a jank machine.
    //
    // `last` is read synchronously in the listener rather than in the cleanup, and
    // that is the whole trick. A DETACHED element reports `scrollTop` 0, and React
    // tears the portal down before this effect's destroy runs, so the obvious cleanup
    // (`write(key, el.scrollTop)`) faithfully stores 0 every time. Measured: scrolled
    // to 500, closed, `{"farmgear:scroll:nav-more":"0"}`, reopened at the top - the
    // same symptom as having no memory at all, with the code in place to prove it had.
    let last = el.scrollTop;
    let frame = 0;
    const save = () => {
      last = el.scrollTop;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        write(key, last);
      });
    };
    el.addEventListener("scroll", save, { passive: true });
    return () => {
      el.removeEventListener("scroll", save);
      if (frame) window.cancelAnimationFrame(frame);
      // A close or a navigation can outrun the pending frame.
      write(key, last);
    };
  }, [ref, key, reveal]);
}
