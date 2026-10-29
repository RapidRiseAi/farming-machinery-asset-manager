/**
 * Rapid Rise's billing actions, driven for real, with the framework, the session and the
 * database replaced by recording fakes.
 *
 * == Why the real actions and not a copy of their arithmetic ==================
 * Every defect pinned here lived in how an action put its pieces together, not in any one
 * piece: `errorCode()` encoded the code, `bounce()` encoded it again (app-2), and each was
 * right on its own. So the actions run as written. `redirect` throws the address it was
 * given, the Supabase client is an in-memory fake, and what the admin would read is
 * worked out the way the page does it: the query decoded once by `URL`, then
 * `errorMessage()`.
 *
 * Module stubs go in through `Module._load`, keyed by the specifier the source imports,
 * so they cannot miss on a path spelled differently; `node --test` runs each file in its
 * own process, so they reach no other suite. No fake here can reach a network.
 *
 * Pinned, from the third billing review: every refusal the four admin RPCs raise reaches
 * the admin as its own sentence, in both languages, with the farm still open (app-2,
 * app-7); a lost answer never deletes the proof of a payment that was recorded (app-3);
 * "1,500" is R1 500 and an amount that reads two ways is refused (app-5).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";

// == Fakes ====================================================================

class Redirect extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

type Failure = { message: string; code?: string };
type Result = { data: unknown; error: Failure | null };
type Call = { kind: string; args: unknown[] };

const calls: Call[] = [];
let rpcResult: Result = { data: null, error: null };
let lookupResult: Result = { data: [], error: null };
let lookupThrows = false;
let uploadError: Failure | null = null;
let role = "rr_admin";

const ADMIN = "e9a00000-0000-0000-0000-000000000009";
const FARM = "e9000000-0000-0000-0000-000000000001";
const INVOICE = "e9800000-0000-0000-0000-000000000001";
const PAYMENT = "e9900000-0000-0000-0000-000000000001";
const SUBSCRIPTION = "e9700000-0000-0000-0000-000000000001";

const fakeClient = {
  storage: {
    from: (bucket: string) => ({
      upload: async (p: string) => {
        calls.push({ kind: "upload", args: [bucket, p] });
        return uploadError ? { data: null, error: uploadError } : { data: { path: p }, error: null };
      },
      remove: async (paths: string[]) => {
        calls.push({ kind: "remove", args: [bucket, paths] });
        return { data: [], error: null };
      },
    }),
  },
  rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ kind: "rpc", args: [name, args] });
    return rpcResult;
  },
  from: (table: string) => {
    const query = {
      select: (columns: string) => {
        calls.push({ kind: "select", args: [table, columns] });
        return query;
      },
      eq: (column: string, value: unknown) => {
        calls.push({ kind: "eq", args: [table, column, value] });
        return query;
      },
      limit: async () => {
        if (lookupThrows) throw new TypeError("fetch failed");
        return lookupResult;
      },
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
  "next/cache": { revalidatePath: (p: string) => calls.push({ kind: "revalidate", args: [p] }) },
  "@/lib/auth": { requireProfile: async () => ({ id: ADMIN, role, lang: "en" }) },
  "@/lib/observability": { captureError: (...args: unknown[]) => calls.push({ kind: "captureError", args }) },
  "@/lib/supabase/service": { createServiceClient: () => fakeClient },
  // Not exercised here; stubbed so the provider adapter is never loaded at all.
  "@/lib/billing/worker": { reconcileAttemptById: async () => ({}), retryInvoiceCharge: async () => ({}) },
};

const load = createRequire(path.join(process.cwd(), "package.json"));
const Module = load("node:module") as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = Module._load;
Module._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return Object.prototype.hasOwnProperty.call(STUBS, request) ? STUBS[request] : realLoad.call(this, request, ...rest);
};

const actions = load(path.join(process.cwd(), "src", "app", "(app)", "admin", "billing", "actions.ts")) as typeof import("./actions");

// == Helpers ==================================================================

function reset(): void {
  calls.length = 0;
  rpcResult = { data: null, error: null };
  lookupResult = { data: [], error: null };
  lookupThrows = false;
  uploadError = null;
  role = "rr_admin";
}

async function run(action: (fd: FormData) => Promise<void>, fd: FormData): Promise<URL> {
  try {
    await action(fd);
  } catch (e) {
    if (e instanceof Redirect) return new URL(e.url, "http://localhost");
    throw e;
  }
  throw new Error("the action returned without redirecting");
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function paymentForm(over: Record<string, string> = {}): FormData {
  const fd = form({
    farm_id: FARM,
    invoice_id: INVOICE,
    method: "eft",
    reference: "FNB 123",
    received_on: "2026-10-28",
    amount: "1500",
    ...over,
  });
  fd.set("proof", new File([new Uint8Array([37, 80, 68, 70])], "pop.pdf", { type: "application/pdf" }));
  return fd;
}

function serviceForm(price = "1500", qty = "1"): FormData {
  return form({ farm_id: FARM, line_0_code: "training", line_0_description: "Training", line_0_qty: qty, line_0_price: price });
}

const reverseForm = () => form({ farm_id: FARM, payment_id: PAYMENT, reason: "Bounced EFT" });
const extendForm = () => form({ farm_id: FARM, until: "2026-11-15", reason: "EFT confirmed by the bank" });

const rpcCall = () => calls.find((c) => c.kind === "rpc")?.args[1] as Record<string, unknown> | undefined;
const count = (kind: string) => calls.filter((c) => c.kind === kind).length;

/** What the admin reads, in both languages, and which farm the page reopens on. */
function shown(url: URL) {
  const code = url.searchParams.get("error");
  return { en: errorMessage(code, "en"), af: errorMessage(code, "af"), farm: url.searchParams.get("farm") };
}

