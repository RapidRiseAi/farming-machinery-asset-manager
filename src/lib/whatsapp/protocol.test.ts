import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { validSignature, parseWebhook, hashLinkToken, phoneNumber, replyWindowOpen } from "./protocol";
import { delegatedToken } from "./identity";
import { clarificationAnswer, confirmationAction, renderWhatsAppResponse } from "./conversation";
import type { AssistantTurnResponse } from "@/lib/assistant/types";

test("webhook authentication covers the exact bytes and rejects forged or absent signatures", () => {
  const secret = "test-only-signature-secret";
  const raw = '{"message":"hello"}';
  const header = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  assert.equal(validSignature(raw, header, secret), true);
  assert.equal(validSignature(raw + " ", header, secret), false);
  assert.equal(validSignature(raw, header, "other"), false);
  for (const bad of [null, "", "sha256=0", "sha1=" + "a".repeat(64)]) assert.equal(validSignature(raw, bad, secret), false);
});

test("only the configured business and receiving number route messages", () => {
  const value = { metadata: { phone_number_id: "111" }, messages: [{ id: "wamid.1", from: "27820000001", timestamp: "1790000000", type: "text", text: { body: "Hi" } }] };
  const envelope = { object: "whatsapp_business_account", entry: [{ id: "222", changes: [{ field: "messages", value }] }] };
  assert.equal(parseWebhook(envelope, "222", "111")?.length, 1);
  assert.deepEqual(parseWebhook(envelope, "333", "111"), []);
  assert.deepEqual(parseWebhook(envelope, "222", "999"), []);
  assert.equal(parseWebhook({ ...envelope, object: "other" }, "222", "111"), null);
});

test("phone validation never invents a country code and token hashes reveal no bearer", () => {
  assert.equal(phoneNumber("+27 (82) 000-0001"), "27820000001");
  assert.equal(phoneNumber("0820000001"), null);
  assert.equal(phoneNumber("someone@example.test"), null);
  const hash = hashLinkToken("example-secret");
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, hashLinkToken("another-secret"));
});

test("free-form reply window expires at 24 hours and rejects invalid/future timestamps", () => {
  const now = Date.now();
  assert.equal(replyWindowOpen(new Date(now - 23 * 3600000).toISOString(), now), true);
  assert.equal(replyWindowOpen(new Date(now - 24 * 3600000).toISOString(), now), false);
  assert.equal(replyWindowOpen(new Date(now + 3600000).toISOString(), now), false);
  assert.equal(replyWindowOpen("bad", now), false);
});

test("delegation signs a one-minute authenticated user token, never service-role", () => {
  const previous = { jwk: process.env.WHATSAPP_AUTH_PRIVATE_JWK, url: process.env.NEXT_PUBLIC_SUPABASE_URL, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    process.env.WHATSAPP_AUTH_PRIVATE_JWK = JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: "wa-test-key" });
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-public-key";
    const token = delegatedToken({ id: "link", user_id: "user", farm_id: "farm" }, 1000000);
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.equal(claims.sub, "user"); assert.equal(claims.role, "authenticated");
    assert.equal(claims.fw_link_id, "link"); assert.equal(claims.fw_farm_id, "farm");
    assert.equal(claims.exp - claims.iat, 60);
    assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true);
  } finally {
    for (const [key, value] of Object.entries({ WHATSAPP_AUTH_PRIVATE_JWK: previous.jwk, NEXT_PUBLIC_SUPABASE_URL: previous.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: previous.anon })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("confirmation is bound to the latest unexpired proposal, not a casual yes", () => {
  const pending: AssistantTurnResponse = { kind: "confirm", conversationId: "c", proposal: {
    proposalId: "12345678-1111-4111-8111-111111111111", title: "Log reading", intent: "log_reading",
    machineName: "Tractor", facts: [{ label: "Reading", value: "1200 h" }], expiresAt: new Date(Date.now() + 60000).toISOString(),
  } };
  assert.equal(confirmationAction("yes", pending), null);
  assert.equal(confirmationAction("CONFIRM 87654321", pending), null);
  assert.equal(confirmationAction("confirm 12345678", pending), "confirm");
  assert.equal(confirmationAction("REJECT 12345678", pending), "reject");
  assert.match(renderWhatsAppResponse(pending, "https://fleetwise.example"), /Reading: 1200 h/);
  pending.proposal.expiresAt = new Date(0).toISOString();
  assert.equal(confirmationAction("CONFIRM 12345678", pending), null);
});

test("clarification numbers select only server-provided options", () => {
  const pending: AssistantTurnResponse = { kind: "clarify", conversationId: "conversation", question: "Which tractor?", fields: [
    { name: "machineId", type: "select", label: "Machine", options: [{ value: "allowed", label: "Tractor A" }] },
  ] };
  assert.deepEqual(clarificationAnswer("1", pending), { interactionId: "conversation", machineId: "allowed" });
  assert.deepEqual(clarificationAnswer("other-machine-id", pending), { interactionId: "conversation", machineQuery: "other-machine-id" });
});
