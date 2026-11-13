import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { SIGN_IN_LIMITS, limiterSubject, takeSignInAttempt } from "./sign-in-throttle";

const EMAIL = "Owner.Person@Example.test";
const IP = "203.0.113.9";

type Args = { p_scope: string; p_subject: string; p_window_seconds: number; p_max: number };

/** A service client whose counter answers per scope. */
function counter(answer: (args: Args) => { data: unknown; error: unknown } | Promise<never>) {
  const calls: Array<{ fn: string; args: Args }> = [];
  const svc = {
    rpc: async (fn: string, args: Args) => {
      calls.push({ fn, args });
      return answer(args);
    },
  } as unknown as Pick<SupabaseClient, "rpc">;
  return { svc, calls };
}

const allow = () => ({ data: [{ allowed: true, retry_after: 600 }], error: null });
const refuseScope = (scope: string) => (args: Args) =>
  ({ data: [{ allowed: args.p_scope !== scope, retry_after: 600 }], error: null });

test("an attempt under both limits goes on, counted against the address and the IP", async () => {
  const c = counter(allow);
  assert.equal(await takeSignInAttempt(c.svc, { kind: "password", email: EMAIL, ip: IP }), true);
  assert.deepEqual(
    c.calls.map(({ fn, args }) => [fn, args.p_scope, args.p_window_seconds, args.p_max]),
    [
      ["rate_limit_take_key", "signin_password", 900, 8],
      ["rate_limit_take_key", "signin_ip", 900, 30],
    ],
  );
  assert.deepEqual(SIGN_IN_LIMITS, { address: { windowSeconds: 900, max: 8 }, ip: { windowSeconds: 900, max: 30 } });
  // The link and the reset count as "email", apart from password guesses.
  const e = counter(allow);
  await takeSignInAttempt(e.svc, { kind: "email", email: EMAIL, ip: IP });
  assert.equal(e.calls[0].args.p_scope, "signin_email");
});

test("over the address limit, or over the IP limit, the attempt is refused", async () => {
  for (const scope of ["signin_password", "signin_ip"]) {
    const c = counter(refuseScope(scope));
    assert.equal(await takeSignInAttempt(c.svc, { kind: "password", email: EMAIL, ip: IP }), false, scope);
  }
});

test("the counter's key holds no address and no IP, only a digest", async () => {
  const c = counter(allow);
  await takeSignInAttempt(c.svc, { kind: "password", email: EMAIL, ip: IP });
  const sent = JSON.stringify(c.calls).toLowerCase();
  for (const raw of [EMAIL, "owner.person", "example.test", IP]) {
    assert.equal(sent.includes(raw.toLowerCase()), false, `the counter was sent ${raw}`);
  }
  for (const { args } of c.calls) assert.match(args.p_subject, /^[0-9a-f]{64}$/);
  // One person, however they type their address, is one count.
  assert.equal(limiterSubject(" owner.person@example.TEST "), limiterSubject(EMAIL));
  assert.notEqual(limiterSubject("someone.else@example.test"), limiterSubject(EMAIL));
  // The address and the IP never share a key.
  assert.notEqual(c.calls[0].args.p_subject, c.calls[1].args.p_subject);
});

test("a counter that cannot be read lets the attempt through (fails open)", async () => {
  const errored = counter(() => ({ data: null, error: { message: "function rate_limit_take_key does not exist" } }));
  assert.equal(await takeSignInAttempt(errored.svc, { kind: "password", email: EMAIL, ip: IP }), true);
  const threw = counter(() => Promise.reject(new Error("socket hang up")));
  assert.equal(await takeSignInAttempt(threw.svc, { kind: "email", email: EMAIL, ip: IP }), true);
});

test("no IP known: only the address is counted, nobody shares an 'unknown' bucket", async () => {
  const c = counter(allow);
  assert.equal(await takeSignInAttempt(c.svc, { kind: "password", email: EMAIL, ip: null }), true);
  assert.deepEqual(c.calls.map((x) => x.args.p_scope), ["signin_password"]);
});

/** The body of one top-level function in a source file, after its signature. */
function fnBody(text: string, signature: string): string {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start + signature.length, end);
}

test("a refused sign-in never reaches Supabase Auth", () => {
  const actions = readFileSync(join(process.cwd(), "src/app/(auth)/login/actions.ts"), "utf8");
  for (const [signature, kind] of [
    ["export async function signInWithPassword(", "password"],
    ["export async function signInWithMagicLink(", "email"],
    ["export async function sendPasswordReset(", "email"],
  ] as const) {
    const body = fnBody(actions, signature);
    const limit = body.indexOf(`await signInLimit("${kind}", email)`);
    const auth = Math.min(...[body.indexOf("createClient()"), body.indexOf(".auth.")].filter((i) => i >= 0));
    assert.ok(limit >= 0, `${signature} does not take a sign-in attempt of kind ${kind}`);
    assert.ok(limit < auth, `${signature} calls Supabase Auth before the limit`);
    // Refused means sent back at once, with the code the login page translates.
    assert.match(body.slice(limit), /^await signInLimit\("\w+", email\)\);\s*if \(refused\) redirect\(/);
  }
  const page = readFileSync(join(process.cwd(), "src/app/(auth)/login/page.tsx"), "utf8");
  assert.ok(page.includes('raw === "signin-busy"') && page.includes('t("errors.signinBusy", locale)'));
});
