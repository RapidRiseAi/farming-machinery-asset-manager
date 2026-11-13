import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { SITEVERIFY_URL, TURNSTILE_FIELD, turnstileConfig, turnstileWidget, verifyTurnstile } from "./turnstile";

const SECRET = "0x4AAAAAAAtestSECRETnotReal";
const SITE = "0x4AAAAAAAtestSITEnotReal";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const env = { NEXT_PUBLIC_TURNSTILE_SITE_KEY: SITE, TURNSTILE_SECRET_KEY: SECRET };

type Call = { url: string; init: RequestInit };

function fakeFetch(answer: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function reporter() {
  const seen: string[] = [];
  return { seen, report: (message: string) => void seen.push(message) };
}

test("not configured: every token passes and Cloudflare is never asked", async () => {
  const f = fakeFetch(() => json({ success: false }));
  for (const partial of [{}, { NEXT_PUBLIC_TURNSTILE_SITE_KEY: SITE }, { TURNSTILE_SECRET_KEY: SECRET }, { NEXT_PUBLIC_TURNSTILE_SITE_KEY: " ", TURNSTILE_SECRET_KEY: SECRET }]) {
    assert.equal(turnstileConfig(partial), null);
    assert.equal(await verifyTurnstile(null, null, { env: partial, fetch: f.impl }), null);
    assert.equal(await verifyTurnstile(TOKEN, "203.0.113.9", { env: partial, fetch: f.impl }), null);
  }
  assert.equal(f.calls.length, 0);
});

test("the page gets a widget only with both keys, in a language Turnstile has", () => {
  const saved = { site: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY, secret: process.env.TURNSTILE_SECRET_KEY };
  try {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    assert.equal(turnstileWidget("en"), null);
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = SITE;
    assert.equal(turnstileWidget("en"), null, "a site key alone shows nothing the server cannot check");
    process.env.TURNSTILE_SECRET_KEY = SECRET;
    assert.deepEqual(turnstileWidget("en"), { siteKey: SITE, language: "en" });
    // Turnstile has no Afrikaans; a Lang is not a language tag either.
    assert.deepEqual(turnstileWidget("af-pro@farm"), { siteKey: SITE, language: "en" });
    assert.equal(JSON.stringify(turnstileWidget("af")).includes(SECRET), false, "the secret never goes to a page");
  } finally {
    if (saved.site === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = saved.site;
    if (saved.secret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = saved.secret;
  }
});

test("configured: a good token passes, posted with the secret, the token and the caller's IP", async () => {
  const f = fakeFetch(() => json({ success: true, hostname: "app.example.test" }));
  assert.equal(await verifyTurnstile(TOKEN, "203.0.113.9", { env, fetch: f.impl }), null);
  assert.equal(f.calls.length, 1);
  const [{ url, init }] = f.calls;
  assert.equal(url, SITEVERIFY_URL);
  assert.equal(SITEVERIFY_URL, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(init.method, "POST");
  const body = init.body as URLSearchParams;
  assert.equal(body.get("secret"), SECRET);
  assert.equal(body.get("response"), TOKEN);
  assert.equal(body.get("remoteip"), "203.0.113.9");
  assert.ok(init.signal instanceof AbortSignal, "the request can time out");
  // No IP known: the field is left out rather than sent empty.
  await verifyTurnstile(TOKEN, null, { env, fetch: f.impl });
  assert.equal((f.calls[1].init.body as URLSearchParams).has("remoteip"), false);
});

test("a refused token sends the person back to tick the check again", async () => {
  for (const code of ["invalid-input-response", "timeout-or-duplicate", "missing-input-response"]) {
    const f = fakeFetch(() => json({ success: false, "error-codes": [code] }));
    const r = reporter();
    assert.equal(await verifyTurnstile(TOKEN, null, { env, fetch: f.impl, report: r.report }), "captcha-retry", code);
    assert.deepEqual(r.seen, [], "a person's expired tick is not a fault of ours");
  }
  // success missing or anything but `true` is not a pass.
  for (const body of [{}, { success: "true" }, { success: 1 }]) {
    const f = fakeFetch(() => json(body));
    assert.notEqual(await verifyTurnstile(TOKEN, null, { env, fetch: f.impl, report: () => {} }), null, JSON.stringify(body));
  }
});

test("a missing or impossible token is refused without asking Cloudflare", async () => {
  const f = fakeFetch(() => json({ success: true }));
  for (const token of [null, undefined, "", new Blob(["x"]), "x".repeat(2049)]) {
    assert.equal(await verifyTurnstile(token, null, { env, fetch: f.impl }), "captcha-retry");
  }
  assert.equal(f.calls.length, 0);
});

test("Cloudflare answering anything but 200 refuses, even a body that claims success", async () => {
  for (const status of [500, 502, 429, 403]) {
    const f = fakeFetch(() => json({ success: true }, status));
    const r = reporter();
    assert.equal(await verifyTurnstile(TOKEN, null, { env, fetch: f.impl, report: r.report }), "captcha-unavailable");
    assert.deepEqual(r.seen, [`siteverify answered ${status}`]);
  }
  const html = fakeFetch(() => new Response("<html>busy</html>", { status: 200 }));
  assert.equal(await verifyTurnstile(TOKEN, null, { env, fetch: html.impl, report: () => {} }), "captcha-unavailable");
});

test("Cloudflare not answering in time refuses, it does not wait", async () => {
  const hang = fakeFetch(
    ({ init }) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
  const r = reporter();
  const started = Date.now();
  assert.equal(await verifyTurnstile(TOKEN, null, { env, fetch: hang.impl, timeoutMs: 30, report: r.report }), "captcha-unavailable");
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(r.seen, ["siteverify unreachable (TimeoutError)"]);
  // Five seconds in the real thing.
  const source = readFileSync(join(process.cwd(), "src/lib/security/turnstile.ts"), "utf8");
  assert.match(source, /const VERIFY_TIMEOUT_MS = 5_000;/);
  assert.match(source, /timeoutMs: deps\.timeoutMs \?\? VERIFY_TIMEOUT_MS/);
});

test("a wrong secret or Cloudflare's own failure is reported as ours, never with the secret", async () => {
  for (const code of ["invalid-input-secret", "missing-input-secret", "internal-error"]) {
    const f = fakeFetch(() => json({ success: false, "error-codes": [code] }));
    const r = reporter();
    assert.equal(await verifyTurnstile(TOKEN, null, { env, fetch: f.impl, report: r.report }), "captcha-unavailable");
    assert.deepEqual(r.seen, [`siteverify refused: ${code}`]);
  }
});

test("the secret and the token never reach a report, and the verifier never throws", async () => {
  const leaks: Array<() => Promise<Response> | Response> = [
    // A network failure whose message quotes the request it was making.
    () => {
      throw new TypeError(`fetch failed: secret=${SECRET}&response=${TOKEN}`);
    },
    () => json({ success: false, "error-codes": [SECRET, TOKEN, `bad ${SECRET}`] }),
    () => new Response(`not json ${SECRET} ${TOKEN}`, { status: 200 }),
    () => new Response(`${SECRET}`, { status: 500 }),
  ];
  for (const answer of leaks) {
    const f = fakeFetch(answer);
    const r = reporter();
    const outcome = await verifyTurnstile(TOKEN, "203.0.113.9", { env, fetch: f.impl, report: r.report });
    assert.notEqual(outcome, null);
    for (const message of r.seen) {
      assert.equal(message.includes(SECRET), false, message);
      assert.equal(message.includes(TOKEN), false, message);
    }
  }
});

/** The body of one top-level function in a source file, after its signature. */
function fnBody(file: string, signature: string): string {
  const text = readFileSync(join(process.cwd(), "src", file), "utf8");
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `${file}: ${signature} not found`);
  const end = text.indexOf("\n}\n", start);
  assert.ok(end > start, `${file}: the end of ${signature} not found`);
  return text.slice(start + signature.length, end);
}

/** The first call that reaches the database, Supabase Auth, a header or the network. */
const FIRST_IO = /\.rpc\(|\.from\(|\.auth\.|createClient\(\)|createServiceClient\(\)|\bheaders\(\)|fetch\(|send[A-Z]\w*\(/;

const FORM_ACTIONS: Array<[file: string, signature: string]> = [
  ["app/(public)/signup/actions.ts", "export async function signUp("],
  ["app/(public)/become-a-partner/actions.ts", "export async function applyToPartner("],
  ["app/(auth)/login/actions.ts", "export async function signInWithPassword("],
  ["app/(auth)/login/actions.ts", "export async function signInWithMagicLink("],
  ["app/(auth)/login/actions.ts", "export async function sendPasswordReset("],
];

test("each form's action checks the bot token before its first database or Auth call, and stops on a refusal", () => {
  for (const [file, signature] of FORM_ACTIONS) {
    const body = fnBody(file, signature);
    const check = body.indexOf("await checkTurnstile(formData)");
    const io = body.search(FIRST_IO);
    assert.ok(check >= 0, `${signature} never calls checkTurnstile`);
    assert.ok(io > check, `${signature}: something reaches the database or Auth before the bot check`);
    assert.match(
      body.slice(check),
      /^await checkTurnstile\(formData\)[^;]*;\s*if \((captcha|refused)\) (bounce|redirect)\(/,
      `${signature}: a refusal must send the person back at once`,
    );
  }
});

test("the widget sits inside each form and posts the field the server reads", () => {
  assert.equal(TURNSTILE_FIELD, "cf-turnstile-response");
  const widget = readFileSync(join(process.cwd(), "src/components/turnstile-widget.tsx"), "utf8");
  assert.doesNotMatch(widget, /response-field/, "the widget keeps Turnstile's default field name");
  assert.match(widget, /render=explicit/);
  for (const file of ["app/(public)/signup/page.tsx", "app/(public)/become-a-partner/page.tsx", "app/(auth)/login/login-form.tsx"]) {
    const text = readFileSync(join(process.cwd(), "src", file), "utf8");
    const at = text.indexOf("<TurnstileWidget");
    assert.ok(at > text.indexOf("<form") && at < text.indexOf("</form>"), `${file}: the widget must be inside the form`);
    assert.match(text, /captcha \? (\(\s*<div[^>]*>\s*)?<TurnstileWidget/, `${file}: nothing renders while the check is off`);
  }
});

/** The CSP the middleware sends, with or without a site key. */
async function cspWith(siteKey: string | undefined): Promise<string> {
  const saved = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  if (siteKey === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = siteKey;
  try {
    const { middleware } = await import("../../middleware");
    const { NextRequest } = await import("next/server");
    const header = (await middleware(new NextRequest("http://localhost/login"))).headers.get("content-security-policy");
    assert.ok(header, "no Content-Security-Policy header");
    return header;
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = saved;
  }
}

test("the CSP allows Cloudflare only in a build that has the site key", async () => {
  const off = await cspWith(undefined);
  assert.equal(off.includes("challenges.cloudflare.com"), false, off);

  const on = await cspWith(SITE);
  const directive = (name: string) => on.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";
  for (const name of ["script-src", "frame-src", "connect-src"]) {
    assert.match(directive(name), /(^| )https:\/\/challenges\.cloudflare\.com( |$)/, `${name}: ${directive(name)}`);
  }
  assert.equal(on.includes(SITE), false, "the key itself is not in the policy");
});
