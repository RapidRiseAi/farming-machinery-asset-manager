/**
 * The configuration guard, and the placeholder that defeated it.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * `emailConfigured()` was `Boolean(process.env.RESEND_API_KEY)`. `vercel pull` CANNOT
 * decrypt secrets — it writes the literal string `[SENSITIVE]` — and `"[SENSITIVE]"` is
 * truthy. So the product reported that email was configured, Resend rejected every call,
 * and the nightly billing pass stamped `receipt_sent_at` on six invoices whose receipts
 * had never left the building. It stayed that way for weeks.
 *
 * Nothing else could have caught it. Typecheck sees a string. The suite tests the
 * database. The build compiles. The only place the truth existed was the provider's
 * response, which nobody was reading.
 *
 * So the first test here is the literal value `vercel pull` writes, and the last is the
 * positive control — a key and address shaped like the real ones must still be accepted,
 * or a guard this strict would simply switch email off.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { emailConfigProblem, emailConfigured, sendEmail } from "./resend";

/** Run with a specific environment, and always put the old one back. */
function withEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const GOOD_KEY = "re_" + "MFf4abcdefghijklmnopqrstuvwxyz";
const GOOD_FROM = "team@rapidriseai.com";

test("the exact placeholder `vercel pull` writes is refused", () => {
  withEnv({ RESEND_API_KEY: "[SENSITIVE]", EMAIL_FROM: GOOD_FROM }, () => {
    assert.equal(emailConfigured(), false);
    assert.match(emailConfigProblem() ?? "", /placeholder/);
  });
  // And the same for the address, which was never checked at all.
  withEnv({ RESEND_API_KEY: GOOD_KEY, EMAIL_FROM: "[SENSITIVE]" }, () => {
    assert.equal(emailConfigured(), false);
    assert.match(emailConfigProblem() ?? "", /EMAIL_FROM is a placeholder/);
  });
});

test("a missing key or address is named, not just refused", () => {
  withEnv({ RESEND_API_KEY: undefined, EMAIL_FROM: GOOD_FROM }, () => {
    assert.equal(emailConfigProblem(), "RESEND_API_KEY is not set");
  });
  // EMAIL_FROM was previously unchecked, so a send went out with `from: undefined` and was
  // rejected by the provider once per message instead of once at startup.
  withEnv({ RESEND_API_KEY: GOOD_KEY, EMAIL_FROM: undefined }, () => {
    assert.equal(emailConfigProblem(), "EMAIL_FROM is not set");
  });
});

test("a key that is not a Resend key is refused", () => {
  for (const key of ["sk_test_abcdefghijklmnopqrst", "not-a-key", "re_short", "re_ has space xxxxxxxxxx"]) {
    withEnv({ RESEND_API_KEY: key, EMAIL_FROM: GOOD_FROM }, () => {
      assert.equal(emailConfigured(), false, `expected ${key} to be refused`);
    });
  }
});

test("an address that is not an address is refused", () => {
  for (const from of ["team", "team@", "@rapidriseai.com", "team@rapidriseai", "a b@c.com"]) {
    withEnv({ RESEND_API_KEY: GOOD_KEY, EMAIL_FROM: from }, () => {
      assert.equal(emailConfigured(), false, `expected ${from} to be refused`);
    });
  }
});

test("sendEmail refuses on its own, and says why", async () => {
  // The guard has to live in `sendEmail` too: it is reachable directly, and a check that
  // exists only at the call sites is one somebody will forget to copy.
  await withEnv({ RESEND_API_KEY: "[SENSITIVE]", EMAIL_FROM: GOOD_FROM }, async () => {
    const spy = () => {
      throw new Error("sendEmail made a network call with an unusable configuration");
    };
    const original = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const r = await sendEmail({
        to: "someone@example.invalid",
        from: GOOD_FROM,
        subject: "x",
        html: "x",
        text: "x",
      });
      assert.equal(r.ok, false);
      assert.match(r.ok === false ? r.error : "", /email-not-configured: .*placeholder/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

test("the real shape is still accepted — the control", () => {
  // Without this, a guard that refused everything would look like a pass.
  withEnv({ RESEND_API_KEY: GOOD_KEY, EMAIL_FROM: GOOD_FROM }, () => {
    assert.equal(emailConfigProblem(), null);
    assert.equal(emailConfigured(), true);
  });
});
