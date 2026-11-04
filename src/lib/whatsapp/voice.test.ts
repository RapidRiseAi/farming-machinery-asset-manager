import assert from "node:assert/strict";
import test from "node:test";
import { transcribeVoiceNote } from "./voice";

/**
 * The voice-note hearing pays like the in-app one: a budget hold before every call, on the
 * credential it will really use, settled in the ledger whatever happens, and nothing at
 * all when the hold is refused. The speech call is injected; the database is mocked.
 */

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://database.example.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-public",
  SUPABASE_SERVICE_ROLE_KEY: "test-server", ASSISTANT_TRANSCRIBE_MODELS: "",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const audio = new Uint8Array([1, 2, 3]);
const input = { farmId: "farm", userId: "person", audio, durationMs: 5000, terms: ["JD 6120"] };

async function withDb(
  db: { keyError?: boolean; reserve?: Record<string, unknown> },
  run: (seen: { reserves: Record<string, unknown>[]; settles: Record<string, unknown>[] }) => Promise<void>,
) {
  const seen = { reserves: [] as Record<string, unknown>[], settles: [] as Record<string, unknown>[] };
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  const original = globalThis.fetch;
  Object.assign(process.env, ENV);
  let n = 0;
  globalThis.fetch = async (raw, init) => {
    const url = new URL(raw instanceof Request ? raw.url : String(raw));
    assert.equal(url.hostname, "database.example.test", "no request outside the database in this test");
    const route = url.pathname.replace("/rest/v1/", "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (route === "farm_ai_keys") return db.keyError ? json({ message: "boom" }, 500) : json(null);
    if (route === "farm_ai_settings") return json(null);
    if (route === "rpc/ai_reserve") { seen.reserves.push(body); n++; return json(db.reserve ?? { ok: true, id: `hold-${n}`, credential: "platform" }); }
    if (route === "rpc/ai_settle") { seen.settles.push(body); return json({ billed_cents: 1 }); }
    throw new Error(`Unexpected mock route ${route}`);
  };
  try { await run(seen); } finally {
    globalThis.fetch = original;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

type FakeTranscribe = NonNullable<Parameters<typeof transcribeVoiceNote>[1]>["transcribe"];
const hearing = (texts: (string | Error)[]) => {
  const models: string[] = [];
  const fn = (async (options: { model: unknown }) => {
    models.push(typeof options.model === "string" ? options.model : "direct");
    const next = texts.shift();
    if (next instanceof Error) throw next;
    return { text: next ?? "", providerMetadata: { gateway: { cost: "0.0005", generationId: "gen-1" } }, responses: [] };
  }) as unknown as FakeTranscribe;
  return { fn, models };
};

test("heard: one hold, one call on the platform's gpt-4o, settled at the Gateway's cost", async () => {
  await withDb({}, async (seen) => {
    const h = hearing(["Tractor four needs a service"]);
    const result = await transcribeVoiceNote(input, { transcribe: h.fn });
    assert.deepEqual(result, { ok: true, text: "Tractor four needs a service" });
    assert.deepEqual(h.models, ["openai/gpt-4o-transcribe"]);
    assert.equal(seen.reserves.length, 1);
    assert.equal(seen.reserves[0].p_feature, "ai_hearing");
    assert.equal(seen.reserves[0].p_credential, "platform");
    assert.equal(seen.reserves[0].p_farm, "farm");
    assert.equal((seen.reserves[0].p_units as Record<string, number>).audio_ms, 5000);
    assert.equal(seen.settles.length, 1);
    const attempt = (seen.settles[0].p_attempts as Record<string, unknown>[])[0];
    assert.equal(attempt.outcome, "ok");
    assert.equal(attempt.measured, "gateway");
    assert.equal(attempt.cost_usd, "0.000500000000");
  });
});

test("a refused hold (the farm's limit) calls no model and says why", async () => {
  await withDb({ reserve: { ok: false, reason: "farm_limit" } }, async (seen) => {
    const h = hearing(["never"]);
    assert.deepEqual(await transcribeVoiceNote(input, { transcribe: h.fn }), { ok: false, reason: "farm_limit" });
    assert.equal(h.models.length, 0);
    assert.equal(seen.settles.length, 0);
  });
});

test("the fallback runs only when the first model fails, and both attempts are settled", async () => {
  await withDb({}, async (seen) => {
    const h = hearing([Object.assign(new Error("upstream"), { statusCode: 503 }), "Fuel in the bakkie"]);
    const result = await transcribeVoiceNote(input, { transcribe: h.fn });
    assert.deepEqual(result, { ok: true, text: "Fuel in the bakkie" });
    assert.deepEqual(h.models, ["openai/gpt-4o-transcribe", "microsoft/mai-transcribe-2"]);
    assert.equal(seen.reserves.length, 2);
    assert.equal(seen.settles.length, 2);
    assert.equal((seen.settles[0].p_attempts as Record<string, unknown>[])[0].outcome, "failed");
  });
  // Heard but empty: silence, not a failure worth paying a second model for.
  await withDb({}, async (seen) => {
    const h = hearing([""]);
    assert.deepEqual(await transcribeVoiceNote(input, { transcribe: h.fn }), { ok: false, reason: "not_heard" });
    assert.equal(h.models.length, 1);
    assert.equal((seen.settles[0].p_attempts as Record<string, unknown>[])[0].error_code, "empty_transcript");
  });
});

test("an unreadable own-key setting fails closed: never billed to the platform instead", async () => {
  await withDb({ keyError: true }, async (seen) => {
    const h = hearing(["never"]);
    assert.deepEqual(await transcribeVoiceNote(input, { transcribe: h.fn }), { ok: false, reason: "unavailable" });
    assert.equal(h.models.length, 0);
    assert.equal(seen.reserves.length, 0);
  });
});
