/**
 * The contractor's "copy these vehicles across" claim (repeat-tap follow-up, rechecked by B3):
 * two presses both read `synced_at` empty; only the one whose conditional update lands goes
 * on. Driven through the real action with the framework, auth and Supabase stubbed. The
 * stubbed `partner_clients` update honours `synced_at is null` the way Postgres does.
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

const CLIENT = "c1000000-0000-4000-8000-000000000001";
const FARM = "c2000000-0000-4000-8000-000000000001";
let syncedAt: string | null = null;
let inserted = 0;

function partnerClients() {
  let update: Record<string, unknown> | null = null;
  let onlyUnsynced = false;
  const q = {
    select: () => q,
    eq: () => q,
    update: (values: Record<string, unknown>) => {
      update = values;
      return q;
    },
    is: (column: string, value: unknown) => {
      if (column === "synced_at" && value === null) onlyUnsynced = true;
      return q;
    },
    maybeSingle: async () => {
      if (!update) return { data: { id: CLIENT, farm_id: FARM, synced_at: null }, error: null };
      if (onlyUnsynced && syncedAt !== null) return { data: null, error: null };
      syncedAt = String(update.synced_at);
      return { data: { id: CLIENT }, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      if (update && "synced_at" in update && update.synced_at === null) syncedAt = null;
      resolve({ data: null, error: null });
    },
  };
  return q;
}
function vehicles() {
  const q = {
    select: () => q,
    eq: () => q,
    is: () => q,
    update: () => q,
    then: (resolve: (v: unknown) => void) =>
      resolve({ data: [{ id: "v1", name: "Truck", make: null, model: null, reg_no: null, serial_no: null, year: null, notes: null }], error: null }),
  };
  return q;
}
function machines() {
  const q = {
    insert: () => {
      inserted += 1;
      return q;
    },
    select: () => q,
    single: async () => ({ data: { id: `m${inserted}` }, error: null }),
  };
  return q;
}
const fakeClient = {
  from: (table: string) => (table === "partner_clients" ? partnerClients() : table === "machines" ? machines() : vehicles()),
};

const STUBS: Record<string, unknown> = {
  "next/navigation": { redirect: (url: string) => { throw new Redirect(url); } },
  "next/cache": { revalidatePath: () => undefined },
  "@/lib/auth": { requireRole: async () => ({ id: "p1", role: "workshop", workshop_id: "w1" }) },
  "@/lib/supabase/server": { createClient: async () => fakeClient },
  "@/lib/supabase/service": { createServiceClient: () => ({}) },
  "@/lib/billing/service": { vehicleSlotsFree: async () => null },
  "@/lib/observability": { captureError: () => undefined },
};
const load = createRequire(path.join(process.cwd(), "package.json"));
const Module = load("node:module") as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = Module._load;
Module._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return Object.prototype.hasOwnProperty.call(STUBS, request) ? STUBS[request] : realLoad.call(this, request, ...rest);
};
const actions = load(path.join(process.cwd(), "src", "app", "(app)", "contractor", "clients", "actions.ts")) as typeof import("./actions");

async function press(): Promise<string> {
  const fd = new FormData();
  fd.set("client_id", CLIENT);
  try {
    await actions.syncClientVehicles(fd);
  } catch (e) {
    if (e instanceof Redirect) return e.url;
    throw e;
  }
  throw new Error("no redirect");
}

test("two presses of the vehicle copy copy the fleet once", async () => {
  syncedAt = null;
  inserted = 0;
  // Both presses read synced_at empty (the read is stubbed to say so); only one claim lands.
  const [a, b] = await Promise.all([press(), press()]);
  assert.equal(inserted, 1, "the fleet is copied once");
  assert.deepEqual([a, b].sort(), [`/contractor/clients/${CLIENT}?error=already-synced`, `/contractor/clients/${CLIENT}?synced=1`].sort());
});
