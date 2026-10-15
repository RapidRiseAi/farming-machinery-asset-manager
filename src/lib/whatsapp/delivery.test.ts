import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { deliverWhatsAppNotifications, processWhatsAppInbox } from "./worker";

test("delivery sends only to the live consenting assignee and never blindly retries a failed send", async () => {
  const values = {
    NEXT_PUBLIC_SUPABASE_URL: "https://database.example.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-public",
    SUPABASE_SERVICE_ROLE_KEY: "test-server", WHATSAPP_ENABLED: "1", WHATSAPP_GRAPH_VERSION: "v25.0",
    WHATSAPP_PHONE_NUMBER_ID: "100", WHATSAPP_BUSINESS_ACCOUNT_ID: "200", WHATSAPP_BUSINESS_PHONE: "27820000000",
    WHATSAPP_ACCESS_TOKEN: "test-access", WHATSAPP_APP_SECRET: "test-app", WHATSAPP_VERIFY_TOKEN: "test-verify",
    WHATSAPP_NOTIFICATION_TEMPLATE: "fleetwise_notification", WHATSAPP_ASSIGNMENT_TEMPLATE: "fleetwise_assignment",
    WHATSAPP_TEMPLATE_LANGUAGE: "en",
  };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, values);
  try {
    for (const scenario of ["allowed", "revoked", "opted_out", "different_user", "different_farm", "reassigned", "provider_failure"]) {
      let state = "queued";
      let sends = 0;
      const patches: Record<string, unknown>[] = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
        if (url.hostname === "graph.facebook.com") {
          sends++;
          assert.equal(body.to, "27820000001");
          assert.equal(body.template.name, "fleetwise_assignment");
          assert.equal(body.type, "template");
          assert.equal(body.template.components, undefined, "no private record details in lock-screen notification");
          return scenario === "provider_failure" ? respond({ error: "provider" }, 503) : respond({ messages: [{ id: "wamid.test" }] });
        }
        assert.equal(url.hostname, "database.example.test", "no unexpected network request");
        const route = url.pathname.replace("/rest/v1/", "");
        if (route === "rpc/whatsapp_enqueue_notifications") return respond(null);
        if (route === "rpc/whatsapp_delivery_target") return respond(scenario === "revoked" ? null : {
          id: "link", user_id: "employee", farm_id: "farm", phone: "27820000001", notifications_enabled: scenario !== "opted_out",
        });
        if (route === "whatsapp_notification_delivery" && method === "GET") return respond(state === "queued" ? [{ notification_id: "notification", link_id: "link" }] : []);
        if (route === "notifications") return respond({ template: "job_assigned", user_id: scenario === "different_user" ? "other" : "employee",
          farm_id: scenario === "different_farm" ? "other-farm" : "farm", deleted_at: null, payload: { job_card_id: "job" } });
        if (route === "job_cards") {
          assert.equal(url.searchParams.get("mechanic_user_id"), "eq.employee");
          assert.equal(url.searchParams.get("farm_id"), "eq.farm");
          return respond(scenario === "reassigned" ? null : { id: "job" });
        }
        if (route === "whatsapp_notification_delivery" && method === "PATCH") {
          patches.push(body); state = body.state;
          return respond(url.searchParams.has("select") ? { notification_id: "notification" } : null);
        }
        throw new Error(`Unexpected mock route ${method} ${route}`);
      };
      const result = await deliverWhatsAppNotifications();
      assert.equal(sends, ["allowed", "provider_failure"].includes(scenario) ? 1 : 0, scenario);
      assert.equal(result.sent, scenario === "allowed" ? 1 : 0, scenario);
      assert.equal(state, scenario === "allowed" ? "sent" : scenario === "provider_failure" ? "failed" : "cancelled", scenario);
      if (scenario === "provider_failure") {
        await deliverWhatsAppNotifications();
        assert.equal(sends, 1, "unknown delivery must not automatically post again");
      }
      assert.ok(patches.length > 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("cached assistant details require unchanged permissions, including recovery and changes during a turn", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const values = {
    NEXT_PUBLIC_SUPABASE_URL: "https://database.example.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-public",
    NEXT_PUBLIC_SITE_URL: "https://fleetwise.example.test", SUPABASE_SERVICE_ROLE_KEY: "test-server",
    WHATSAPP_ENABLED: "1", WHATSAPP_GRAPH_VERSION: "v25.0", WHATSAPP_PHONE_NUMBER_ID: "100",
    WHATSAPP_ACCESS_TOKEN: "test-access", WHATSAPP_BUSINESS_ACCOUNT_ID: "200", WHATSAPP_BUSINESS_PHONE: "27820000000",
    WHATSAPP_APP_SECRET: "test-app", WHATSAPP_VERIFY_TOKEN: "test-verify",
    WHATSAPP_AUTH_PRIVATE_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: "test-only" }),
  };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, values);
  try {
    for (const scenario of ["current", "changed_before_turn", "changed_during_turn", "recovered_reply"]) {
      let targets = 0;
      let sentText = "";
      let savedConversation: unknown = undefined;
      let cleared = false;
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        const respond = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
        if (url.hostname === "graph.facebook.com") {
          sentText = body.text.body;
          return respond({ messages: [{ id: "wamid.reply" }] });
        }
        assert.equal(url.hostname, "database.example.test");
        const route = url.pathname.replace("/rest/v1/", "");
        if (route === "rpc/whatsapp_claim") return respond([{ id: "message", link_id: "link", message_text: "repeat",
          message_at: new Date().toISOString(), reply: scenario === "recovered_reply" ? "PRIVATE COST" : null }]);
        if (route === "rpc/whatsapp_delivery_target") {
          targets++;
          return respond({ id: "link", user_id: "employee", farm_id: "farm", phone: "27820000001",
            revoked_at: null, assistant_enabled: true, expires_at: new Date(Date.now() + 3600000).toISOString(),
            assistant_until: new Date(Date.now() + 3600000).toISOString(), conversation_at: new Date().toISOString(),
            conversation_authority_tag: "old", authority_tag: scenario === "changed_before_turn" || (scenario === "changed_during_turn" && targets > 1) ? "new" : "old",
            conversation: { kind: "confirm", conversationId: "interaction", proposal: {
              proposalId: "12345678-1111-4111-8111-111111111111", title: "Service", machineName: "Tractor",
              facts: [{ label: "Cost", value: "PRIVATE COST" }], expiresAt: new Date(Date.now() + 60000).toISOString(),
            } },
          });
        }
        if (route === "rpc/whatsapp_assistant_role" || route === "users") {
          const token = new Headers(init?.headers).get("Authorization")!.replace("Bearer ", "");
          const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
          assert.equal(claims.role, "authenticated"); assert.equal(claims.sub, "employee"); assert.equal(claims.fw_farm_id, "farm");
          return respond(route === "users" ? { id: "employee", active: true, language: "en" } : "mechanic");
        }
        if (route === "rpc/whatsapp_save_reply") {
          assert.equal(body.p_authority_tag, scenario === "changed_before_turn" ? "new" : "old");
          savedConversation = body.p_conversation;
          return respond(true);
        }
        if (route === "whatsapp_links" && method === "PATCH") {
          if (body.conversation === null) cleared = true;
          return respond(null);
        }
        if (route === "whatsapp_inbox" && method === "PATCH") return respond(url.searchParams.has("select") ? { id: "message" } : null);
        throw new Error(`Unexpected mock route ${method} ${route}`);
      };
      const result = await processWhatsAppInbox();
      assert.equal(result.processed, 1, scenario);
      if (scenario === "current") assert.match(sentText, /PRIVATE COST/);
      else assert.doesNotMatch(sentText, /PRIVATE COST/, scenario);
      if (scenario === "changed_before_turn") assert.equal(savedConversation, null);
      if (["changed_during_turn", "recovered_reply"].includes(scenario)) assert.equal(cleared, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