// == Every refusal, as its own sentence (app-2, app-7) ========================
//
// Every refusal the four RPCs raise, from their latest definitions. The table is checked
// against the migrations below, so a refusal added later without a sentence fails here.

type Act = "record" | "reverse" | "service" | "extend";

const REFUSALS: { act: Act; code: string; message: string; key: string }[] = [
  // app.billing_record_manual_payment (20261029100000)
  { act: "record", code: "42501", message: "Rapid Rise only", key: "errors.forbidden" },
  { act: "record", code: "22023", message: "BILLING: choose how it was paid", key: "errors.billingManualMethod" },
  { act: "record", code: "22023", message: "BILLING: the bank reference is needed", key: "errors.billingManualReference" },
  { act: "record", code: "22023", message: "BILLING: the date received must be within the last year", key: "errors.billingManualDate" },
  { act: "record", code: "22023", message: "BILLING: attach the proof of payment", key: "errors.billingManualProof" },
  { act: "record", code: "22023", message: "BILLING: no such invoice", key: "errors.billingNoSuchInvoice" },
  { act: "record", code: "22023", message: "BILLING: only an open invoice can be paid", key: "errors.billingManualNotOpen" },
  { act: "record", code: "22023", message: "BILLING: the amount must be more than nothing and no more than is owed", key: "errors.billingManualAmount" },
  { act: "record", code: "22023", message: "BILLING: a card payment is still in flight on this invoice", key: "errors.billingManualInFlight" },
  { act: "record", code: "23505", message: "BILLING: that bank reference is already recorded", key: "errors.billingManualDuplicate" },
  // app.billing_reverse_manual_payment (20261029130000)
  { act: "reverse", code: "42501", message: "Rapid Rise only", key: "errors.forbidden" },
  { act: "reverse", code: "22023", message: "BILLING: say why the payment is reversed", key: "errors.billingManualReason" },
  { act: "reverse", code: "22023", message: "BILLING: only a payment recorded by hand can be reversed here", key: "errors.billingManualNotManual" },
  { act: "reverse", code: "22023", message: "BILLING: that payment is already reversed", key: "errors.billingManualReversed" },
  // app.billing_raise_service_invoice (20261029120000)
  { act: "service", code: "42501", message: "Rapid Rise only", key: "errors.forbidden" },
  { act: "service", code: "22023", message: "BILLING: no such farm", key: "errors.billingNoSuchFarm" },
  { act: "service", code: "22023", message: "BILLING: add between one and twenty lines", key: "errors.billingServiceLines" },
  { act: "service", code: "22023", message: "BILLING: the due date must be within the next 120 days", key: "errors.billingServiceDue" },
  { act: "service", code: "22023", message: "BILLING: every line needs a description", key: "errors.billingServiceDescription" },
  { act: "service", code: "22023", message: "BILLING: a quantity must be from 1 to 10000", key: "errors.billingServiceQty" },
  { act: "service", code: "22023", message: "BILLING: a price must be from R0 to R1 000 000", key: "errors.billingServicePrice" },
  { act: "service", code: "22023", message: "BILLING: an invoice for nothing is not sent", key: "errors.billingServiceNothing" },
  // public.admin_extend_billing_access (20261029140000), plus its paused-or-overdue rule.
  { act: "extend", code: "42501", message: "Rapid Rise only", key: "errors.forbidden" },
  { act: "extend", code: "22023", message: "BILLING: extend access by up to 60 days", key: "errors.billingExtendBad" },
  { act: "extend", code: "22023", message: "BILLING: say why access is extended", key: "errors.billingExtendReason" },
  { act: "extend", code: "22023", message: "BILLING: no subscription", key: "errors.billingNoSubscription" },
  { act: "extend", code: "22023", message: "BILLING: only a paused or overdue farm can be kept open", key: "errors.billingExtendNotOverdue" },
];

