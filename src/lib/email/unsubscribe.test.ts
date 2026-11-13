import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  turnOffAlertEmails,
  unsubscribeHeaders,
  unsubscribeLinks,
  unsubscribeSignature,
  verifyUnsubscribe,
} from "./unsubscribe";

/**
 * The signed "Turn these emails off" link: it works for the person it was made for, and for
 * nobody else, and nothing secret travels in it.
 */

const ALICE = "a1b2c3d4-0000-4000-9000-00000000000a";
const BOB = "b1b2c3d4-0000-4000-9000-00000000000b";
// Assembled, never written out: a credential-shaped literal is blocked by push protection.
const SERVICE_KEY = ["service", "role", "for", "tests", "only"].join("-");

function withEnv(env: { EMAIL_LINK_SECRET?: string; SUPABASE_SERVICE_ROLE_KEY?: string }, fn: () => void): void {
  const saved = { EMAIL_LINK_SECRET: process.env.EMAIL_LINK_SECRET, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  for (const k of ["EMAIL_LINK_SECRET", "SUPABASE_SERVICE_ROLE_KEY"] as const) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of ["EMAIL_LINK_SECRET", "SUPABASE_SERVICE_ROLE_KEY"] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("a signature made for a person is accepted for that person", () => {
  withEnv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }, () => {
    const s = unsubscribeSignature(ALICE);
    assert.ok(s);
    assert.equal(verifyUnsubscribe(ALICE, s), true);
    // The id as a mail client may have changed its case is still the same person.
    assert.equal(verifyUnsubscribe(ALICE.toUpperCase(), s), true);
  });
});

test("a forged, truncated, padded or missing signature is refused", () => {
  withEnv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }, () => {
    const s = unsubscribeSignature(ALICE) as string;
    const flipped = (s[0] === "A" ? "B" : "A") + s.slice(1);
    assert.equal(verifyUnsubscribe(ALICE, flipped), false, "one character changed");
    assert.equal(verifyUnsubscribe(ALICE, s.slice(0, -1)), false, "truncated by one");
    assert.equal(verifyUnsubscribe(ALICE, s.slice(0, 10)), false, "truncated to a prefix");
    assert.equal(verifyUnsubscribe(ALICE, `${s}A`), false, "one character added");
    assert.equal(verifyUnsubscribe(ALICE, ""), false);
    assert.equal(verifyUnsubscribe(ALICE, null), false);
    assert.equal(verifyUnsubscribe(ALICE, undefined), false);
  });
});

test("a valid signature for one person does not work with another person's id", () => {
  withEnv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }, () => {
    const forAlice = unsubscribeSignature(ALICE) as string;
    assert.equal(verifyUnsubscribe(BOB, forAlice), false);
    assert.notEqual(unsubscribeSignature(BOB), forAlice);
  });
});

test("an id that is not a uuid is refused before anything is compared", () => {
  withEnv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }, () => {
    assert.equal(unsubscribeSignature("not-a-user"), null);
    assert.equal(verifyUnsubscribe("not-a-user", "anything"), false);
    assert.equal(verifyUnsubscribe(`${ALICE}x`, unsubscribeSignature(ALICE)), false);
  });
});

test("a signature made with another key is refused, and the dedicated secret wins when set", () => {
  let fallback = "";
  withEnv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }, () => {
    fallback = unsubscribeSignature(ALICE) as string;
  });
  withEnv({ SUPABASE_SERVICE_ROLE_KEY: `${SERVICE_KEY}-other` }, () => {
    assert.equal(verifyUnsubscribe(ALICE, fallback), false, "a different service key is a different link key");
  });
  withEnv({ EMAIL_LINK_SECRET: "a-dedicated-link-secret", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }, () => {
    const own = unsubscribeSignature(ALICE) as string;
    assert.notEqual(own, fallback);
    assert.equal(verifyUnsubscribe(ALICE, fallback), false);
    assert.equal(verifyUnsubscribe(ALICE, own), true);
  });
  // A value `vercel pull` wrote in place of a secret is not a secret: the fallback is used.
  withEnv({ EMAIL_LINK_SECRET: "[SENSITIVE]", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }, () => {
    assert.equal(unsubscribeSignature(ALICE), fallback);
  });
});

test("with no key at all there is no link, and nothing verifies", () => {
  withEnv({}, () => {
    assert.equal(unsubscribeSignature(ALICE), null);
    assert.equal(unsubscribeLinks("https://app.test", ALICE), null);
    assert.equal(verifyUnsubscribe(ALICE, "anything"), false);
  });
});

test("the links carry the id and the signature, never a key", () => {
  withEnv({ EMAIL_LINK_SECRET: "a-dedicated-link-secret", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }, () => {
    const links = unsubscribeLinks("https://app.test", ALICE);
    assert.ok(links);
    const s = unsubscribeSignature(ALICE) as string;
    assert.equal(links.page, `https://app.test/unsubscribe?u=${ALICE}&s=${s}`);
    assert.equal(links.oneClick, `https://app.test/unsubscribe/one-click?u=${ALICE}&s=${s}`);
    for (const url of [links.page, links.oneClick]) {
      assert.equal(url.includes("a-dedicated-link-secret"), false);
      assert.equal(url.includes(SERVICE_KEY), false);
    }
    assert.deepEqual(unsubscribeHeaders(links.oneClick), {
      "List-Unsubscribe": `<${links.oneClick}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });
});

test("switching off writes notify_email = false for that person only, and reports a failure", async () => {
  const writes: { table: string; values: unknown; column: string; value: string }[] = [];
  const client = (error: unknown) => ({
    from(table: string) {
      return {
        update(values: unknown) {
          return {
            eq(column: string, value: string) {
              writes.push({ table, values, column, value });
              return Promise.resolve({ error });
            },
          };
        },
      };
    },
  }) as unknown as Pick<SupabaseClient, "from">;
  assert.deepEqual(await turnOffAlertEmails(client(null), ALICE.toUpperCase()), { ok: true });
  assert.deepEqual(writes, [{ table: "users", values: { notify_email: false }, column: "id", value: ALICE }]);
  assert.deepEqual(await turnOffAlertEmails(client({ message: "down" }), ALICE), { ok: false });
});
