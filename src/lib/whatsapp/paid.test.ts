/**
 * Paid WhatsApp (20261118120200): Meta's status settles a message's hold, once, with what Meta
 * says the message cost; the database decides the money (assistance_cap.sql). This proves the
 * webhook passes Meta's pricing through unchanged and settles nothing it should not.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { holdWhatsAppMessage, settleWhatsAppStatus } from "./paid";
import { parseWebhook } from "./protocol";

function fakeDb(answer: { data?: unknown; error?: { message: string } | null } = {}) {
  const calls: { fn: string; args: unknown }[] = [];
  const db = {
    async rpc(fn: string, args: unknown) {
      calls.push({ fn, args });
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

test("a delivered status passes Meta's pricing to the settlement; a sent one settles nothing", async () => {
  const free = fakeDb();
  await settleWhatsAppStatus(free.db, {
    id: "wamid.1", status: "delivered", pricing: { billable: false, type: "free_customer_service", category: "service" },
  });
  assert.deepEqual(free.calls, [{ fn: "whatsapp_usage_settle", args: {
    p_provider_message_id: "wamid.1", p_status: "delivered", p_billable: false, p_type: "free_customer_service", p_category: "service",
  } }]);
  const sent = fakeDb();
  await settleWhatsAppStatus(sent.db, { id: "wamid.2", status: "sent" });
  assert.deepEqual(sent.calls, []);
  const failed = fakeDb();
  await settleWhatsAppStatus(failed.db, { id: "wamid.3", status: "failed" });
  assert.equal((failed.calls[0].args as { p_status: string }).p_status, "failed");
  // Anything that is not a plain slug is not passed on.
  const odd = fakeDb();
  await settleWhatsAppStatus(odd.db, { id: "wamid.4", status: "read", pricing: { type: "Regular; drop", category: "utility" } });
  assert.equal((odd.calls[0].args as { p_type: string | null }).p_type, null);
});

test("a settlement the database refuses is a failure the webhook retries", async () => {
  const broken = fakeDb({ error: { message: "boom" } });
  await assert.rejects(settleWhatsAppStatus(broken.db, { id: "wamid.5", status: "delivered", pricing: { type: "regular" } }));
});

test("the webhook keeps Meta's pricing object on a status", () => {
  const values = parseWebhook({
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "phone" },
      statuses: [{ id: "wamid.6", status: "delivered", pricing: { billable: true, pricing_model: "PMP", type: "regular", category: "utility" } }],
    } }] }],
  }, "waba", "phone");
  assert.deepEqual(values?.[0].statuses?.[0].pricing, { billable: true, pricing_model: "PMP", type: "regular", category: "utility" });
});

test("a hold says unmetered, held or refused, and never guesses", async () => {
  assert.deepEqual(await holdWhatsAppMessage(fakeDb({ data: { ok: true, metered: false } }).db, { farmId: "f", userId: "u", category: "utility" }),
    { kind: "unmetered" });
  assert.deepEqual(await holdWhatsAppMessage(fakeDb({ data: { ok: true, metered: true, id: "h" } }).db, { farmId: "f", userId: "u", category: "utility" }),
    { kind: "held", reservationId: "h" });
  assert.deepEqual(await holdWhatsAppMessage(fakeDb({ data: { ok: false, reason: "farm_limit" } }).db, { farmId: "f", userId: "u", category: "service" }),
    { kind: "refused", reason: "farm_limit" });
  // The database could not be asked: not sent, rather than sent unheld.
  assert.deepEqual(await holdWhatsAppMessage(fakeDb({ error: { message: "down" } }).db, { farmId: "f", userId: "u", category: "service" }),
    { kind: "refused", reason: "unavailable" });
});
