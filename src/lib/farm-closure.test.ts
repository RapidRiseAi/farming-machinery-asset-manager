import { test } from "node:test";
import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";

import { CLOSURE_TOKEN, exportIsFresh, finishClosureFiles, hashClosureToken, newClosureToken, sameBusinessName } from "./farm-closure";

test("a confirmation link is unguessable, and stored only as a hash", () => {
  const { token, tokenHash } = newClosureToken();
  assert.match(token, CLOSURE_TOKEN);
  assert.equal(hashClosureToken(token), tokenHash);
  assert.notEqual(token, tokenHash);
  assert.notEqual(newClosureToken().token, token);
});

test("an export has to be recent", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  assert.equal(exportIsFresh("2026-11-07T01:00:00Z", now), true);
  assert.equal(exportIsFresh("2026-11-06T11:59:00Z", now), false);
  assert.equal(exportIsFresh(null, now), false);
  assert.equal(exportIsFresh("2026-11-08T01:00:00Z", now), false);
});

test("typing the name is forgiving about spacing and capitals, and nothing else", () => {
  assert.equal(sameBusinessName("  TJ   service ", "TJ Service"), true);
  assert.equal(sameBusinessName("TJ Services", "TJ Service"), false);
  assert.equal(sameBusinessName("", ""), false);
  assert.equal(sameBusinessName("   ", "   "), false);
});

/** Just enough of a Supabase client for the nightly step: closures to finish, and storage. */
function fakeClient(pending: { bucket: string; path: string }[][], storageFails = false) {
  const saved: unknown[] = [];
  const client = {
    from: () => ({
      select: () => ({ neq: () => ({ limit: async () => ({ data: pending.map((p, i) => ({ id: `c${i}`, pending_files: p })), error: null }) }) }),
      update: (row: unknown) => ({ eq: async () => { saved.push(row); return { error: null }; } }),
    }),
    storage: { from: () => ({ remove: async () => ({ error: storageFails ? { message: "storage down" } : null }) }) },
  };
  return { client: client as unknown as SupabaseClient, saved };
}

test("the nightly closure step reads as ok when there is nothing, or everything, to remove", async () => {
  // "0 removed" once marked the whole night as failed: the job counts only "ok" or "skipped".
  assert.match(await finishClosureFiles(fakeClient([]).client), /^ok \(0 removed\)$/);
  const { client, saved } = fakeClient([[{ bucket: "machine-photos", path: "f/a.jpg" }, { bucket: "machine-docs", path: "f/b.pdf" }]]);
  assert.match(await finishClosureFiles(client), /^ok \(2 removed\)$/);
  assert.deepEqual(saved, [{ pending_files: [] }]);
});

test("files that will not go are reported as a failure, and kept for tomorrow", async () => {
  const { client, saved } = fakeClient([[{ bucket: "machine-photos", path: "f/a.jpg" }]], true);
  assert.match(await finishClosureFiles(client), /^error: 1 file/);
  assert.deepEqual(saved, [{ pending_files: [{ bucket: "machine-photos", path: "f/a.jpg" }] }]);
});
