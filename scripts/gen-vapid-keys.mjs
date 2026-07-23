#!/usr/bin/env node
/*
 * Generate a self-hosted VAPID keypair for Web Push (F6). No dependencies — Node crypto.
 *
 *   node scripts/gen-vapid-keys.mjs
 *
 * Copy the printed values into .env.local (and your Vercel project):
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY  (= VAPID_PUBLIC_KEY, exposed to the browser to subscribe)
 */
import crypto from "node:crypto";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pubJwk = publicKey.export({ format: "jwk" });
const privJwk = privateKey.export({ format: "jwk" });

const b64urlToBuf = (s) => Buffer.from(s, "base64url");
const uncompressed = Buffer.concat([
  Buffer.from([0x04]),
  b64urlToBuf(pubJwk.x),
  b64urlToBuf(pubJwk.y),
]);

const VAPID_PUBLIC_KEY = uncompressed.toString("base64url");
const VAPID_PRIVATE_KEY = privJwk.d; // already 32-byte scalar, base64url

console.log("VAPID_PUBLIC_KEY=" + VAPID_PUBLIC_KEY);
console.log("VAPID_PRIVATE_KEY=" + VAPID_PRIVATE_KEY);
console.log("VAPID_SUBJECT=mailto:alerts@example.com");
console.log("NEXT_PUBLIC_VAPID_PUBLIC_KEY=" + VAPID_PUBLIC_KEY);
