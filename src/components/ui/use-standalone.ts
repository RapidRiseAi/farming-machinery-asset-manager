import { useEffect, useState } from "react";

/**
 * True when the app is running as an installed app (launched from the home screen),
 * so "Install app" can stop being offered to somebody who already did it.
 *
 * Decided AFTER mount and false until then: the server cannot know the display mode, and
 * reading it during render would make the first client render disagree with the HTML.
 * A hook module with no "use client" of its own; only client components import it.
 */
export function useStandalone(): boolean {
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    try {
      const mq = window.matchMedia("(display-mode: standalone)");
      const ios = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
      const update = () => setStandalone(mq.matches || ios);
      update();
      mq.addEventListener?.("change", update);
      return () => mq.removeEventListener?.("change", update);
    } catch {
      /* no matchMedia: treat as a browser tab */
    }
  }, []);
  return standalone;
}

/** The install screen's href, the one nav item this hook exists to hide. */
export const INSTALL_HREF = "/install";
