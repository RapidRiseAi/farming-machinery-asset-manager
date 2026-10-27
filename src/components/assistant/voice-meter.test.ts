/**
 * Opening a voice session after a lost answer (VoiceMeter.open). The server bills a session
 * nobody reports at its full maximum, so an open whose answer was lost must be asked again
 * with the same request id, and the server's replay used, rather than a second hold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceMeter } from "./voice-meter";

type Call = { url: string; body: Record<string, unknown> };

function stubFetch(answers: Array<(body: Record<string, unknown>) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    if (url.endsWith("/voice-usage")) return new Response(null, { status: 204 });
    const next = answers.shift();
    if (!next) throw new Error("no answer prepared");
    return next(body);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const session = (id: string) => () =>
  Response.json({ ok: true, sessionId: id, maxAudioMs: 120_000, maxCharacters: 1_500 });
const lost = () => { throw new TypeError("fetch failed"); };
const refusedWith = (status: number) => () => Response.json({ error: "ai_limit_reached" }, { status });
const meter = () => new VoiceMeter(async (response) => new Error(`refused ${response.status}`));
const opens = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/voice-session"));

test("an open whose answer was lost is asked again with the same id", async () => {
  const f = stubFetch([lost, session("s1")]);
  const m = meter();
  try {
    await assert.rejects(m.ensure({ audioMs: 1_000 }));
    await m.ensure({ audioMs: 1_000 });
    const [first, retry] = opens(f.calls);
    assert.equal(typeof first.body.requestId, "string");
    assert.equal(retry.body.requestId, first.body.requestId);
  } finally {
    m.dispose();
    f.restore();
  }
});

test("once a session is in hand, the next open is a new request", async () => {
  const f = stubFetch([session("s1"), session("s2")]);
  const m = meter();
  try {
    await m.ensure({ audioMs: 1_000 });
    await m.ensure({ audioMs: 500_000 });
    const [first, second] = opens(f.calls);
    assert.notEqual(second.body.requestId, first.body.requestId);
  } finally {
    m.dispose();
    f.restore();
  }
});

test("a refusal held nothing, so the next open is a new request", async () => {
  const f = stubFetch([refusedWith(402), session("s1")]);
  const m = meter();
  try {
    await assert.rejects(m.ensure({ audioMs: 1_000 }), /refused 402/);
    await m.ensure({ audioMs: 1_000 });
    const [first, second] = opens(f.calls);
    assert.notEqual(second.body.requestId, first.body.requestId);
  } finally {
    m.dispose();
    f.restore();
  }
});

test("a server error or 'still opening' keeps the id for the retry", async () => {
  const f = stubFetch([refusedWith(503), refusedWith(409), session("s1")]);
  const m = meter();
  try {
    await assert.rejects(m.ensure({ audioMs: 1_000 }));
    await assert.rejects(m.ensure({ audioMs: 1_000 }));
    await m.ensure({ audioMs: 1_000 });
    const ids = opens(f.calls).map((c) => c.body.requestId);
    assert.equal(new Set(ids).size, 1);
  } finally {
    m.dispose();
    f.restore();
  }
});
