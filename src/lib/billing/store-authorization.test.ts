/**
 * Saving a card never leaves a farm without a default one (storeAuthorization).
 *
 * The incumbent default stands down before the new card claims the flag (a partial unique
 * index allows one). If the new card then failed to save, the farm used to be left with no
 * default card at all, and the next renewal had nothing to charge. A fake database records
 * every write and fails the one the test names.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { VerifiedTransaction } from "./types";
import { storeAuthorization } from "./service";

type Call = { table: string; op: "select" | "update" | "insert"; values?: Record<string, unknown>; filters: string[] };

function fakeDatabase(fail: (call: Call) => boolean) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      const builder = {
        select: () => builder,
        update: (values: Record<string, unknown>) => ((call.op = "update"), (call.values = values), builder),
        insert: (values: Record<string, unknown>) => ((call.op = "insert"), (call.values = values), builder),
        eq: (column: string, value: unknown) => (call.filters.push(`${column}=${String(value)}`), builder),
        is: (column: string, value: unknown) => (call.filters.push(`${column} is ${String(value)}`), builder),
        in: (column: string, values: unknown[]) => (call.filters.push(`${column} in ${values.join(",")}`), builder),
        maybeSingle: () => builder,
        single: () => builder,
        then(resolve: (value: unknown) => void) {
          calls.push(call);
          if (fail(call)) return resolve({ data: null, error: { message: "boom", code: "08006" } });
          // The demotion answers with the card that stood down; an insert with its new id.
          if (call.op === "update" && call.values?.is_default === false) return resolve({ data: [{ id: "old-card" }], error: null });
          if (call.op === "insert") return resolve({ data: { id: "new-card" }, error: null });
          return resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const txn = {
  authorization: { authorizationCode: "AUTH_x", reusable: true, signature: null, brand: "visa", last4: "4242" },
  customerEmail: "owner@example.test",
  customerCode: "CUS_x",
} as unknown as VerifiedTransaction;

const restored = (calls: Call[]) =>
  calls.some((c) => c.op === "update" && c.values?.is_default === true && c.filters.includes("id in old-card"));

test("when the new card fails to save, the card it replaced is the default again", async () => {
  const db = fakeDatabase((call) => call.op === "insert");
  const result = await storeAuthorization(db.client, "farm-1", txn);
  assert.equal(result.paymentMethodId, null);
  assert.ok(result.reason);
  assert.ok(restored(db.calls), "the demoted card must be put back as the default");
});

test("when the new card saves, the old one stays stood down", async () => {
  const db = fakeDatabase(() => false);
  const result = await storeAuthorization(db.client, "farm-1", txn);
  assert.equal(result.paymentMethodId, "new-card");
  assert.equal(restored(db.calls), false);
});

test("when the old default cannot stand down, nothing else is written", async () => {
  const db = fakeDatabase((call) => call.op === "update" && call.values?.is_default === false);
  const result = await storeAuthorization(db.client, "farm-1", txn);
  assert.equal(result.paymentMethodId, null);
  assert.equal(db.calls.filter((c) => c.op === "insert").length, 0);
});
