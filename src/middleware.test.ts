import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { config, middleware } from "./middleware";
import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";

/**
 * Every response the middleware sends carries the enforced policy, and every page it lets
 * through receives the same policy and nonce as request headers (Next reads its nonce from
 * the first, the root layout reads the second). No network: with no session cookie Supabase
 * answers "no session" without calling Auth.
 */

const ENV = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_TURNSTILE_SITE_KEY", "PAYFAST_SANDBOX"] as const;

async function run(path: string, env: Partial<Record<(typeof ENV)[number], string>>, init?: { headers?: Record<string, string> }) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return await middleware(new NextRequest(`http://localhost:3210${path}`, init));
  } finally {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const SUPABASE = { NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key" };

/** The policy on the response, and what the page was handed. */
function read(response: Response) {
  const policy = response.headers.get("content-security-policy");
  assert.ok(policy, "no Content-Security-Policy on the response");
  assert.equal(response.headers.get("content-security-policy-report-only"), null);
  return {
    policy,
    nonce: getScriptNonceFromHeader(policy),
    forwardedPolicy: response.headers.get("x-middleware-request-content-security-policy"),
    forwardedNonce: response.headers.get("x-middleware-request-x-nonce"),
  };
}

test("a page that is let through gets the policy, and the page gets the same nonce", async () => {
  for (const env of [{}, SUPABASE]) {
    const response = await run("/login", env);
    assert.equal(response.status, 200);
    const got = read(response);
    assert.ok(got.nonce, got.policy);
    assert.equal(got.forwardedPolicy, got.policy);
    assert.equal(got.forwardedNonce, got.nonce);
    // The existing request header is still set.
    assert.equal(response.headers.get("x-middleware-request-x-fw-path"), "/login");
  }
});

test("the sign-in redirect carries the policy too", async () => {
  const response = await run("/dashboard?x=1", SUPABASE);
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("location") ?? "").pathname, "/login");
  read(response);
});

test("a nonce or policy a client sends is replaced", async () => {
  const response = await run("/login", SUPABASE, {
    headers: { "x-nonce": "AAAAAAAAAAAAAAAAAAAAAA==", "content-security-policy": "script-src 'nonce-AAAAAAAAAAAAAAAAAAAAAA=='" },
  });
  const got = read(response);
  assert.notEqual(got.forwardedNonce, "AAAAAAAAAAAAAAAAAAAAAA==");
  assert.equal(got.forwardedNonce, got.nonce);
  assert.equal(got.forwardedPolicy, got.policy);
});

test("every request gets its own nonce", async () => {
  const a = read(await run("/login", {})).nonce;
  const b = read(await run("/login", {})).nonce;
  assert.notEqual(a, b);
});

test("Cloudflare and PayFast's sandbox follow the environment", async () => {
  const off = read(await run("/login", SUPABASE)).policy;
  assert.equal(off.includes("challenges.cloudflare.com"), false);
  assert.equal(off.includes("sandbox.payfast.co.za"), false);
  const on = read(await run("/login", { ...SUPABASE, NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAAAAAAtestSITEnotReal", PAYFAST_SANDBOX: "1" })).policy;
  assert.match(on, /script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(on, /form-action [^;]*https:\/\/sandbox\.payfast\.co\.za/);
  const blank = read(await run("/login", { ...SUPABASE, NEXT_PUBLIC_TURNSTILE_SITE_KEY: "  " })).policy;
  assert.equal(blank.includes("challenges.cloudflare.com"), false, "a blank key is no key");
});

test("security.txt is served signed out, and pages are matched while build files are not", async () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  for (const path of ["/.well-known/security.txt", "/login", "/dashboard", "/offline", "/api/csp-report"]) {
    assert.ok(matcher.test(path), `${path} should pass through the middleware`);
  }
  for (const path of ["/_next/static/chunks/main.js", "/sw.js", "/icon-192.png"]) {
    assert.equal(matcher.test(path), false, `${path} should skip the middleware`);
  }
  const response = await run("/.well-known/security.txt", SUPABASE);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
});
