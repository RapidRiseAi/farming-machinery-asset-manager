import assert from "node:assert/strict";
import test from "node:test";
import { drainInBatches } from "./drain";

/** A queue of `total` items that hands out at most `limit` per claim. */
function queue(total: number) {
  let next = 0;
  const claims: number[] = [];
  return {
    claims,
    claim: async (limit: number) => {
      claims.push(limit);
      const rows = Array.from({ length: Math.min(limit, total - next) }, (_, i) => next + i);
      next += rows.length;
      return { rows };
    },
  };
}

test("drains batch after batch until a short batch", async () => {
  const q = queue(25);
  const handled: number[] = [];
  const r = await drainInBatches(q.claim, async (n) => { handled.push(n); return true; }, { batch: 10, budgetMs: 60_000 });
  assert.deepEqual(r, { claimed: 25, ok: 25, failed: 0, more: false });
  assert.deepEqual(q.claims, [10, 10, 10]);
  assert.deepEqual(handled, Array.from({ length: 25 }, (_, i) => i));
});

test("an exact multiple makes one more, empty, claim and then stops", async () => {
  const q = queue(20);
  const r = await drainInBatches(q.claim, async () => true, { batch: 10, budgetMs: 60_000 });
  assert.equal(r.claimed, 20);
  assert.equal(r.more, false);
  assert.deepEqual(q.claims, [10, 10, 10]);
});

test("stops claiming when time is up, and says more may be waiting", async () => {
  const q = queue(100);
  let clock = 0;
  const r = await drainInBatches(
    q.claim,
    async () => { clock += 1_000; return true; },
    { batch: 10, budgetMs: 15_000, now: () => clock },
  );
  // Each batch takes 10 s: the first ends at 10 s (in time), the second at 20 s (past).
  assert.deepEqual(r, { claimed: 20, ok: 20, failed: 0, more: true });
  assert.deepEqual(q.claims, [10, 10]);
});

test("counts failures without stopping, and returns what was done before an error", async () => {
  let calls = 0;
  const r = await drainInBatches(
    async (limit) => (++calls === 1 ? { rows: Array.from({ length: limit }, (_, i) => i) } : { rows: [], error: "boom" }),
    async (n) => n % 2 === 0,
    { batch: 4, budgetMs: 60_000 },
  );
  assert.deepEqual(r, { claimed: 4, ok: 2, failed: 2, more: false, error: "boom" });
});
