import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPush } from "./deliver";
import type { PushSub } from "./webpush";

type Note = {
  id: string; user_id: string; farm_id: string; template: string;
  payload: Record<string, unknown>; delivered_subscription_ids: string[];
};
type Subscription = PushSub & { id: string; user_id: string; deleted_at?: string };
type Call = { name: string; args: Record<string, unknown> };
const note = (id = "note-1", template = "service_due_soon", payload: Record<string, unknown> = {}): Note => ({
  id, user_id: "user-1", farm_id: "farm-1", template, payload, delivered_subscription_ids: [],
});

function fixture(notes = [note()]) {
  const key = createECDH("prime256v1");
  key.generateKeys();
  const sub = (id: string): Subscription => ({
    id, user_id: "user-1", endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url"),
  });
  const users = [{ id: "user-1", notify_push: true, language: "en", active: true }];
  const subscriptions = [sub("device-1"), sub("device-2")];
  const calls: Call[] = [];
  const finished = new Set<string>();
  const errors = new Set<string>();
  const sent: { id: string; payload: unknown }[] = [];
  let now = 0;
  let sender: (device: Subscription) => Promise<number> = async () => 201;
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (errors.has(name)) return { data: null, error: { message: "injected" } };
      if (name === "claim_notification_push") {
        return { data: notes.filter((n) => !finished.has(n.id)), error: null };
      }
      if (name === "ack_notification_push") {
        notes.find((n) => n.id === args.p_notification_id)!.delivered_subscription_ids.push(String(args.p_subscription_id));
      }
      if (name === "finish_notification_push" && args.p_terminal) finished.add(String(args.p_notification_id));
      return { data: true, error: null };
    },
    from(table: string) {
      let update: Record<string, unknown> | undefined;
      const filters: [string, unknown][] = [];
      const query = {
        select() { return query; },
        is() { return query; },
        in() { return query; },
        eq(key: string, value: unknown) { filters.push([key, value]); return query; },
        update(value: Record<string, unknown>) { update = value; return query; },
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          if (errors.has(`${table}:throw`)) return Promise.reject(new Error("injected lookup throw")).then(resolve, reject);
          const operation = update ? `${table}:update` : table;
          if (errors.has(operation)) return Promise.resolve({ data: null, error: { message: "injected" } }).then(resolve, reject);
          let rows: Record<string, unknown>[] = table === "users" ? users :
            table === "push_subscriptions" ? subscriptions.filter((s) => !s.deleted_at) : [{ id: "machine-1", name: "Tractor" }];
          rows = rows.filter((row) => filters.every(([key, value]) => row[key] === value));
          if (update) for (const row of rows) Object.assign(row, update);
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return {
    notes, users, subscriptions, calls, finished, errors, sent,
    setTime(value: number) { now = value; },
    setSender(value: typeof sender) { sender = value; },
    run: () => deliverPush(client, {
      config: () => ({ publicKey: "stub", privateKey: "stub", subject: "mailto:test@example.test" }),
      now: () => now,
      send: async (device, payload) => {
        sent.push({ id: (device as Subscription).id, payload });
        return { statusCode: await sender(device as Subscription) };
      },
    }),
    client,
  };
}

test("unconfigured push leaves the queue untouched", async () => {
  const f = fixture();
  const result = await deliverPush(f.client, { config: () => null, now: () => 0, send: async () => { throw new Error("must not send"); } });
  assert.equal(result.skipped, "vapid-not-configured");
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls, []);
});

test("claim failures report failure without reading or sending", async () => {
  const f = fixture();
  f.errors.add("claim_notification_push");
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.error, "claim-failed");
  assert.equal(f.sent.length, 0);
  assert.equal(f.calls[0].args.p_limit, 25);
});

for (const table of ["users", "push_subscriptions", "machines", "users:throw"]) {
  test(`${table} lookup failure retains every claimed notification`, async () => {
    const f = fixture([note("a", "service_due_soon", { machine_id: "machine-1" }), note("b")]);
    f.errors.add(table);
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.error, "lookup-failed");
    assert.equal(result.deferred, 2);
    assert.equal(f.sent.length, 0);
    assert.equal(f.finished.size, 0);
    assert.deepEqual(f.calls.filter((c) => c.name === "finish_notification_push").map((c) => c.args.p_terminal), [false, false]);
  });
}

