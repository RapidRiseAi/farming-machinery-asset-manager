import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeliverResult } from "@/lib/push/deliver";
import type { EmailDeliverResult } from "@/lib/notifications/email-deliver";
import { drainNotifications } from "./drain-delivery";

const db = {} as SupabaseClient;

/** A channel with `total` queued, handing out 25 a pass, each pass taking `passMs`. */
function channels(pushTotal: number, emailTotal: number, passMs: number, clock: { t: number }) {
  let pushLeft = pushTotal;
  let emailLeft = emailTotal;
  const calls = { push: 0, email: 0 };
  return {
    calls,
    push: async (): Promise<DeliverResult> => {
      calls.push += 1;
      clock.t += passMs;
      const n = Math.min(25, pushLeft);
      pushLeft -= n;
      return { ok: true, scanned: n, pushed: n, failed: 0, pruned: 0, deferred: 0 };
    },
    email: async (): Promise<EmailDeliverResult> => {
      calls.email += 1;
      clock.t += passMs;
      const n = Math.min(25, emailLeft);
      emailLeft -= n;
      return { ok: true, scanned: n, sent: n, failed: 0, skippedRows: 0, deferred: 0 };
    },
  };
}

test("drains both queues past 25, stopping each channel at its short pass", async () => {
  const clock = { t: 0 };
  const c = channels(60, 10, 100, clock);
  const r = await drainNotifications(db, 60_000, { push: c.push, email: c.email, now: () => clock.t });
  assert.equal(r.push.pushed, 60);
  assert.equal(r.email.sent, 10);
  assert.equal(r.rounds, 3);
  assert.equal(r.more, false);
  assert.deepEqual(c.calls, { push: 3, email: 1 });
});

test("starts a round only when a whole pass still fits, and says more is waiting", async () => {
  const clock = { t: 0 };
  const c = channels(1_000, 0, 10_000, clock);
  // Round 1 runs at 0 s and ends at 20 s (push 10 s, email 10 s); round 2 starts because
  // 20 + 25 <= 60; it ends at 30 s (email is done); 30 + 25 <= 60, round 3 runs to 40 s;
  // 40 + 25 > 60, so no round 4.
  const r = await drainNotifications(db, 60_000, { push: c.push, email: c.email, now: () => clock.t });
  assert.equal(r.rounds, 3);
  assert.equal(r.push.pushed, 75);
  assert.equal(r.more, true);
});

test("a channel that is not configured or fails its claim stops; the other carries on", async () => {
  const clock = { t: 0 };
  let emails = 0;
  const r = await drainNotifications(db, 60_000, {
    push: async () => ({ ok: true, skipped: "vapid-not-configured", scanned: 0, pushed: 0, failed: 0, pruned: 0, deferred: 0 }),
    email: async () => {
      emails += 1;
      clock.t += 100;
      return emails === 1
        ? { ok: true, scanned: 25, sent: 25, failed: 0, skippedRows: 0, deferred: 0 }
        : { ok: false, error: "claim-failed", scanned: 0, sent: 0, failed: 1, skippedRows: 0, deferred: 0 };
    },
    now: () => clock.t,
  });
  assert.equal(r.push.skipped, "vapid-not-configured");
  assert.equal(emails, 2);
  assert.equal(r.email.sent, 25);
  assert.equal(r.ok, false);
  assert.equal(r.email.error, "claim-failed");
  assert.equal(r.more, false);
});

test("a channel that throws stops only itself: email still goes out", async () => {
  const clock = { t: 0 };
  const r = await drainNotifications(db, 60_000, {
    push: async () => { throw new Error("vapid exploded"); },
    email: async () => ({ ok: true, scanned: 3, sent: 3, failed: 0, skippedRows: 0, deferred: 0 }),
    now: () => clock.t,
  });
  assert.equal(r.email.sent, 3);
  assert.equal(r.push.ok, false);
  assert.equal(r.push.error, "vapid exploded");
  assert.equal(r.push.failed, 1);
  assert.equal(r.ok, false);
  assert.equal(r.more, false);
});
