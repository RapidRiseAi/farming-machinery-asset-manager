import assert from "node:assert/strict";
import test from "node:test";

import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";

import {
  buildContentSecurityPolicy,
  createNonce,
  MAP_TILES_ORIGIN,
  PAYFAST_ORIGIN,
  PAYFAST_SANDBOX_ORIGIN,
  PAYSTACK_CHECKOUT_ORIGIN,
  TURNSTILE_ORIGIN,
} from "./csp";

const NONCE = "dGVzdC1ub25jZS0xMjM0NQ==";
const SUPABASE = "https://abcdefghijklmnop.supabase.co";

/** The policy as a map of directive name to its source list. */
function directives(policy: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of policy.split(";").map((p) => p.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/);
    assert.equal(map.has(name), false, `${name} appears twice`);
    map.set(name, sources);
  }
  return map;
}

const policy = (options: Partial<Parameters<typeof buildContentSecurityPolicy>[0]> = {}) =>
  directives(buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl: SUPABASE, ...options }));

test("every directive is present", () => {
  const got = policy();
  for (const name of [
    "default-src",
    "script-src",
    "style-src",
    "img-src",
    "media-src",
    "font-src",
    "connect-src",
    "worker-src",
    "child-src",
    "frame-src",
    "manifest-src",
    "object-src",
    "base-uri",
    "form-action",
    "frame-ancestors",
    "upgrade-insecure-requests",
    "report-uri",
  ]) {
    assert.ok(got.has(name), `missing ${name}`);
  }
  assert.deepEqual(got.get("default-src"), ["'self'"]);
  assert.deepEqual(got.get("object-src"), ["'none'"]);
  assert.deepEqual(got.get("base-uri"), ["'self'"]);
  assert.deepEqual(got.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(got.get("report-uri"), ["/api/csp-report"]);
  assert.deepEqual(got.get("worker-src"), ["'self'", "blob:"]);
});

test("scripts need this response's nonce, and nothing inline or eval'd runs without it", () => {
  const script = policy().get("script-src") ?? [];
  assert.ok(script.includes(`'nonce-${NONCE}'`), script.join(" "));
  assert.ok(script.includes("'strict-dynamic'"), script.join(" "));
  assert.equal(script.includes("'unsafe-inline'"), false, "script-src must not allow inline script");
  assert.equal(script.includes("'unsafe-eval'"), false, "script-src must not allow eval");
  assert.equal(script.some((s) => s === "*" || s === "https:" || s === "data:" || s === "blob:"), false, script.join(" "));
});

test("Next.js finds the nonce in the policy, which is how its own scripts get it", () => {
  const nonce = createNonce();
  assert.equal(getScriptNonceFromHeader(buildContentSecurityPolicy({ nonce, supabaseUrl: SUPABASE })), nonce);
});

test("styles stay inline-capable, and carry no nonce that would switch that off", () => {
  const style = policy().get("style-src") ?? [];
  assert.deepEqual(style, ["'self'", "'unsafe-inline'"]);
});

test("Cloudflare is named only when Turnstile is configured", () => {
  const off = buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl: SUPABASE });
  assert.equal(off.includes("challenges.cloudflare.com"), false, off);
  const on = policy({ turnstile: true });
  for (const name of ["script-src", "frame-src", "connect-src"]) {
    assert.ok(on.get(name)?.includes(TURNSTILE_ORIGIN), `${name}: ${on.get(name)?.join(" ")}`);
  }
});

test("the browser's own services are allowed, and server-only ones are not", () => {
  const got = policy();
  const connect = got.get("connect-src") ?? [];
  for (const source of [SUPABASE, "wss://abcdefghijklmnop.supabase.co", MAP_TILES_ORIGIN, "https://*.speech.microsoft.com", "wss://*.speech.microsoft.com"]) {
    assert.ok(connect.includes(source), `connect-src lacks ${source}`);
  }
  assert.ok(got.get("img-src")?.includes(SUPABASE));
  assert.ok(got.get("img-src")?.includes("data:"));
  assert.ok(got.get("img-src")?.includes("blob:"));
  assert.ok(got.get("media-src")?.includes(SUPABASE));
  const all = buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl: SUPABASE, turnstile: true, payfastSandbox: true });
  for (const serverOnly of ["mapbox", "nominatim", "openai", "paystack.co ", "api.paystack"]) {
    assert.equal(all.includes(serverOnly), false, `${serverOnly} is called from the server only`);
  }
});

test("forms may leave only for the payment pages", () => {
  assert.deepEqual(policy().get("form-action"), ["'self'", PAYSTACK_CHECKOUT_ORIGIN, PAYFAST_ORIGIN]);
  assert.deepEqual(policy({ payfastSandbox: true }).get("form-action"), ["'self'", PAYSTACK_CHECKOUT_ORIGIN, PAYFAST_ORIGIN, PAYFAST_SANDBOX_ORIGIN]);
});

test("a missing or broken Supabase URL leaves no gap or junk in the policy", () => {
  for (const supabaseUrl of [undefined, null, "", "not a url", "javascript:alert(1)"]) {
    const text = buildContentSecurityPolicy({ nonce: NONCE, supabaseUrl });
    assert.doesNotMatch(text, /undefined|null|javascript|not a url|\s{2}|\s;/, text);
    assert.deepEqual(directives(text).get("media-src"), ["'self'", "blob:"]);
  }
});

test("a nonce that is not base64 is refused, so it cannot break out of the header or the page", () => {
  for (const nonce of ["", "short", "abc' 'unsafe-inline", "abcdefghijklmnopqrstuvwx; script-src *", "abcdefghijklmnopqrstuv\"x"]) {
    assert.throws(() => buildContentSecurityPolicy({ nonce }), /nonce/, nonce);
  }
});

test("each nonce is fresh, 16 random bytes in base64", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const nonce = createNonce();
    assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/);
    seen.add(nonce);
  }
  assert.equal(seen.size, 200);
});
