import { test } from "node:test";
import assert from "node:assert/strict";
import type { Attempt, Hold, Units } from "@/lib/ai-usage/ledger";
import type { FarmDataScope } from "@/lib/assistant/farm-data";
import { farmAgentSystemPrompt, farmAgentTools } from "@/lib/assistant/agent";
import { citation, configuredManualReader, NO_EVIDENCE_NOTE, pagesForIndex, runManualRead, searchManuals, type ManualReader, type ManualReadOutput } from "./manuals";

const INPUT = { bytes: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf" };
const HELD: Hold = { ok: true, id: "h1", credential: "platform", estimateCents: 3 };

function reader(out: ManualReadOutput | (() => never)): ManualReader & { calls: number } {
  return {
    name: "fake", model: "fake/reader-1", calls: 0,
    estimate: () => ({ input_tokens: 2000 }),
    async readPages() { this.calls++; return typeof out === "function" ? out() : out; },
  };
}
function ledger(hold: Hold = HELD) {
  const settled: Attempt[][] = [];
  return {
    settled,
    hold: async (_u: Units, _m: string) => hold,
    settle: async (_id: string, attempts: Attempt[]) => { settled.push(attempts); },
  };
}

test("no reader unless one is built and named exactly", () => {
  const r = reader({ pages: [], units: {} });
  assert.equal(configuredManualReader({}), null);
  assert.equal(configuredManualReader({ MANUAL_READER_PROVIDER: "none" }, { fake: () => r }), null);
  assert.equal(configuredManualReader({ MANUAL_READER_PROVIDER: "fak" }, { fake: () => r }), null);
  assert.equal(configuredManualReader({ MANUAL_READER_PROVIDER: "fake" }, { fake: () => r }), r);
});

test("pages are numbered 1 to 300, words only, each page once, in order", () => {
  const r = pagesForIndex({ units: {}, pages: [
    { page: 3, text: "Hydraulic oil 60 l" },
    { page: 1, text: "Contents\u0007 and safety" },
    { page: 3, text: "a second page three is dropped" },
    { page: 2, text: "   " },
    { page: 0, text: "no page zero" },
    { page: 301, text: "past the end" },
    { page: 4, text: 42 },
  ] });
  assert.ok(r.ok);
  assert.deepEqual(r.pages, [{ page: 1, text: "Contents  and safety" }, { page: 3, text: "Hydraulic oil 60 l" }]);
  assert.equal(pagesForIndex({ units: {}, pages: [{ page: 1, text: "x".repeat(30000) }] }).ok && (pagesForIndex({ units: {}, pages: [{ page: 1, text: "x".repeat(30000) }] }) as { pages: { text: string }[] }).pages[0].text.length, 20000);
  assert.deepEqual(pagesForIndex({ units: {}, pages: Array.from({ length: 301 }, (_, i) => ({ page: i + 1, text: "w" })) }), { ok: false, error: "manual-invalid" });
  assert.deepEqual(pagesForIndex({ units: {}, pages: [{ page: 1, text: " " }] }), { ok: false, error: "manual-empty" });
});

test("reading a manual: Complete only, never without a hold, failures settled", async () => {
  for (const plan of ["essential", "professional", null] as const) {
    const r = reader({ pages: [{ page: 1, text: "x" }], units: {} });
    assert.deepEqual(await runManualRead({ reader: r, input: INPUT, plan, ...ledger() }), { ok: false, reason: "plan" });
    assert.equal(r.calls, 0);
  }
  const refused = reader({ pages: [{ page: 1, text: "x" }], units: {} });
  const l0 = ledger({ ok: false, reason: "farm_limit", notifyOwner: true, limitCents: 100, spentCents: 100 });
  assert.deepEqual(await runManualRead({ reader: refused, input: INPUT, plan: "complete", ...l0 }), { ok: false, reason: "spend_refused", error: "farm_limit" });
  assert.equal(refused.calls, 0);

  const good = reader({ pages: [{ page: 7, text: "Engine oil 12 litres" }], units: { input_tokens: 1500 } });
  const l1 = ledger();
  assert.deepEqual(await runManualRead({ reader: good, input: INPUT, plan: "done_for_you", ...l1 }), { ok: true, pages: [{ page: 7, text: "Engine oil 12 litres" }] });
  assert.equal(l1.settled[0][0].outcome, "ok");

  const blank = reader({ pages: [{ page: 1, text: "" }], units: { input_tokens: 900 } });
  const l2 = ledger();
  assert.deepEqual(await runManualRead({ reader: blank, input: INPUT, plan: "complete", ...l2 }), { ok: false, reason: "provider_failed", error: "manual-empty" });
  assert.equal(l2.settled[0][0].charged, true);

  const broken = reader(() => { throw new Error("down"); });
  const l3 = ledger();
  assert.deepEqual(await runManualRead({ reader: broken, input: INPUT, plan: "complete", ...l3 }), { ok: false, reason: "provider_failed", error: undefined });
  assert.equal(l3.settled[0][0].outcome, "failed");
});

const machineBase = { aliases: [], status: "active", meterType: "hours", currentReading: null, currentReadingDate: null, serviceStatus: null, nextDueDate: null, nextDueReading: null };
const tractor = { ...machineBase, id: "m1", name: "Tractor 1", make: "John Deere", model: "6155R" };
const bakkie = { ...machineBase, id: "m2", name: "Bakkie", make: null, model: null };
function scopeWith(rpc: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const scope = {
    supabase: { rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return rpc(name, args); } },
    farmId: "f1", role: "operator", machines: [tractor, bakkie], costsVisible: false, manualQuestions: true,
  } as unknown as FarmDataScope;
  return { scope, calls };
}

