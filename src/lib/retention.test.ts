/**
 * The nightly deletion step (20261120120000): a dry run unless BOTH switches are on (the
 * database's setting and RETENTION_DELETION=enabled); with both, each due business goes through
 * retention_delete, files and logins follow, what is left is kept for the next night, a failure is
 * recorded, and every closure reaches the deletion ledger that a database restore cannot undo.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { retentionDeletionArmed, runRetention } from "./retention";

function fake(opts: { enabled: boolean; due?: string[]; failFor?: string[]; loginsFail?: string[] }) {
  const calls: string[] = [];
  const ledger: string[] = [];
  const saved: Record<string, unknown>[] = [];
  const deletedUsers: string[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push(`${fn}:${String(args?.p_farm ?? "")}`);
      if (fn === "retention_schedule_run") return { data: { scheduled: 2, cancelled: 0, warned: 0, deletion_enabled: opts.enabled }, error: null };
      if (fn === "retention_due") return { data: (opts.due ?? []).map((farm_id) => ({ farm_id })), error: null };
      if (fn === "retention_delete") {
        if ((opts.failFor ?? []).includes(String(args.p_farm))) return { data: null, error: { message: "retention-blocked", code: "22023" } };
        return { data: { closure: `closure-${String(args.p_farm)}`, logins: ["u1", "u2"], files: [] }, error: null };
      }
      return { data: null, error: null };
    },
    from: () => ({
      update: (row: Record<string, unknown>) => ({ eq: async () => (saved.push(row), { error: null }) }),
    }),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => (ledger.push(`${bucket}/${path}`), { error: null }),
        remove: async () => ({ error: null }),
      }),
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          if ((opts.loginsFail ?? []).includes(id)) return { error: { message: "network" } };
          deletedUsers.push(id);
          return { error: null };
        },
      },
    },
  };
  return { client: client as unknown as SupabaseClient, calls, ledger, saved, deletedUsers };
}

test("both switches are needed: the database's setting and the deployment's", () => {
  assert.equal(retentionDeletionArmed({}), false);
  assert.equal(retentionDeletionArmed({ RETENTION_DELETION: "1" }), false);
  assert.equal(retentionDeletionArmed({ RETENTION_DELETION: "enabled" }), true);
});

test("switched off in the database: a dry run, nothing asked to delete", async () => {
  const f = fake({ enabled: false, due: ["farm-a"] });
  const result = await runRetention(f.client, { RETENTION_DELETION: "enabled" });
  assert.match(result, /^ok .*dry run only/);
  assert.ok(!f.calls.some((c) => c.startsWith("retention_delete") || c.startsWith("retention_due")));
});

test("switched on in the database but not on the deployment: still a dry run", async () => {
  const f = fake({ enabled: true, due: ["farm-a"] });
  const result = await runRetention(f.client, {});
  assert.match(result, /dry run only/);
  assert.ok(!f.calls.some((c) => c.startsWith("retention_delete")));
});

test("both on: due businesses are deleted, logins removed, what is left kept, failures recorded, the ledger written", async () => {
  const f = fake({ enabled: true, due: ["farm-a", "farm-b"], failFor: ["farm-b"], loginsFail: ["u2"] });
  const result = await runRetention(f.client, { RETENTION_DELETION: "enabled" });
  assert.match(result, /^error: 1 deletion\(s\) failed/);
  assert.ok(f.calls.includes("retention_delete:farm-a"));
  assert.ok(f.calls.includes("retention_mark_failed:farm-b"), "a failed deletion is recorded");
  assert.deepEqual(f.deletedUsers, ["u1"]);
  assert.deepEqual(f.saved, [{ pending_files: [], pending_logins: ["u2"] }], "the login that would not go is kept for the next night");
  assert.deepEqual(f.ledger, ["deletion-ledger/closures/closure-farm-a.json"]);
});
