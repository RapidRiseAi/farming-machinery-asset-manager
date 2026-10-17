import assert from "node:assert/strict";
import test from "node:test";
import { checkWhatsAppConfiguration } from "./diagnostics";

test("operator diagnostics identify missing subscription and wrong receiving phone without leaking provider data", async () => {
  const names = { WHATSAPP_GRAPH_VERSION: "v25.0", WHATSAPP_PHONE_NUMBER_ID: "111",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "222", WHATSAPP_BUSINESS_PHONE: "27820000001",
    WHATSAPP_ACCESS_TOKEN: "test-access-secret", WHATSAPP_APP_SECRET: "test-app-secret",
    WHATSAPP_VERIFY_TOKEN: "test-verify-secret" };
  const old = Object.fromEntries(Object.keys(names).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    Object.assign(process.env, names);
    let subscribed = false;
    let rejected = false;
    let proofRejected = false;
    let tokenScopes = ["whatsapp_business_management", "whatsapp_business_messaging"];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://graph.facebook.com");
      assert.match(url.searchParams.get("appsecret_proof") ?? "", /^[a-f0-9]{64}$/);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-access-secret");
      if (proofRejected) return Response.json({ error: { code: 100, message: "Invalid appsecret_proof provided in the API argument" } }, { status: 400 });
      if (rejected) return Response.json({ error: { code: 190, message: "test-access-secret" } }, { status: 400 });
      if (url.pathname.endsWith("debug_token")) {
        assert.equal(url.searchParams.get("input_token"), "test-access-secret");
        return Response.json({ data: { is_valid: true, app_id: "333", scopes: tokenScopes,
          user_id: "PRIVATE", extra: "test-access-secret" } });
      }
      return Response.json({ data: url.pathname.endsWith("subscribed_apps")
        ? subscribed ? [{ whatsapp_business_api_data: { id: "333", name: "PRIVATE" } }] : []
        : [{ id: subscribed ? "111" : "999", display_phone_number: "+27 82 000 0001" }] });
    };
    const missing = await checkWhatsAppConfiguration();
    assert.deepEqual(missing.subscriptions, { ok: true, morePages: false, appIds: [] });
    assert.deepEqual(missing.phone, { ok: true, morePages: false, configuredIdFound: false, businessNumberMatches: false });
    subscribed = true;
    const matched = await checkWhatsAppConfiguration();
    assert.deepEqual(matched.subscriptions, { ok: true, morePages: false, appIds: ["333"] });
    assert.deepEqual(matched.phone, { ok: true, morePages: false, configuredIdFound: true, businessNumberMatches: true });
    assert.deepEqual(matched.token, { ok: true, valid: true, appId: "333", managementPermission: true, messagingPermission: true });
    assert.doesNotMatch(JSON.stringify(matched), /PRIVATE|27820000001|secret/);
    tokenScopes = ["whatsapp_business_messaging"];
    assert.equal((await checkWhatsAppConfiguration()).token.managementPermission, false);
    rejected = true;
    const failure = await checkWhatsAppConfiguration();
    assert.deepEqual(failure.subscriptions, { ok: false, status: 400, code: 190, reason: "invalid_access_token" });
    assert.deepEqual(failure.token, { ok: false, status: 400, code: 190 });
    assert.doesNotMatch(JSON.stringify(failure), /secret/);
    proofRejected = true;
    const badProof = await checkWhatsAppConfiguration();
    assert.deepEqual(badProof.subscriptions, { ok: false, status: 400, code: 100, reason: "app_secret_mismatch" });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