test("partial provider failure retries only the device not already accepted", async () => {
  const f = fixture();
  f.setSender(async (device) => device.id === "device-1" ? 201 : 503);
  const first = await f.run();
  assert.equal(first.ok, false);
  assert.equal(first.pushed, 1);
  assert.equal(first.deferred, 1);
  assert.equal(f.finished.size, 0);
  assert.deepEqual(f.notes[0].delivered_subscription_ids, ["device-1"]);
  f.setSender(async () => 201);
  const second = await f.run();
  assert.equal(second.ok, true);
  assert.equal(second.pushed, 1);
  assert.deepEqual(f.sent.map((s) => s.id), ["device-1", "device-2", "device-2"]);
  assert.deepEqual([...f.finished], ["note-1"]);
  const firstClaim = f.calls.find((c) => c.name === "claim_notification_push")!.args.p_claim_id;
  assert.ok(f.calls.filter((c) => c.name === "ack_notification_push").some((c) => c.args.p_claim_id === firstClaim));
});

for (const status of [401, 403, 429, 500]) {
  test(`provider ${status} remains retryable`, async () => {
    const f = fixture();
    f.setSender(async () => status);
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.deferred, 1);
    assert.equal(f.finished.size, 0);
    assert.ok(f.subscriptions.every((s) => !s.deleted_at));
  });
}

test("provider network exceptions remain queued", async () => {
  const f = fixture();
  f.setSender(async () => { throw new Error("timeout"); });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.deferred, 1);
  assert.equal(f.finished.size, 0);
});

test("expired and invalid devices are pruned before delivery becomes terminal", async () => {
  const f = fixture();
  f.subscriptions[0].endpoint = "https://127.0.0.1/internal";
  f.setSender(async () => 410);
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.pruned, 2);
  assert.equal(f.sent.length, 1);
  assert.ok(f.subscriptions.every((s) => s.deleted_at));
  assert.equal(f.finished.size, 1);
});

test("failed device pruning must not mark a notification sent", async () => {
  const f = fixture();
  f.errors.add("push_subscriptions:update");
  f.setSender(async () => 404);
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.deferred, 1);
  assert.equal(result.pruned, 0);
  assert.equal(f.finished.size, 0);
});

for (const operation of ["ack_notification_push", "finish_notification_push"]) {
  test(`${operation} persistence failure is visible and preserves retry`, async () => {
    const f = fixture();
    f.errors.add(operation);
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.deferred, 1);
    assert.equal(f.finished.size, 0);
  });
}

for (const terminal of ["opted-out", "inactive", "deleted", "no-devices"]) {
  test(`${terminal} recipient is terminal after successful lookup`, async () => {
    const f = fixture();
    if (terminal === "opted-out") f.users[0].notify_push = false;
    if (terminal === "inactive") f.users[0].active = false;
    if (terminal === "deleted") f.users.length = 0;
    if (terminal === "no-devices") f.subscriptions.length = 0;
    const result = await f.run();
    assert.equal(result.ok, true);
    assert.equal(f.sent.length, 0);
    assert.equal(f.finished.size, 1);
  });
}

test("run budget retains unfinished devices and unstarted notifications", async () => {
  const f = fixture([note("a"), note("b")]);
  f.setSender(async () => { f.setTime(25_000); return 201; });
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.pushed, 1);
  assert.equal(result.deferred, 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.finished.size, 0);
});

test("monetary and billing messages never put financial snapshots on a lockscreen", async () => {
  const f = fixture([
    note("a", "job_completed", { machine_name: "Secret asset", total_cents: 987654 }),
    note("b", "partner_invoice_received", { number: "Private invoice", amount_cents: 987654 }),
    note("c", "billing_card_expiring", { last4: "6789", card_brand: "Visa", expires_on: "2028-12-31" }),
    note("d", "fault_reported", { description: "Private amount in text", total: 987654 }),
  ]);
  const result = await f.run();
  assert.equal(result.ok, true);
  for (const { payload } of f.sent) {
    const message = payload as { title: string; body: string; tag: string };
    assert.equal(message.body, message.title);
    assert.doesNotMatch(JSON.stringify(message), /Secret asset|Private invoice|6789|987654|Private amount/);
    assert.ok(message.tag);
  }
});

test("operational notifications retain translated details and a stable tag", async () => {
  const f = fixture([note("service", "service_due_soon", { machine_id: "machine-1", task: "Oil filter" })]);
  const result = await f.run();
  assert.equal(result.ok, true);
  const message = f.sent[0].payload as { body: string; url: string; tag: string };
  assert.match(message.body, /Tractor/);
  assert.match(message.body, /Oil filter/);
  assert.equal(message.url, "/machines/machine-1");
  assert.equal(message.tag, "service");
});
