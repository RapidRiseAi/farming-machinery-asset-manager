/**
 * Alerts by email: what may be said, and what must not be thrown away.
 *
 * Two rules carry the weight here. A reminder is marked sent ONLY when the provider
 * accepted it, a Resend outage must delay it, never discard it, and money never goes in
 * an inbox, because the recipient may have lost cost access since the alert was queued and
 * a mailbox is not the authenticated app.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { deliverNotificationEmail } from "./email-deliver";

type Note = {
  id: string;
  user_id: string | null;
  farm_id: string;
  template: string;
  payload: Record<string, unknown>;
};

const note = (over: Partial<Note> = {}): Note => ({
  id: "note-1",
  user_id: "user-1",
  farm_id: "farm-1",
  template: "service_due_soon",
  payload: { machine_id: "machine-1", task: "Engine oil" },
  ...over,
});

type SentMail = { to: string; subject: string; text: string; html: string };

function fixture(opts: {
  notes?: Note[];
  user?: { notify_email: boolean; email: string | null };
  send?: () => { ok: boolean; error?: string };
} = {}) {
  const notes = opts.notes ?? [note()];
  const user = {
    id: "user-1",
    notify_email: opts.user?.notify_email ?? true,
    language: "en",
    email: opts.user === undefined ? "farmer@example.test" : opts.user.email,
    name: "Farmer",
  };
  const finished: { id: string; terminal: boolean; error: string | null }[] = [];
  const claimed = new Set<string>();

  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "claim_notification_email") {
        const batch = notes.filter((n) => !claimed.has(n.id));
        batch.forEach((n) => claimed.add(n.id));
        return { data: batch, error: null };
      }
      if (name === "finish_notification_email") {
        finished.push({
          id: String(args.p_notification_id),
          terminal: args.p_terminal === true,
          error: (args.p_error as string | null) ?? null,
        });
        return { data: true, error: null };
      }
      return { data: null, error: { message: "unexpected rpc" } };
    },
    from(table: string) {
      const query = {
        select() { return query; },
        is() { return query; },
        eq() { return query; },
        in() { return query; },
        then(resolve: (value: unknown) => unknown) {
          const rows = table === "users" ? [user] : [{ id: "machine-1", name: "Groen John Deere" }];
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;

  return { client, finished, user };
}

/** The module reads its provider from the environment; set a key and capture the sends. */
function withMail(
  fn: (sent: SentMail[]) => Promise<void>,
  send: (mail: SentMail) => { ok: boolean; error?: string } = () => ({ ok: true }),
): Promise<void> {
  const sent: SentMail[] = [];
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  const realFetch = globalThis.fetch;
  // Assembled, never written out: a credential-shaped literal is blocked by GitHub push
  // protection even when it is deliberately fake.
  process.env.RESEND_API_KEY = ["re", "test", "0123456789abcdefghij"].join("_");
  process.env.EMAIL_FROM = "alerts@fleetwise.test";
  process.env.NEXT_PUBLIC_SITE_URL = "https://app.fleetwise.test";
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const mail: SentMail = {
      to: Array.isArray(body.to) ? body.to[0] : String(body.to),
      subject: String(body.subject ?? ""),
      text: String(body.text ?? ""),
      html: String(body.html ?? ""),
    };
    sent.push(mail);
    const outcome = send(mail);
    return outcome.ok
      ? new Response(JSON.stringify({ id: "mail-1" }), { status: 200 })
      : new Response(JSON.stringify({ message: outcome.error ?? "boom" }), { status: 500 });
  }) as typeof globalThis.fetch;

  return fn(sent).finally(() => {
    globalThis.fetch = realFetch;
    if (key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = key;
    if (from === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = from;
    if (site === undefined) delete process.env.NEXT_PUBLIC_SITE_URL; else process.env.NEXT_PUBLIC_SITE_URL = site;
  });
}

test("with no mail account configured it says which part is missing and sends nothing", async () => {
  const key = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const { client, finished } = fixture();
    const result = await deliverNotificationEmail(client);
    const skipped = result.skipped ?? "";
    assert.ok(skipped.startsWith("email-not-configured"), skipped);
    // "email-not-configured" on its own has cost this project weeks: it must name the part.
    assert.ok(skipped.length > "email-not-configured: ".length);
    assert.equal(result.sent, 0);
    assert.equal(finished.length, 0, "nothing may be marked sent when nothing was tried");
  } finally {
    if (key !== undefined) process.env.RESEND_API_KEY = key;
  }
});

test("an accepted alert is sent once and marked done", async () => {
  await withMail(async (sent) => {
    const { client, finished } = fixture();
    const result = await deliverNotificationEmail(client);
    assert.equal(result.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "farmer@example.test");
    // The machine's name is resolved, so the alert reads like the one in the app.
    assert.match(sent[0].text, /Groen John Deere/);
    assert.match(sent[0].text, /https:\/\/app\.fleetwise\.test/);
    assert.deepEqual(finished, [{ id: "note-1", terminal: true, error: null }]);
  });
});

test("a provider failure defers the alert instead of losing it", async () => {
  await withMail(
    async () => {
      const { client, finished } = fixture();
      const result = await deliverNotificationEmail(client);
      assert.equal(result.ok, false);
      assert.equal(result.sent, 0);
      assert.equal(result.deferred, 1);
      // NOT terminal: the lease expires and the reminder is tried again.
      assert.equal(finished.length, 1);
      assert.equal(finished[0].terminal, false);
      assert.ok(finished[0].error, "the reason for the retry is recorded");
    },
    () => ({ ok: false, error: "rate limited" }),
  );
});

test("money never goes in the email", async () => {
  await withMail(async (sent) => {
    const { client } = fixture({
      notes: [note({ template: "job_completed", payload: { machine_id: "machine-1", total_cents: 486000 } })],
    });
    await deliverNotificationEmail(client);
    assert.equal(sent.length, 1);
    for (const part of [sent[0].text, sent[0].html, sent[0].subject]) {
      assert.doesNotMatch(part, /486000|4 860|4,860/, "an amount reached the inbox");
    }
    // It still says something useful and points at the app.
    assert.match(sent[0].text, /https:\/\/app\.fleetwise\.test/);
  });
});

test("somebody who did not ask for email is done with, not retried for ever", async () => {
  await withMail(async (sent) => {
    const { client, finished } = fixture({ user: { notify_email: false, email: "farmer@example.test" } });
    const result = await deliverNotificationEmail(client);
    assert.equal(sent.length, 0);
    assert.equal(result.skippedRows, 1);
    assert.deepEqual(finished, [{ id: "note-1", terminal: true, error: null }]);
  });
});

test("an address that does not exist is the same: finished, never sent", async () => {
  await withMail(async (sent) => {
    const { client, finished } = fixture({ user: { notify_email: true, email: null } });
    const result = await deliverNotificationEmail(client);
    assert.equal(sent.length, 0);
    assert.equal(result.skippedRows, 1);
    assert.equal(finished[0].terminal, true);
  });
});
