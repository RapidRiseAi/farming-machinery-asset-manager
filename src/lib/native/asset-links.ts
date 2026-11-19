// Digital Asset Links for the Android app (task B6): the statement at
// https://<app address>/.well-known/assetlinks.json that lets Android open the app's own links in
// the app (App Links, android:autoVerify). It names the app's package and the SHA-256 fingerprints
// of the keys it is signed with, which only exist once the founder sets up signing (Play App
// Signing shows them). Until ANDROID_CERT_SHA256 is set the statement is empty: no app claims the
// links, and they keep opening in the browser.

export const DEFAULT_ANDROID_APP_ID = "za.co.fleetwise.app";
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export type AssetStatement = {
  relation: string[];
  target: { namespace: "android_app"; package_name: string; sha256_cert_fingerprints: string[] };
};

/** The statement list for the configured app, or [] while signing is not set up (or set up wrongly). */
export function assetLinks(env: Record<string, string | undefined>): AssetStatement[] {
  const packageName = (env.ANDROID_APP_ID ?? DEFAULT_ANDROID_APP_ID).trim();
  const fingerprints = (env.ANDROID_CERT_SHA256 ?? "")
    .split(",")
    .map((f) => f.trim().toUpperCase())
    .filter(Boolean);
  if (!PACKAGE.test(packageName) || fingerprints.length === 0 || !fingerprints.every((f) => FINGERPRINT.test(f))) return [];
  return [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: packageName, sha256_cert_fingerprints: [...new Set(fingerprints)] },
  }];
}
