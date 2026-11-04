/**
 * The finance actions gate the farm of the record they change (review round 5, finding
 * gate-2), driven through the real actions with the framework, the auth helpers and the
 * Supabase client stubbed, in the style of admin/billing/actions.test.ts.
 *
 * The case that mattered: a person on two farms, working in the paid one (the farm in use
 * answers "ok"), changes a paused farm's agreement or contract from a tab opened on it, or
 * by a direct POST. The farm in use was the only one gated, so the write went through.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

class Redirect extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

const OWNER = "f7a00000-0000-0000-0000-000000000001";
const PAID = "f7000000-0000-0000-0000-000000000001"; // the farm in use: its gate is ok
const PAUSED = "f7000000-0000-0000-0000-000000000002"; // the record's farm: paused
const RECORD = "f7800000-0000-0000-0000-000000000001";

let recordFarm = PAUSED;
const gated: string[] = [];
const rpcs: string[] = [];

const fakeClient = {
  rpc: async (name: string) => {
    rpcs.push(name);
    return { data: null, error: null };
  },
  from: (table: string) => {
    const query: Record<string, unknown> = {
      select: () => query,
      eq: () => query,
      in: () => query,
      is: () => query,
      maybeSingle: async () => ({ data: { id: RECORD, farm_id: recordFarm }, error: null }),
      // A write awaited directly (the document's soft delete): recorded like an RPC.
      update: () => {
        rpcs.push(`update:${table}`);
        return query;
      },
      then: (resolve: (value: unknown) => unknown) => resolve({ data: null, error: null }),
    };
    return query;
  },
};

const STUBS: Record<string, unknown> = {
  "next/navigation": {
    redirect: (url: string) => {
      throw new Redirect(url);
    },
  },
  "next/cache": { revalidatePath: () => undefined },
  "@/lib/auth": {
    requireProfile: async () => ({ id: OWNER, role: "owner", farm_id: PAID, lang: "en" }),
    currentFarmId: async () => PAID,
    // The real helper sends a stopped farm to its page; here only the paused farm is stopped.
    requireUsableFarm: async (farmId: string | null) => {
      gated.push(String(farmId));
      if (farmId === PAUSED) throw new Redirect(`/suspended?farm=${farmId}`);
    },
  },
  "@/lib/supabase/server": { createClient: async () => fakeClient },
  "@/lib/request-claim": {
    // The real one claims a request id first; the work and its redirect are what matter here.
    runOnce: async (_fd: FormData, _key: string, work: () => Promise<string>) => {
      throw new Redirect(await work());
    },
  },
  "@/lib/asset-finance-read": { canViewFarmFinance: async () => true },
  "@/lib/observability": { captureError: () => undefined },
};

const load = createRequire(path.join(process.cwd(), "package.json"));
const Module = load("node:module") as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = Module._load;
Module._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return Object.prototype.hasOwnProperty.call(STUBS, request) ? STUBS[request] : realLoad.call(this, request, ...rest);
};

const actions = load(path.join(process.cwd(), "src", "app", "(app)", "finance", "actions.ts")) as typeof import("./actions");

async function run(action: (fd: FormData) => Promise<unknown>, fields: Record<string, string>): Promise<string> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await action(fd);
  } catch (e) {
    if (e instanceof Redirect) return e.url;
    throw e;
  }
  throw new Error("the action returned without redirecting");
}

function reset(farm: string): void {
  recordFarm = farm;
  gated.length = 0;
  rpcs.length = 0;
}

const BY_ID: Array<[string, (fd: FormData) => Promise<unknown>, Record<string, string>]> = [
  ["updateFinanceAgreement", actions.updateFinanceAgreement, { agreement_id: RECORD }],
  ["recordStatementBalance", actions.recordStatementBalance, { agreement_id: RECORD }],
  ["recordFinancePayment", actions.recordFinancePayment, { instalment_id: RECORD }],
  ["clearFinancePayment", actions.clearFinancePayment, { instalment_id: RECORD }],
  ["updateFinanceInstalment", actions.updateFinanceInstalment, { instalment_id: RECORD }],
  ["regenerateFinanceSchedule", actions.regenerateFinanceSchedule, { agreement_id: RECORD }],
  ["settleFinanceAgreement", actions.settleFinanceAgreement, { agreement_id: RECORD }],
  ["deleteFinanceAgreement", actions.deleteFinanceAgreement, { agreement_id: RECORD }],
  ["updateContract", actions.updateContract, { contract_id: RECORD }],
  ["endContract", actions.endContract, { contract_id: RECORD }],
  ["renewContract", actions.renewContract, { contract_id: RECORD }],
  ["deleteContract", actions.deleteContract, { contract_id: RECORD }],
  ["removeFinanceDocument", actions.removeFinanceDocument, { document_id: RECORD }],
];

test("every by-id finance action sends a paused record's farm to its stopped page, and writes nothing", async () => {
  for (const [name, action, fields] of BY_ID) {
    reset(PAUSED);
    const url = await run(action, fields);
    assert.equal(url, `/suspended?farm=${PAUSED}`, `${name} is stopped on the record's farm`);
    assert.ok(gated.includes(PAUSED), `${name} gates the record's farm, not only the farm in use`);
    assert.deepEqual(rpcs, [], `${name} wrote nothing`);
  }
});

test("a record on the farm in use is gated on that farm and goes on to the save", async () => {
  for (const [name, action, fields] of BY_ID) {
    reset(PAID);
    const url = await run(action, fields);
    assert.ok(!url.startsWith("/suspended"), `${name} is not stopped (${url})`);
    assert.ok(gated.every((f) => f === PAID), `${name} gated only the paid farm (${gated.join(", ")})`);
  }
});

test("a contract created for a paused farm named in the form is stopped before it is saved", async () => {
  reset(PAUSED);
  const url = await run(actions.createContract, { farm_id: PAUSED });
  assert.equal(url, `/suspended?farm=${PAUSED}`);
  assert.deepEqual(rpcs, [], "asset_contract_save was not called");
});