const ACTS: Record<Act, { action: (fd: FormData) => Promise<void>; form: () => FormData }> = {
  record: { action: actions.adminRecordPayment, form: () => paymentForm() },
  reverse: { action: actions.adminReversePayment, form: reverseForm },
  service: { action: actions.adminRaiseServiceInvoice, form: () => serviceForm() },
  extend: { action: actions.adminExtendAccess, form: extendForm },
};

for (const r of REFUSALS) {
  test(`${r.act}: "${r.message}" reaches the admin as its own sentence, on the farm`, async () => {
    reset();
    rpcResult = { data: null, error: { code: r.code, message: r.message } };
    const url = await run(ACTS[r.act].action, ACTS[r.act].form());
    const s = shown(url);
    assert.equal(s.en, t(r.key, "en"), `${url.pathname}${url.search}`);
    assert.equal(s.af, t(r.key, "af"));
    assert.notEqual(s.en, t("errors.generic", "en"), "fell back to the generic apology");
    assert.equal(s.farm, FARM, "the farm panel (and the dialog) would be gone");
  });
}

/** `raise exception '...'` messages in the latest definition of each named function. */
function raisedBy(names: string[]): Set<string> {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const latest = new Map<string, string>();
  for (const f of files) {
    const sql = readFileSync(path.join(dir, f), "utf8");
    for (const name of names) {
      for (const schema of ["app", "public"]) {
        const head = new RegExp(`create or replace function ${schema}\\.${name}\\s*\\(`, "g");
        for (const m of sql.matchAll(head)) {
          const at = m.index ?? 0;
          const tag = /as (\$[a-z_]*\$)/.exec(sql.slice(at));
          assert.ok(tag, `no body found for ${schema}.${name} in ${f}`);
          const start = at + tag.index + tag[0].length;
          latest.set(`${schema}.${name}`, sql.slice(start, sql.indexOf(tag[1], start)));
        }
      }
    }
  }
  const out = new Set<string>();
  for (const body of latest.values()) {
    for (const m of body.matchAll(/raise exception '([^']+)'/g)) out.add(m[1]);
  }
  return out;
}

test("every refusal the four RPCs raise is in the table above", () => {
  const raised = raisedBy([
    "billing_record_manual_payment",
    "billing_reverse_manual_payment",
    "billing_raise_service_invoice",
    "admin_extend_billing_access",
  ]);
  assert.ok(raised.size >= 20, `only ${raised.size} refusals found: the reader no longer matches the migrations`);
  const known = new Set(REFUSALS.map((r) => r.message));
  for (const message of raised) assert.ok(known.has(message), `"${message}" has no sentence in the table`);
});

