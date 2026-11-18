/**
 * A work-request file and amount saved once per capture (B3, repeat-tap follow-up): the
 * route driven for real, with the framework's auth, Supabase and the upload pipeline stubbed
 * and the real request-claim module claiming against an in-memory `request_claims`.
 *
 * The case: the answer to a save is lost on farm signal and the form sends the same capture
 * again. The file was finalised once by its upload id, but the amount and its note went
 * through update_work_request a second time (a second event row, a second status move).
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const OWNER = "f7a00000-0000-4000-8000-000000000001";
const FARM = "f7000000-0000-4000-8000-000000000001";
const REQUEST = "f7800000-0000-4000-8000-000000000001";

type ClaimRow = { action: string; finished: boolean; outcome: string | null };
const claims = new Map<string, ClaimRow>();
const updates: Record<string, unknown>[] = [];
let failUpdate = false;

const workRequests = {
  select: () => workRequests,
  eq: () => workRequests,
  is: () => workRequests,
  maybeSingle: async () => ({
    data: { id: REQUEST, farm_id: FARM, machine_id: "m", workshop_id: "w", status: "accepted", vat_rate_bps: 1500 },
    error: null,
  }),
};
const documents = {
  select: () => documents,
  eq: () => documents,
  neq: () => documents,
  is: () => documents,
  limit: async () => ({ data: [], error: null }),
};
const fakeClient = {
  from: (table: string) => (table === "work_requests" ? workRequests : documents),
  rpc: async (name: string, args: Record<string, unknown>) => {
    const id = String(args.p_request ?? "");
    if (name === "claim_request") {
      const held = claims.get(id);
      if (!held) {
        claims.set(id, { action: String(args.p_action), finished: false, outcome: null });
        return { data: { state: "new" }, error: null };
      }
      return { data: held.finished ? { state: "done", outcome: held.outcome } : { state: "running" }, error: null };
    }
    if (name === "finish_request") {
      const held = claims.get(id);
      if (held) Object.assign(held, { finished: true, outcome: String(args.p_outcome) });
      return { data: null, error: null };
    }
    if (name === "release_request") {
      if (!claims.get(id)?.finished) claims.delete(id);
      return { data: null, error: null };
    }
    if (name === "update_work_request") {
      updates.push(args);
      return failUpdate ? { data: null, error: { code: "XX000", message: "boom" } } : { data: id, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  },
};

const STUBS: Record<string, unknown> = {
  "@/lib/auth": {
    getProfile: async () => ({ id: OWNER, role: "owner", active: true, farm_id: FARM, lang: "en" }),
    effectiveFarmRole: async () => "owner",
    farmIsUsable: async () => true,
  },
  "@/lib/supabase/server": { createClient: async () => fakeClient },
  "@/lib/supabase/service": { createServiceClient: () => ({}) },
  "@/lib/security/same-origin": { sameOrigin: () => true },
  "@/lib/workrequest-media": { uploadWorkRequestMedia: async () => false },
  "@/lib/work-lifecycle": { canRecordWorkAmount: () => true },
  "@/lib/observability": { captureError: () => undefined },
  "@/lib/upload/server": {
    verifiedIntentFor: async () => ({ state: "verified", intent: { media_class: "pdf" }, svc: {} }),
    commitUpload: async () => ({ state: "finalised", recordId: null }),
  },
};
const load = createRequire(path.join(process.cwd(), "package.json"));
const Module = load("node:module") as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = Module._load;
Module._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return Object.prototype.hasOwnProperty.call(STUBS, request) ? STUBS[request] : realLoad.call(this, request, ...rest);
};
const route = load(path.join(process.cwd(), "src", "app", "api", "work", "media", "route.ts")) as typeof import("./route");

function post(requestId: string | null): Request {
  const fd = new FormData();
  fd.set("work_request_id", REQUEST);
  fd.set("kind", "invoice");
  fd.set("amount", "1150");
  fd.set("note", "Pump repair");
  fd.set("upload_intent_id", "f7900000-0000-4000-8000-000000000001");
  if (requestId) fd.set("request_id", requestId);
  return new Request("https://app.fleetwise.test/api/work/media", { method: "POST", body: fd });
}

test("a retried capture records its amount once and gets the first answer back", async () => {
  claims.clear();
  updates.length = 0;
  failUpdate = false;
  const id = "f7c00000-0000-4000-8000-000000000001";
  const first = await route.POST(post(id));
  assert.equal(first.status, 200);
  const replay = await route.POST(post(id));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), await first.json());
  assert.equal(updates.length, 1, "the amount and note go through once");
  // A new capture is a new save.
  await route.POST(post("f7c00000-0000-4000-8000-000000000002"));
  assert.equal(updates.length, 2);
});

test("a save that fails releases its id, so the retry runs again", async () => {
  claims.clear();
  updates.length = 0;
  failUpdate = true;
  const id = "f7c00000-0000-4000-8000-000000000003";
  const failed = await route.POST(post(id));
  assert.equal(failed.status, 500);
  assert.equal(claims.has(id), false, "a failure must not be remembered as the answer");
  failUpdate = false;
  const retry = await route.POST(post(id));
  assert.equal(retry.status, 200);
  assert.equal(updates.length, 2);
});

test("a retry while the first is still saving is told so and records nothing", async () => {
  claims.clear();
  updates.length = 0;
  failUpdate = false;
  const id = "f7c00000-0000-4000-8000-000000000004";
  claims.set(id, { action: "work:media", finished: false, outcome: null });
  const busy = await route.POST(post(id));
  assert.equal(busy.status, 409);
  assert.equal(updates.length, 0);
});

test("an older page without an id still saves, as before", async () => {
  claims.clear();
  updates.length = 0;
  failUpdate = false;
  const answer = await route.POST(post(null));
  assert.equal(answer.status, 200);
  assert.equal(updates.length, 1);
});
