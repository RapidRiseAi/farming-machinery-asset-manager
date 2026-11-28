import { parseUpdatePolicy, type UpdatePolicy } from "@/lib/native/app-version";

export type VersionInfo = {
  /** The deployment answering now, or null outside Vercel. */
  web: string | null;
  /** The Android app versions Rapid Rise set, or null when there is no usable answer. */
  android: UpdatePolicy | null;
};

const TIMEOUT_MS = 8_000;
let inflight: Promise<VersionInfo | null> | null = null;

/**
 * Asks /api/public/app-version. Browser code only. Null with no signal, a slow server or an
 * answer it cannot read: every caller treats that as "nothing to do", so a failed check never
 * reloads a page or locks anyone out. Two callers at the same moment (the update gate and the
 * deploy watch, when the app comes back) share one request. No cookies: the answer is the same
 * for everyone, and the session is not touched.
 */
export function fetchVersionInfo(): Promise<VersionInfo | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch("/api/public/app-version", { cache: "no-store", credentials: "omit", signal: controller.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { web?: unknown; android?: unknown };
      return {
        web: typeof body.web === "string" && body.web ? body.web : null,
        android: parseUpdatePolicy(body.android),
      };
    } catch {
      return null;
    } finally {
      window.clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}
