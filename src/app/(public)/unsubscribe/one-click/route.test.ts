import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { unsubscribeSignature } from "@/lib/email/unsubscribe";
import { GET, POST } from "./route";

/**
 * The address a mail app's own Unsubscribe button posts to: no cookies, no origin, only the
 * signed link. A good signature switches that person's alert emails off; anything else
 * changes nothing; a browser that merely opens it is sent to the page that asks first.
 */

const ALICE = "a1b2c3d4-0000-4000-9000-00000000000a";
const BOB = "b1b2c3d4-0000-4000-9000-00000000000b";

type Call = { method: string; url: string; body: string };

async function withDatabase(fn: (calls: Call[]) => Promise<void>, status = 204): Promise<void> {
  const names = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "EMAIL_LINK_SECRET"] as const;
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.fleetwise.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ["anon", "test"].join("-");
  process.env.SUPABASE_SERVICE_ROLE_KEY = ["service", "test"].join("-");
  delete process.env.EMAIL_LINK_SECRET;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: String(init?.method ?? "GET"), url: String(input), body: String(init?.body ?? "") });
    return new Response(null, { status });
  }) as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of names) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const oneClick = (u: string, s: string | null) =>
  new NextRequest(`https://app.fleetwise.test/unsubscribe/one-click?u=${u}${s === null ? "" : `&s=${s}`}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });

test("a mail app's one-click POST with a good signature switches that person's alert emails off", async () => {
  await withDatabase(async (calls) => {
    const response = await POST(oneClick(ALICE, unsubscribeSignature(ALICE)));
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PATCH");
    assert.match(calls[0].url, /\/rest\/v1\/users\?id=eq\.a1b2c3d4-0000-4000-9000-00000000000a$/);
    assert.deepEqual(JSON.parse(calls[0].body), { notify_email: false });
  });
});

test("a forged, truncated, missing or borrowed signature changes nothing", async () => {
  await withDatabase(async (calls) => {
    const good = unsubscribeSignature(ALICE) as string;
    for (const request of [
      oneClick(ALICE, `x${good.slice(1)}`),
      oneClick(ALICE, good.slice(0, 20)),
      oneClick(ALICE, null),
      oneClick(BOB, good),
    ]) {
      assert.equal((await POST(request)).status, 400);
    }
    assert.equal(calls.length, 0, "the database was never asked to change anything");
  });
});

test("a failed write is a 503, so the provider can try again", async () => {
  await withDatabase(async () => {
    const response = await POST(oneClick(ALICE, unsubscribeSignature(ALICE)));
    assert.equal(response.status, 503);
  }, 500);
});

test("opening the address in a browser goes to the page that asks first", async () => {
  await withDatabase(async (calls) => {
    const s = unsubscribeSignature(ALICE) as string;
    const response = GET(new NextRequest(`https://app.fleetwise.test/unsubscribe/one-click?u=${ALICE}&s=${s}`));
    assert.equal(response.status, 303);
    const to = new URL(response.headers.get("location") ?? "");
    assert.equal(to.pathname, "/unsubscribe");
    assert.equal(to.searchParams.get("u"), ALICE);
    assert.equal(to.searchParams.get("s"), s);
    assert.equal(calls.length, 0);
  });
});
