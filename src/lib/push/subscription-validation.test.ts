import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  isStandardWebPushHostname,
  MAX_WEB_PUSH_ENDPOINT_LENGTH,
  validateWebPushEndpoint,
  validateWebPushSubscription,
} from "./subscription-validation";

function validKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: crypto.randomBytes(16).toString("base64url"),
  };
}

test("accepts standard browser push services over HTTPS", () => {
  const keys = validKeys();
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/token",
    "https://updates.push.services.mozilla.com/wpush/v2/token",
    "https://web.push.apple.com/QD-token",
    "https://regional.push.apple.com/QD-token",
    "https://wns2-db5p.notify.windows.com/w/?token=value",
  ]) {
    assert.ok(validateWebPushSubscription({ endpoint, ...keys }), endpoint);
  }
});

test("blocks arbitrary, insecure, credentialed, and nonstandard-port endpoints", () => {
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/token",
    "https://127.0.0.1/push",
    "https://metadata.google.internal/latest/meta-data",
    "https://fcm.googleapis.com.evil.test/push",
    "https://user:pass@fcm.googleapis.com/push",
    "https://fcm.googleapis.com:8443/push",
  ]) {
    assert.equal(validateWebPushEndpoint(endpoint), null, endpoint);
  }
});

test("allows only exact vendor hosts or a real Microsoft notification subdomain", () => {
  assert.equal(isStandardWebPushHostname("fcm.googleapis.com"), true);
  assert.equal(isStandardWebPushHostname("wns2-par02p.notify.windows.com"), true);
  assert.equal(isStandardWebPushHostname("regional.push.apple.com"), true);
  assert.equal(isStandardWebPushHostname("notify.windows.com.evil.test"), false);
  assert.equal(isStandardWebPushHostname("evilnotify.windows.com"), false);
  assert.equal(isStandardWebPushHostname("push.apple.com.evil.test"), false);
});

test("rejects oversized endpoints and malformed subscription keys", () => {
  const keys = validKeys();
  assert.equal(validateWebPushEndpoint(`https://fcm.googleapis.com/${"x".repeat(MAX_WEB_PUSH_ENDPOINT_LENGTH)}`), null);
  assert.equal(
    validateWebPushSubscription({ endpoint: "https://fcm.googleapis.com/push", p256dh: "not!base64", auth: keys.auth }),
    null,
  );
  assert.equal(
    validateWebPushSubscription({ endpoint: "https://fcm.googleapis.com/push", p256dh: keys.p256dh, auth: "c2hvcnQ" }),
    null,
  );
});

test("rejects a 65-byte value that is not a valid P-256 public key", () => {
  assert.equal(
    validateWebPushSubscription({
      endpoint: "https://fcm.googleapis.com/push",
      p256dh: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64)]).toString("base64url"),
      auth: crypto.randomBytes(16).toString("base64url"),
    }),
    null,
  );
});
