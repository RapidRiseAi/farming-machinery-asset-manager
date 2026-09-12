/**
 * What the nightly billing pass SAYS when it cannot send.
 *
 * The billing cron renders these `reasons` into its step summary and, since
 * `20260912120000`, into the `cron_runs` ledger. For weeks that line read
 * `receipts: skipped (email-not-configured)` — which is true, unactionable, and points at
 * the wrong thing: the fault was not a missing key but `[SENSITIVE]`, the literal string
 * `vercel pull` writes for a secret it cannot decrypt, which is perfectly truthy.
 *
 * These two tests are the difference between a nightly line nobody can act on and one that
 * diagnoses the deployment by itself.
 *
 * Neither touches a database: with the configuration unusable both senders return before
 * the Supabase client is used at all, which is itself worth pinning — a pass that cannot
 * send should not be querying for work first.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendDueReceipts, sendDueFailureNotices } from "./receipt";

/** Any use of this is a test failure: nothing should be queried before the config check. */
const NO_DATABASE = new Proxy(
  {},
  {
    get() {
      throw new Error("the sender reached for the database before checking its configuration");
    },
  },
) as unknown as SupabaseClient;

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return fn().finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test("a placeholder key is reported as a placeholder, not as 'unset'", async () => {
  await withEnv(
    { RESEND_API_KEY: "[SENSITIVE]", EMAIL_FROM: "team@rapidriseai.com" },
    async () => {
      const receipts = await sendDueReceipts(NO_DATABASE);
      assert.equal(receipts.skipped, 1);
      assert.equal(receipts.sent, 0);
      assert.match(receipts.reasons[0] ?? "", /email-not-configured: .*placeholder/);

      // The failure-notice sender is a separate function with the same guard; one being
      // right has never implied the other is.
      const notices = await sendDueFailureNotices(NO_DATABASE);
      assert.equal(notices.skipped, 1);
      assert.match(notices.reasons[0] ?? "", /email-not-configured: .*placeholder/);
    },
  );
});

test("a missing FROM address is named too — it was never checked at all", async () => {
  await withEnv(
    { RESEND_API_KEY: "re_" + "MFf4abcdefghijklmnopqrstuvwxyz", EMAIL_FROM: undefined },
    async () => {
      const receipts = await sendDueReceipts(NO_DATABASE);
      assert.equal(receipts.skipped, 1);
      assert.match(receipts.reasons[0] ?? "", /EMAIL_FROM is not set/);
    },
  );
});
