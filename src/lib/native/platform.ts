// Is this page running inside the FLEETWISE Android app (task B6)? Capacitor's bridge puts
// `window.Capacitor` on the page before any script of ours runs; in a browser it is absent.

type CapacitorGlobal = { isNativePlatform?: () => boolean; getPlatform?: () => string };

export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as { Capacitor?: CapacitorGlobal }).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

/** "android" inside the app; null in a browser (iPhone has no app: see docs/ANDROID.md). */
export function nativePlatform(): "android" | null {
  if (!isNativeApp()) return null;
  const cap = (window as { Capacitor?: CapacitorGlobal }).Capacitor;
  return cap?.getPlatform?.() === "android" ? "android" : null;
}
