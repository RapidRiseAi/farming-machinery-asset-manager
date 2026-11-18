/**
 * respondOnce (B3): paid work answered once per request id. Driven with an in-memory
 * `request_claims` behind the same three RPCs the database offers.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const STUBS: Record<string, unknown> = {
  "@/lib/supabase/server": { createClient: async () => ({}) },
  "@/lib/observability": { captureError: () => undefined },
};
const load = createRequire(path.join(process.cwd(), "package.json"));
const Module = load("node:module") as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = Module._load;
Module._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return Object.prototype.hasOwnProperty.call(STUBS, request) ? STUBS[request] : realLoad.call(this, request, ...rest);
};
const { respondOnce } = load(path.join(process.cwd(), "src", "lib", "request-claim.ts")) as typeof import("./request-claim");
const { REQUEST_CLAIM_OUTCOME_CHARS } = load(path.join(process.cwd(), "src", "lib", "limits.ts")) as typeof import("./limits");

function claimsDb() {
  const rows = new Map<string, { finished: boolean; outcome: string | null }>();
  const db = {
    rows,
    rpc: async (name: string, args: Record<string, unknown>) => {
      const id = String(args.p_request);
      const held = rows.get(id);
      if (name === "claim_request") {
        if (!held) {
          rows.set(id, { finished: false, outcome: null });
          return { data: { state: "new" }, error: null };
        }
        return { data: held.finished ? { state: "done", outcome: held.outcome } : { state: "running" }, error: null };
      }
      if (name === "finish_request" && held) Object.assign(held, { finished: true, outcome: String(args.p_outcome) });
      if (name === "release_request" && held && !held.finished) rows.delete(id);
      return { data: null, error: null };
    },
  };
  return db;
}

const ID = "e1000000-0000-4000-8000-000000000001";
const busy = () => new Response(JSON.stringify({ error: "still_working" }), { status: 409 });
const keepAnswers = (text: string) => (JSON.parse(text) as { kind?: string }).kind !== "error";

test("an answer is worked out once and given back to the retry", async () => {
  const db = claimsDb();
  let runs = 0;
  const work = async () => {
    runs += 1;
    return Response.json({ kind: "answer", text: `answer ${runs}` });
  };
  // @ts-expect-error the fake client has only rpc
  const first = await respondOnce(db, ID, "assistant:turn", work, { whileRunning: busy, keep: keepAnswers });
  // @ts-expect-error the fake client has only rpc
  const replay = await respondOnce(db, ID, "assistant:turn", work, { whileRunning: busy, keep: keepAnswers });
  assert.equal(runs, 1, "the paid work ran once");
  assert.deepEqual(await replay.json(), await first.json());
});

test("a refusal, a failure or an answer too large to keep releases the id, so the retry runs", async () => {
  for (const make of [
    () => Response.json({ kind: "error", code: "ai_paused" }),
    () => Response.json({ kind: "error" }, { status: 503 }),
    () => Response.json({ kind: "answer", text: "x".repeat(REQUEST_CLAIM_OUTCOME_CHARS) }),
  ]) {
    const db = claimsDb();
    let runs = 0;
    const work = async () => {
      runs += 1;
      return make();
    };
    // @ts-expect-error the fake client has only rpc
    await respondOnce(db, ID, "assistant:turn", work, { whileRunning: busy, keep: keepAnswers });
    // @ts-expect-error the fake client has only rpc
    await respondOnce(db, ID, "assistant:turn", work, { whileRunning: busy, keep: keepAnswers });
    assert.equal(runs, 2);
    assert.equal(db.rows.size, 0, "nothing kept that could not be given again");
  }
});

test("a request arriving while the first still runs does no work", async () => {
  const db = claimsDb();
  db.rows.set(ID, { finished: false, outcome: null });
  let runs = 0;
  // @ts-expect-error the fake client has only rpc
  const answer = await respondOnce(db, ID, "assistant:transcribe", async () => {
    runs += 1;
    return Response.json({ hearings: [] });
  }, { whileRunning: busy });
  assert.equal(answer.status, 409);
  assert.equal(runs, 0);
});

test("work that throws releases its claim", async () => {
  const db = claimsDb();
  await assert.rejects(
    // @ts-expect-error the fake client has only rpc
    respondOnce(db, ID, "assistant:turn", async () => {
      throw new Error("provider down");
    }, { whileRunning: busy }),
  );
  assert.equal(db.rows.size, 0);
});
