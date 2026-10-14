import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { takeSharedRateLimit } from "./rate-limit";

function client(rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const supabase = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return rpc(name, args);
    },
  } as unknown as SupabaseClient;
  return { supabase, calls };
}

test("asks the database with the scope, window and maximum, and passes its answer on", async () => {
  const c = client(async () => ({ data: [{ allowed: false, retry_after: 42 }], error: null }));
  const r = await takeSharedRateLimit(c.supabase, "transcribe", 60, 12);
  assert.deepEqual(r, { allowed: false, retryAfter: 42 });
  assert.deepEqual(c.calls, [{ name: "rate_limit_take", args: { p_scope: "transcribe", p_window_seconds: 60, p_max: 12 } }]);
});

test("an allowed answer is allowed", async () => {
  const c = client(async () => ({ data: [{ allowed: true, retry_after: 7 }], error: null }));
  assert.deepEqual(await takeSharedRateLimit(c.supabase, "speech_token", 60, 6), { allowed: true, retryAfter: 7 });
});

test("a database error lets the request through rather than stopping dictation", async () => {
  const errored = client(async () => ({ data: null, error: { message: "connection reset" } }));
  assert.deepEqual(await takeSharedRateLimit(errored.supabase, "transcribe", 60, 12), { allowed: true, retryAfter: 0 });
  const threw = client(async () => { throw new Error("socket hang up"); });
  assert.deepEqual(await takeSharedRateLimit(threw.supabase, "transcribe", 60, 12), { allowed: true, retryAfter: 0 });
});