test("a literal code is encoded once too, and still carries the farm", async () => {
  reset();
  const url = await run(actions.adminReversePayment, form({ farm_id: FARM, payment_id: PAYMENT, reason: "" }));
  assert.equal(url.searchParams.get("error"), "billing-manual-reason");
  assert.equal(shown(url).en, t("errors.billingManualReason", "en"));
  assert.equal(shown(url).farm, FARM);
});

test("only a well-formed farm id is carried back", async () => {
  reset();
  const url = await run(actions.adminExtendAccess, form({ farm_id: "not-a-farm", until: "2026-11-15", reason: "x" }));
  assert.equal(url.searchParams.get("error"), "missing-id");
  assert.equal(url.searchParams.get("farm"), null);
});

test("a non-admin is refused, and the role check is the first thing", async () => {
  reset();
  role = "owner";
  const url = await run(actions.adminRecordPayment, paymentForm());
  assert.equal(shown(url).en, t("errors.forbidden", "en"));
  assert.equal(count("upload") + count("rpc"), 0);
});

test("Keep open returns to the farm it was done for (app-7)", async () => {
  reset();
  const url = await run(actions.adminExtendAccess, extendForm());
  assert.equal(`${url.pathname}${url.search}`, `/admin/billing?farm=${FARM}&saved=access-extended`);
  assert.deepEqual(rpcCall(), { p_farm: FARM, p_until: "2026-11-15", p_reason: "EFT confirmed by the bank", p_by: ADMIN });
});

// == The proof outlives a lost answer (app-3) =================================

test("a refusal removes the proof it uploaded, without asking", async () => {
  reset();
  rpcResult = { data: null, error: { code: "23505", message: "BILLING: that bank reference is already recorded" } };
  await run(actions.adminRecordPayment, paymentForm());
  const uploaded = calls.find((c) => c.kind === "upload")?.args[1];
  assert.deepEqual(calls.find((c) => c.kind === "remove")?.args, ["billing-proofs", [uploaded]]);
  assert.equal(count("select"), 0, "a refusal proves nothing was written; there is nothing to ask");
});

test("a lost answer after the payment landed keeps the proof and says it was recorded", async () => {
  reset();
  rpcResult = { data: null, error: { message: "TypeError: fetch failed", code: "" } };
  lookupResult = { data: [{ id: PAYMENT }], error: null };
  const url = await run(actions.adminRecordPayment, paymentForm());
  const uploaded = calls.find((c) => c.kind === "upload")?.args[1];
  assert.equal(count("remove"), 0, "the proof of a recorded payment was deleted");
  assert.deepEqual(calls.find((c) => c.kind === "eq")?.args, ["billing_payments", "proof_path", uploaded]);
  assert.equal(`${url.pathname}${url.search}`, `/admin/billing?farm=${FARM}&saved=payment-recorded`);
  assert.equal(count("captureError"), 1, "a lost answer is ours to hear about");
});

test("a lost answer with no payment behind it removes the proof and asks for a retry", async () => {
  reset();
  rpcResult = { data: null, error: { message: "TypeError: fetch failed", code: "" } };
  lookupResult = { data: [], error: null };
  const url = await run(actions.adminRecordPayment, paymentForm());
  assert.equal(count("remove"), 1);
  assert.equal(shown(url).en, t("interaction.actionFailed", "en"));
  assert.equal(shown(url).farm, FARM);
  assert.equal(count("captureError"), 1, "reported once, not once per layer");
});

test("a lost answer whose check fails too keeps the proof, whether the check errs or throws", async () => {
  for (const throws of [false, true]) {
    reset();
    rpcResult = { data: null, error: { message: "TypeError: fetch failed", code: "" } };
    lookupResult = { data: null, error: { message: "TypeError: fetch failed", code: "" } };
    lookupThrows = throws;
    const url = await run(actions.adminRecordPayment, paymentForm());
    assert.equal(count("remove"), 0, "an orphan file costs nothing; a payment without its proof cannot be put right");
    assert.equal(shown(url).en, t("interaction.actionFailed", "en"));
    assert.equal(shown(url).farm, FARM);
    assert.equal(count("captureError"), 2);
  }
});

