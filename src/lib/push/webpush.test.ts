import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { sendWebPush, WEB_PUSH_FETCH_TIMEOUT_MS, type PushSub, type VapidConfig } from "./webpush";

function keyPair() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

function fixtures(): { sub: PushSub; config: VapidConfig } {
  const recipient = keyPair();
  const vapid = keyPair();
  return {
    sub: {
      endpoint: "https://fcm.googleapis.com/fcm/send/test-token",
      p256dh: recipient.publicKey,
      auth: crypto.randomBytes(16).toString("base64url"),
    },
    config: {
      ...vapid,
      subject: "mailto:security-test@fleetwise.test",
    },
  };
}

test("delivery disables redirects and attaches a bounded abort signal", async () => {
  const { sub, config } = fixtures();
  const originalFetch = globalThis.fetch;
  let requestedUrl: string | URL | Request | undefined;
  let requestedInit: RequestInit | undefined;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = input;
    requestedInit = init;
    return new Response(null, { status: 201 });
  }) as typeof fetch;

  try {
    const result = await sendWebPush(sub, { title: "Test" }, config);
    assert.equal(result.statusCode, 201);
    assert.equal(requestedUrl, sub.endpoint);
    assert.equal(requestedInit?.redirect, "error");
    assert.ok(requestedInit?.signal instanceof AbortSignal);
    assert.equal(requestedInit?.signal.aborted, false);
    assert.equal(WEB_PUSH_FETCH_TIMEOUT_MS, 10_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delivery rejects a persisted non-provider endpoint before fetch", async () => {
  const { sub, config } = fixtures();
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(null, { status: 201 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      sendWebPush({ ...sub, endpoint: "https://127.0.0.1/internal" }, { title: "Test" }, config),
      /Invalid Web Push subscription/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