test("search: excerpts come back with their cite and the asset; the person's own session decides what exists", async () => {
  const { scope, calls } = scopeWith(() => ({
    data: [{ attachment_id: "a1", machine_id: "m1", title: "Operator's manual", page: 7, excerpt: "Engine oil capacity: 12 litres", rank: 0.4 }],
    error: null,
  }));
  const r = await searchManuals(scope, { query: "engine oil capacity", machine: "tractor 1" });
  assert.deepEqual(r.evidence, [{ cite: "Operator's manual, p. 7", machine: "Tractor 1", excerpt: "Engine oil capacity: 12 litres" }]);
  assert.match(r.note, /not instructions/);
  assert.deepEqual(calls, [{ name: "manual_search", args: { p_farm: "f1", p_query: "engine oil capacity", p_machine: "m1", p_limit: 5 } }]);
});

test("search: nothing matches, so the assistant is told to say the manuals do not cover it", async () => {
  const { scope } = scopeWith(() => ({ data: [], error: null }));
  const r = await searchManuals(scope, { query: "tyre pressure", machine: null });
  assert.deepEqual(r.evidence, []);
  assert.equal(r.note, NO_EVIDENCE_NOTE);
});

test("search: a machine that does not match is said, not guessed; a failed read is an error", async () => {
  const { scope, calls } = scopeWith(() => ({ data: [], error: null }));
  const r = await searchManuals(scope, { query: "oil", machine: "harvester" });
  assert.equal(calls.length, 0);
  assert.match(r.note, /No single machine matches/);
  const failing = scopeWith(() => ({ data: null, error: { message: "manual-questions-off" } }));
  await assert.rejects(searchManuals(failing.scope, { query: "oil", machine: null }));
});

test("the assistant has the manual tool and its citation rule only where manual questions are on", () => {
  const { scope } = scopeWith(() => ({ data: [], error: null }));
  assert.ok("search_manuals" in farmAgentTools(scope, "2026-11-19"));
  assert.ok(!("search_manuals" in farmAgentTools({ ...scope, manualQuestions: false }, "2026-11-19")));
  const base = { farmName: "W", role: "owner", today: "2026-11-19", locale: "en-ZA" as const, channel: "typed" as const, costsVisible: true, snapshot: "", digest: null };
  assert.match(farmAgentSystemPrompt({ ...base, manualQuestions: true }), /search_manuals[^]*\(Operator's manual, p\. 7\)[^]*do not cover it/);
  assert.doesNotMatch(farmAgentSystemPrompt(base), /search_manuals/);
  assert.equal(citation({ title: "Service book", page: 3 }), "Service book, p. 3");
});