test("a proof that cannot be stored is said in words, and nothing is recorded", async () => {
  reset();
  uploadError = { message: "Bucket not found" };
  const url = await run(actions.adminRecordPayment, paymentForm());
  assert.equal(shown(url).en, t("errors.billingManualProofFailed", "en"));
  assert.equal(shown(url).farm, FARM);
  assert.equal(count("rpc"), 0);
  assert.equal(count("captureError"), 1);
});

// == "1,500" is one thousand five hundred (app-5) =============================

for (const [typed, cents] of [
  ["1,500", 150000],
  ["1 500,50", 150050],
  ["1500", 150000],
  ["250,50", 25050],
  ["R1 500.00", 150000],
  ["1,500.50", 150050],
] as const) {
  test(`a payment typed "${typed}" is recorded as ${cents} cents`, async () => {
    reset();
    rpcResult = { data: PAYMENT, error: null };
    await run(actions.adminRecordPayment, paymentForm({ amount: typed }));
    assert.equal(rpcCall()?.p_amount_cents, cents);
  });
}

for (const typed of ["1,2345", "1.500", "1.505", "1,500,50", "abc"]) {
  test(`a payment typed "${typed}" reads two ways (or none) and is refused before anything is stored`, async () => {
    reset();
    const url = await run(actions.adminRecordPayment, paymentForm({ amount: typed }));
    assert.equal(shown(url).en, t("errors.billingAmountUnclear", "en"));
    assert.equal(shown(url).farm, FARM);
    assert.equal(count("upload") + count("rpc"), 0);
  });
}

for (const typed of ["", "0", "-5"]) {
  test(`a payment of "${typed}" is refused as no amount`, async () => {
    reset();
    const url = await run(actions.adminRecordPayment, paymentForm({ amount: typed }));
    assert.equal(shown(url).en, t("errors.billingManualBad", "en"));
    assert.equal(count("upload") + count("rpc"), 0);
  });
}

test("a service price is read the same way: '1,500' is R1 500 a unit", async () => {
  reset();
  rpcResult = { data: INVOICE, error: null };
  const url = await run(actions.adminRaiseServiceInvoice, serviceForm("1,500", "2"));
  assert.equal(`${url.pathname}${url.search}`, `/admin/billing?farm=${FARM}&saved=service-invoice`);
  assert.deepEqual(rpcCall()?.p_lines, [{ code: "training", description: "Training", qty: 2, unit_price_cents: 150000 }]);
});

test("a service price that reads two ways, or none, is refused with its own sentence", async () => {
  for (const [price, key] of [
    ["1,2345", "errors.billingAmountUnclear"],
    ["", "errors.billingServiceBad"],
    ["-1", "errors.billingServiceBad"],
  ] as const) {
    reset();
    const url = await run(actions.adminRaiseServiceInvoice, serviceForm(price));
    assert.equal(shown(url).en, t(key, "en"), `price "${price}"`);
    assert.equal(shown(url).farm, FARM);
    assert.equal(count("rpc"), 0);
  }
});

test("a quantity too big for the database is refused in its words, not as a failure", async () => {
  reset();
  const url = await run(actions.adminRaiseServiceInvoice, serviceForm("100", "3000000000"));
  assert.equal(shown(url).en, t("errors.billingServiceQty", "en"));
  assert.equal(count("rpc"), 0);
});

test("a fixed deal is read the same way: '1,500' off is R1 500 off", async () => {
  reset();
  await run(actions.adminSetDiscount, form({ subscription_id: SUBSCRIPTION, rands: "1,500" }));
  assert.equal(rpcCall()?.p_fixed_cents, 150000);
  reset();
  const url = await run(actions.adminSetDiscount, form({ subscription_id: SUBSCRIPTION, rands: "1,2345" }));
  assert.equal(shown(url).en, t("errors.billingAmountUnclear", "en"));
  assert.equal(count("rpc"), 0);
});
