"use client";

import { useEffect } from "react";
import {
  BOOT_ATTRIBUTE,
  BOOT_CONTROLS,
  BOOT_HARD_CAP_MS,
  BOOT_OWNED_FLAG,
  BOOT_SETTLE_CAP_MS,
  BOOT_SNAPSHOT_KEY,
  allControlsHydrated,
} from "./boot-guard";

/** How often to look again while the page is still arriving or attaching. */
const SETTLE_POLL_MS = 50;
/**
 * The most one poll may add to the elapsed time. A phone that freezes the page in the
 * background pauses this timer and React's hydration alike; counting the frozen half
 * minute would end the wait the moment the page resumed, before React had caught up.
 */
const MAX_STEP_MS = 250;

type BootWindow = Window & { [BOOT_OWNED_FLAG]?: boolean; [BOOT_SNAPSHOT_KEY]?: NodeListOf<Element> };

/**
 * Takes the starting mark off <html> once the page works (see boot-guard.ts).
 *
 * Its effect runs when React has committed the root layout, which on a streamed page can
 * be well before the page has finished arriving: the machine pages measured 0.4 s and
 * 1.4 s early on a throttled phone, and their content, buttons included, was still
 * streaming in. So it waits for two things: the whole document parsed (readyState past
 * "loading", which for a streamed response means the stream has closed), and then every
 * control the server sent attached, since Suspense content hydrates after the root. It
 * gives the page back BOOT_SETTLE_CAP_MS of running time after the document is complete,
 * or BOOT_HARD_CAP_MS after it first ran, whatever it finds. From its first run it owns
 * the timing, so the guard's own fail-safe stands down. Client-side navigation never sets
 * the mark again: React mounts those controls already working.
 */
export function BootReady() {
  useEffect(() => {
    const root = document.documentElement;
    if (!root.hasAttribute(BOOT_ATTRIBUTE)) return;
    const win = window as BootWindow;
    win[BOOT_OWNED_FLAG] = true;
    let last = performance.now();
    let elapsed = 0;
    let parsedAt: number | null = null;
    let timer = 0;
    const settle = () => {
      const now = performance.now();
      elapsed += Math.min(now - last, MAX_STEP_MS);
      last = now;
      if (parsedAt === null && document.readyState !== "loading") parsedAt = elapsed;
      // The server's own controls, as the guard recorded them at parse; a node React
      // replaced while recovering from a mismatch is gone from the page and does not count.
      const snapshot = win[BOOT_SNAPSHOT_KEY];
      const controls = snapshot
        ? Array.from(snapshot).filter((element) => element.isConnected)
        : document.querySelectorAll(BOOT_CONTROLS);
      const ready = parsedAt !== null && allControlsHydrated(controls);
      const capped = (parsedAt !== null && elapsed - parsedAt >= BOOT_SETTLE_CAP_MS) || elapsed >= BOOT_HARD_CAP_MS;
      if (ready || capped) {
        root.removeAttribute(BOOT_ATTRIBUTE);
        return;
      }
      timer = window.setTimeout(settle, SETTLE_POLL_MS);
    };
    settle();
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}
