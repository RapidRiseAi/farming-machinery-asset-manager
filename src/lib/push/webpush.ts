/**
 * Self-hosted Web Push — VAPID (RFC 8292) + aes128gcm content encryption (RFC 8188 /
 * RFC 8291), implemented with Node's built-in `crypto` only. No external provider, no
 * `web-push` dependency.
 *
 * Delivery is env-gated: if VAPID keys are not configured the caller no-ops gracefully
 * (see `getVapidConfig`). Generate a keypair with `node scripts/gen-vapid-keys.mjs`.
 *
 * This module is server-only (Node runtime) — never import it into a client component.
 */
import crypto from "node:crypto";

export type VapidConfig = { publicKey: string; privateKey: string; subject: string };
export type PushSub = { endpoint: string; p256dh: string; auth: string };

/** VAPID config from the environment, or null when push is not configured. */
export function getVapidConfig(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:alerts@fleetwise.app";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

const b64url = (b: Buffer): string => b.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

/** Rebuild an EC P-256 private KeyObject from the raw VAPID keypair (base64url). */
function importVapidPrivateKey(publicKeyB64: string, privateKeyB64: string): crypto.KeyObject {
  const pub = fromB64url(publicKeyB64); // 0x04 || X(32) || Y(32)
  const jwk: crypto.JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64url(pub.subarray(1, 33)),
    y: b64url(pub.subarray(33, 65)),
    d: privateKeyB64,
  };
  return crypto.createPrivateKey({ key: jwk, format: "jwk" });
}

/** Sign a VAPID JWT (ES256) for the given push-service origin. */
function vapidJwt(audience: string, config: VapidConfig): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    Buffer.from(JSON.stringify({ aud: audience, exp: now + 12 * 60 * 60, sub: config.subject }))
  );
  const signingInput = `${header}.${payload}`;
  const key = importVapidPrivateKey(config.publicKey, config.privateKey);
  // ieee-p1363 → raw R||S (64 bytes), which JWT/ES256 requires (not DER).
  const sig = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(sig)}`;
}

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number): Buffer =>
  Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, len));

/**
 * Encrypt a payload for a subscription using the aes128gcm content coding.
 * Returns the full body: salt(16) | rs(4) | idlen(1) | serverPublicKey(65) | ciphertext.
 */
function encryptPayload(payload: Buffer, p256dhB64: string, authB64: string): Uint8Array {
  const clientPub = fromB64url(p256dhB64); // 65 bytes
  const authSecret = fromB64url(authB64); // 16 bytes

  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const serverPub = ecdh.getPublicKey(); // 65 bytes uncompressed
  const sharedSecret = ecdh.computeSecret(clientPub);

  // RFC 8291 §3.4 — derive the input keying material.
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), clientPub, serverPub]);
  const ikm = hkdf(sharedSecret, authSecret, keyInfo, 32);

  // RFC 8188 §2.2 — content-encryption key + nonce, salted per message.
  const salt = crypto.randomBytes(16);
  const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);

  // Single record: plaintext followed by the 0x02 last-record padding delimiter.
  const record = Buffer.concat([payload, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([serverPub.length]), serverPub]);
  return new Uint8Array(Buffer.concat([header, ciphertext]));
}

/**
 * Deliver one push message. Returns the push service's HTTP status; 404/410 mean the
 * subscription is gone and the caller should prune it.
 */
export async function sendWebPush(
  sub: PushSub,
  payload: unknown,
  config: VapidConfig,
  ttlSeconds = 24 * 60 * 60
): Promise<{ statusCode: number }> {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = vapidJwt(audience, config);
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), sub.p256dh, sub.auth);

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      TTL: String(ttlSeconds),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Urgency: "normal",
      Authorization: `vapid t=${jwt}, k=${config.publicKey}`,
    },
    // Node/undici fetch accepts a Uint8Array body at runtime; the DOM BodyInit type is
    // narrower than TS 5.7's generic Uint8Array, so cast at this boundary only.
    body: body as unknown as BodyInit,
  });
  return { statusCode: res.status };
}
