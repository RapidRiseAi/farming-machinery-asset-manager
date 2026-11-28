// Which FLEETWISE Android app a phone has, and whether it must, or may, update (28 Nov 2026).
//
// The app is a shell around the live site (capacitor.config.ts): every screen comes from the
// server on each open, so web changes need no update. Only the shell (its plugins, its Android
// settings) is versioned here. Rapid Rise sets two versions per platform at /admin/app-version:
//
//   latest   an app older than this is ASKED to update, every time it is opened ("Not now"
//            hides the request until the app is next opened);
//   minimum  an app older than this MUST update: nothing else is usable until it has. Raise it
//            only when the site needs something an older shell does not have.
//
// Versions are compared, never build numbers. Every app built before 28 Nov 2026 says "1.0.0"
// with build 1, and native/version.json is the single source of a new one's version; the
// Android build turns it into the build number Google Play needs (`versionCodeOf`).

/** Three whole numbers, "1.1.0". Minor and patch stay under 100 so the build number is exact. */
export type AppVersion = readonly [major: number, minor: number, patch: number];

// The same pattern as the database's check (20261128100000) and the Android build's.
const VERSION_PATTERN = /^([1-9]\d{0,4})\.(\d{1,2})\.(\d{1,2})$/;

export function parseAppVersion(text: unknown): AppVersion | null {
  if (typeof text !== "string") return null;
  const m = VERSION_PATTERN.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when a is older than b, 0 when equal, positive when newer. */
export function compareAppVersions(a: AppVersion, b: AppVersion): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The Android build number (versionCode) for a version: android/app/build.gradle computes the
 * same from native/version.json, and the Android workflow checks the built app agrees.
 * Always rises with the version, which is all Google Play asks of it.
 */
export function versionCodeOf(v: AppVersion): number {
  return v[0] * 10_000 + v[1] * 100 + v[2];
}

export type UpdatePolicy = {
  /** Asked to update below this. */
  latest: string;
  /** Must update below this. Never above `latest`. */
  minimum: string;
  /** Where "Update now" goes: the Play Store listing, or a download page. https only. */
  url: string;
};

export type UpdateNeed = "none" | "optional" | "required";

/**
 * The policy as /api/public/app-version sends it, or null when it is not one. A malformed
 * answer means no request to update: an app is never blocked on a reply it cannot read.
 */
export function parseUpdatePolicy(value: unknown): UpdatePolicy | null {
  if (!value || typeof value !== "object") return null;
  const { latest, minimum, url } = value as Record<string, unknown>;
  const l = parseAppVersion(latest);
  const m = parseAppVersion(minimum);
  if (!l || !m || compareAppVersions(m, l) > 0) return null;
  if (typeof url !== "string" || !isHttpsUrl(url)) return null;
  return { latest: latest as string, minimum: minimum as string, url };
}

/**
 * What this phone's app has to do. An installed version that cannot be read is "none": a
 * check that fails never locks anyone out of the app.
 */
export function updateNeed(installed: string, policy: UpdatePolicy): UpdateNeed {
  const have = parseAppVersion(installed);
  const latest = parseAppVersion(policy.latest);
  const minimum = parseAppVersion(policy.minimum);
  if (!have || !latest || !minimum) return "none";
  if (compareAppVersions(have, minimum) < 0) return "required";
  if (compareAppVersions(have, latest) < 0) return "optional";
  return "none";
}

export function isHttpsUrl(text: string): boolean {
  if (text.length > 2000) return false;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** The Play Store listing, the default destination once the app is published there. */
export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=za.co.fleetwise.app";
