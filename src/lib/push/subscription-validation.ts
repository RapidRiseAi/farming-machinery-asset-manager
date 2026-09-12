import crypto from "node:crypto";

export const MAX_WEB_PUSH_ENDPOINT_LENGTH = 4096;
export const MAX_WEB_PUSH_P256DH_LENGTH = 128;
export const MAX_WEB_PUSH_AUTH_LENGTH = 64;

const STANDARD_WEB_PUSH_HOSTS = new Set([
  "android.googleapis.com",
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "updates.push.services.mozilla.com",
]);

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export type ValidatedWebPushSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

/** Only browser vendors' standard Web Push services may receive server-side requests. */
export function isStandardWebPushHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    STANDARD_WEB_PUSH_HOSTS.has(normalized) ||
    normalized.endsWith(".notify.windows.com") ||
    normalized.endsWith(".push.apple.com")
  );
}

export function validateWebPushEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_WEB_PUSH_ENDPOINT_LENGTH) {
    return null;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !isStandardWebPushHostname(url.hostname)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function decodeBase64Url(value: unknown, maxLength: number, expectedBytes: number): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !BASE64URL.test(value)) {
    return null;
  }

  const unpadded = value.replace(/=+$/, "");
  const decoded = Buffer.from(unpadded, "base64url");
  if (decoded.length !== expectedBytes || decoded.toString("base64url") !== unpadded) return null;
  return decoded;
}

export function validateWebPushSubscription(input: {
  endpoint: unknown;
  p256dh: unknown;
  auth: unknown;
}): ValidatedWebPushSubscription | null {
  const endpoint = validateWebPushEndpoint(input.endpoint);
  const p256dh = decodeBase64Url(input.p256dh, MAX_WEB_PUSH_P256DH_LENGTH, 65);
  const auth = decodeBase64Url(input.auth, MAX_WEB_PUSH_AUTH_LENGTH, 16);
  if (!endpoint || !p256dh || !auth || p256dh[0] !== 0x04) return null;

  try {
    // Length and prefix are not enough: reject byte strings that are not points on P-256.
    crypto.ECDH.convertKey(p256dh, "prime256v1", undefined, undefined, "uncompressed");
  } catch {
    return null;
  }

  return {
    endpoint,
    p256dh: p256dh.toString("base64url"),
    auth: auth.toString("base64url"),
  };
}
