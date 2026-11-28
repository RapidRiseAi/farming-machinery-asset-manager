import { isNativeApp } from "@/lib/native/platform";

/**
 * Calls `handler` each time the person comes back to FLEETWISE: a browser tab shown again, or
 * the Android app brought back to the front, with how long they were away. Browser code only.
 *
 * The page's own visibility event covers a browser. In the Android app the WebView does not
 * always fire it when the app goes to the background, so Capacitor's app-state event is heard
 * too; whichever arrives first counts, and the second finds nothing to report.
 */
export function onAppReturn(handler: (awayMs: number) => void): () => void {
  let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;
  const away = () => {
    if (hiddenAt === null) hiddenAt = Date.now();
  };
  const back = () => {
    if (hiddenAt === null) return;
    const awayMs = Date.now() - hiddenAt;
    hiddenAt = null;
    handler(awayMs);
  };
  const onVisibility = () => (document.visibilityState === "hidden" ? away() : back());
  document.addEventListener("visibilitychange", onVisibility);

  let removeNative: (() => void) | null = null;
  let cancelled = false;
  if (isNativeApp()) {
    void import("@capacitor/app")
      .then(({ App }) => App.addListener("appStateChange", ({ isActive }) => (isActive ? back() : away())))
      .then((handle) => {
        if (cancelled) void handle.remove();
        else removeNative = () => void handle.remove();
      })
      .catch(() => undefined);
  }

  return () => {
    cancelled = true;
    document.removeEventListener("visibilitychange", onVisibility);
    removeNative?.();
  };
}
