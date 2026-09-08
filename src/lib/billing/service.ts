/**
 * SaaS billing — the service-role data layer.
 *
 * Everything in this file runs with the service key. `billing_*` tables grant the
 * browser SELECT only (and `billing_payment_methods` withholds the credential columns at
 * the COLUMN level), so every write in the billing system passes through here after a
 * route or action has already re-checked the caller's role.
 *
 * ── Why these are RPC names and not `app.*` calls ────────────────────────────
 * PostgREST exposes `public` and `graphql_public` only; a call into schema `app` answers
 * PGRST106. Every engine function the migrations define lives in `app`, so the ones the
 * worker needs are reached through thin `public.*` wrappers, exactly as the fourteen
 * nightly engines already are. `BILLING_RPC` is the single place those names appear, so
 * a rename is one edit rather than a hunt.
 *
 * That gap was real and shipped: `app.due_billing_charges`, `app.claim_billing_charge`,
 * `app.settle_billing_attempt` and `app.generate_billing_invoices(uuid)` went out with no
 * `public.*` wrapper at all, so every call on the charging path answered PGRST202 and the
 * whole feature was unreachable. Migration `20260906120000` adds them. Nothing here
 * caught it — the tests in this directory mock the Supabase client, so they assert the
 * ARGUMENTS and never that the function exists — which is why the isolation suite now
 * carries section (m), asserting each name AND its parameter names against `pg_proc`.
 * If you add an entry below, add it there in the same commit.
 *
 * ── The credential rule ──────────────────────────────────────────────────────
 * `authorization_code` / `authorization_email` are a charging credential. They are read
 * in exactly one function here, passed straight to the adapter, and never returned to a
 * caller, put in an error, or logged. `redactMessage` exists so that a provider or
 * Postgres message can be recorded as evidence without carrying one along with it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

import type {
  ChargeRequest,
  CheckoutInit,
  SaasBillingProvider,
  VerifiedTransaction,
} from "./types";

/** Names of the `public.*` wrappers over the `app.*` billing engine. */
export const BILLING_RPC = {
  dueCharges: "billing_due_charges",
  claimCharge: "billing_claim_charge",
  settleAttempt: "billing_settle_attempt",
  generateInvoices: "billing_generate_invoices",
  captureSnapshots: "cron_capture_billing_snapshots",
  cronGenerateInvoices: "cron_generate_billing_invoices",
  applyDowngrades: "cron_apply_billing_downgrades",
  closeCancellations: "cron_close_billing_cancellations",
  enqueueReminders: "cron_enqueue_billing_reminders",
  // Putting a farm ON a subscription (20260906120000). Nothing did this before, so a
  // farm could never start paying: `beginCheckout` refuses without one.
  startSubscription: "billing_start_subscription",
  // Telling the customer (20260907120000). Claiming is what makes a send exactly-once
  // across the webhook/verify race; `release` hands the claim back when a send failed,
  // so a receipt nobody received does not stay marked as sent.
  receiptsDue: "billing_receipts_due",
  claimReceipt: "billing_claim_receipt",
  releaseReceipt: "billing_release_receipt",
  failureNoticesDue: "billing_failure_notices_due",
  claimFailureNotice: "billing_claim_failure_notice",
} as const;

/** `billing_attempt_kind`. */
export type AttemptKind = "initial_checkout" | "charge_authorization" | "manual_retry";

/** `billing_attempt_status`. */
export type AttemptStatus = "pending" | "succeeded" | "failed" | "abandoned" | "unknown";

/** One row of `app.due_billing_charges`. */
export type DueCharge = {
  invoice_id: string;
  farm_id: string;
  subscription_id: string | null;
  payment_method_id: string | null;
  amount_incl_cents: number;
  invoice_ref: string;
  attempt_number: number;
};

/** The columns of `billing_payment_attempts` this layer works with. */
export type AttemptRow = {
  id: string;
  farm_id: string;
  invoice_id: string | null;
  subscription_id: string | null;
  payment_method_id: string | null;
  attempt_ref: string;
  kind: AttemptKind;
  status: AttemptStatus;
  amount_incl_cents: number;
  currency: string;
  provider: string;
  provider_transaction_id: number | null;
  requested_at: string;
  reconciled_at: string | null;
  reconcile_note: string | null;
};

export const ATTEMPT_COLUMNS =
  "id, farm_id, invoice_id, subscription_id, payment_method_id, attempt_ref, kind, " +
  "status, amount_incl_cents, currency, provider, provider_transaction_id, " +
  "requested_at, reconciled_at, reconcile_note";

/** A settle call, named rather than positional so an argument cannot slide. */
export type SettleInput = {
  attemptId: string;
  status: AttemptStatus;
  transactionId?: number | null;
  providerRef?: string | null;
  gatewayResponse?: string | null;
  failureReason?: string | null;
  paidCents?: number | null;
  channel?: string | null;
};

/** Anything this layer can return instead of throwing. */
export type ServiceError = { message: string; code?: string };

/**
 * Paystack's floor for a ZAR transaction: R1.00.
 *
 * The engine already raises nothing for a farm with no billable vehicles, so this only
 * bites a farm with a real bill under a rand — a one-vehicle farm on a promotional price,
 * say. Checked here so the refusal is OUR sentence with a reason attached, rather than a
 * provider rejection arriving as a settled `failed` attempt that starts the dunning
 * machinery over ninety cents.
 */
export const PAYSTACK_MIN_CHARGE_CENTS = 100;

// ── Redaction ────────────────────────────────────────────────────────────────

/**
 * A message safe to store or report.
 *
 * Provider and Postgres messages are useful evidence and are occasionally handed the
 * thing we most need never to keep: a Paystack authorization code (`AUTH_xxxx`), an
 * email address, or a bearer token. Anything matching one of those shapes is replaced
 * before the string reaches `processing_error`, `reconcile_note` or an error report.
 */
export function redactMessage(raw: unknown, max = 500): string {
  const text =
    raw instanceof Error ? raw.message : typeof raw === "string" ? raw : String(raw ?? "");
  return text
    .replace(/AUTH_[A-Za-z0-9]+/g, "[authorization]")
    .replace(/sk_(?:live|test)_[A-Za-z0-9]+/gi, "[secret]")
    .replace(/[Bb]earer\s+[A-Za-z0-9._~+/-]+=*/g, "[token]")
    .replace(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/g, "[email]")
    .slice(0, max);
}

// ── References ───────────────────────────────────────────────────────────────

/**
 * OUR reference for a charge attempt, minted before the provider is contacted.
 *
 * Restricted to `[A-Za-z0-9-]` because Paystack echoes the reference back in a URL path
 * (`/transaction/verify/:reference`) and a character needing escaping there is a
 * reconciliation bug waiting to happen. `randomUUID` supplies the entropy: the reference
 * is the only handle on a charge whose HTTP response was lost, so a collision would mean
 * verifying somebody else's transaction.
 */
export function newAttemptReference(prefix = "FWB"): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
}

// ── The provider ─────────────────────────────────────────────────────────────

/**
 * The configured SaaS billing provider, or null when none is wired.
 *
 * Resolved through a DYNAMIC import so that importing this module (and therefore the
 * worker, and therefore its unit tests) never evaluates the adapter module. That matters
 * for two reasons: a real adapter may pull in `server-only`, which throws outside Next;
 * and a test must not be able to reach a module that holds a live secret key.
 *
 * The narrowing is structural rather than an `instanceof`. `getBillingAdapter()` is
 * typed to the older four-method `BillingAdapter`; `PaystackBillingAdapter` implements
 * both interfaces, so the presence of `initializeCheckout` is what distinguishes a
 * provider that can move money from the no-op that cannot.
 */
export async function getSaasProvider(): Promise<SaasBillingProvider | null> {
  const mod: { getBillingAdapter: () => unknown } = await import("./index");
  const adapter = mod.getBillingAdapter() as Partial<SaasBillingProvider> | null;
  if (!adapter) return null;
  if (
    typeof adapter.initializeCheckout !== "function" ||
    typeof adapter.verifyTransaction !== "function" ||
    typeof adapter.chargeAuthorization !== "function" ||
    typeof adapter.verifyWebhookSignature !== "function"
  ) {
    return null;
  }
  return adapter as SaasBillingProvider;
}

/** What the admin screen may see about the kill switch. Never a key, never a secret. */
export type ProviderState = {
  provider: string;
  enabled: boolean;
  chargingEnabled: boolean;
};

export async function providerState(): Promise<ProviderState> {
  const provider = await getSaasProvider();
  if (!provider) return { provider: "noop", enabled: false, chargingEnabled: false };
  return {
    provider: provider.provider,
    enabled: Boolean(provider.enabled),
    chargingEnabled: Boolean(provider.chargingEnabled),
  };
}

// ── Engine calls ─────────────────────────────────────────────────────────────

/** Invoices a worker may attempt right now. Empty is the normal, healthy answer. */
export async function dueBillingCharges(
  supabase: SupabaseClient,
  limit = 50,
): Promise<{ rows: DueCharge[]; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc(BILLING_RPC.dueCharges, { p_limit: limit });
  if (error) return { rows: [], error: { message: redactMessage(error.message), code: error.code } };
  return { rows: (data ?? []) as DueCharge[], error: null };
}

/**
 * Take the charge. Returns the attempt id, or null when somebody else already has it.
 *
 * A null is NOT an error and must never be reported as one: at most one attempt may be
 * in flight per invoice (`billing_payment_attempts_inflight_uq`), so a second worker
 * losing the insert is the constraint doing precisely its job. It also returns null when
 * the invoice already carries an `unknown` attempt — a standing instruction to reconcile
 * before anything else is tried.
 */
export async function claimBillingCharge(
  supabase: SupabaseClient,
  input: { invoiceId: string; reference: string; kind: AttemptKind; amountCents: number },
): Promise<{ attemptId: string | null; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc(BILLING_RPC.claimCharge, {
    p_invoice: input.invoiceId,
    p_ref: input.reference,
    p_kind: input.kind,
    p_amount: input.amountCents,
  });
  if (error) {
    return { attemptId: null, error: { message: redactMessage(error.message), code: error.code } };
  }
  const id = typeof data === "string" && data.length > 0 ? data : null;
  return { attemptId: id, error: null };
}

/** Record what the provider said. The only path to a `billing_payments` row. */
export async function settleBillingAttempt(
  supabase: SupabaseClient,
  input: SettleInput,
): Promise<{ error: ServiceError | null }> {
  const { error } = await supabase.rpc(BILLING_RPC.settleAttempt, {
    p_attempt: input.attemptId,
    p_status: input.status,
    p_transaction_id: input.transactionId ?? null,
    p_provider_ref: input.providerRef ?? null,
    p_gateway_response: input.gatewayResponse ? redactMessage(input.gatewayResponse, 300) : null,
    p_failure_reason: input.failureReason ? redactMessage(input.failureReason, 300) : null,
    p_paid_cents: input.paidCents ?? null,
    p_channel: input.channel ?? null,
  });
  if (error) return { error: { message: redactMessage(error.message), code: error.code } };
  return { error: null };
}

/**
 * Raise any invoice now due for one subscription.
 *
 * Idempotent twice over in SQL (`billing_invoices_farm_period_uq` for the race,
 * `next_billing_on` for the repeat), so pressing "pay now" twice cannot produce a second
 * bill. With no active price version this raises nothing and returns 0 — which is the
 * state the product ships in.
 */
export async function generateInvoicesFor(
  supabase: SupabaseClient,
  subscriptionId: string | null,
): Promise<{ made: number; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc(BILLING_RPC.generateInvoices, {
    p_only: subscriptionId,
  });
  if (error) return { made: 0, error: { message: redactMessage(error.message), code: error.code } };
  return { made: typeof data === "number" ? data : 0, error: null };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getAttemptByReference(
  supabase: SupabaseClient,
  reference: string,
): Promise<AttemptRow | null> {
  const { data } = await supabase
    .from("billing_payment_attempts")
    .select(ATTEMPT_COLUMNS)
    .eq("attempt_ref", reference)
    .maybeSingle();
  return (data as AttemptRow | null) ?? null;
}

export async function getAttemptById(
  supabase: SupabaseClient,
  id: string,
): Promise<AttemptRow | null> {
  const { data } = await supabase
    .from("billing_payment_attempts")
    .select(ATTEMPT_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  return (data as AttemptRow | null) ?? null;
}

/**
 * Attempts that need reconciling: every `unknown`, plus a `pending` old enough that the
 * request it belongs to cannot still be running.
 *
 * `unknown` first, and oldest first, because an unknown blocks its invoice entirely.
 */
export async function unresolvedAttempts(
  supabase: SupabaseClient,
  opts: { stalePendingMinutes?: number; limit?: number; now?: Date } = {},
): Promise<{ rows: AttemptRow[]; error: ServiceError | null }> {
  const stale = opts.stalePendingMinutes ?? 20;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - stale * 60_000).toISOString();

  const { data, error } = await supabase
    .from("billing_payment_attempts")
    .select(ATTEMPT_COLUMNS)
    .in("status", ["unknown", "pending"])
    .lte("requested_at", cutoff)
    .order("requested_at", { ascending: true })
    .limit(opts.limit ?? 100);

  if (error) return { rows: [], error: { message: redactMessage(error.message), code: error.code } };

  // An `unknown` is reconciled before a merely stale `pending`: it is the one blocking a
  // farm's invoice, and a pending that has simply run long may still resolve itself.
  // `as unknown as` and not a bare cast: supabase-js parses the literal select string to
  // infer a row type, and for a multi-row `.in()` query it widens to `GenericStringError[]`
  // rather than to our shape, so TypeScript refuses the direct conversion (TS2352). The
  // column list and `AttemptRow` are kept in step by hand — see `ATTEMPT_COLUMNS`.
  const rows = ((data ?? []) as unknown as AttemptRow[]).slice().sort((a, b) => {
    if (a.status !== b.status) return a.status === "unknown" ? -1 : 1;
    return a.requested_at < b.requested_at ? -1 : 1;
  });
  return { rows, error: null };
}

/**
 * The charging credential for a stored card.
 *
 * The ONLY read of these two columns anywhere in the app. What it returns goes straight
 * into an adapter call and nowhere else — not into a log line, an error, a Sentry extra
 * or a response body.
 */
export async function paymentMethodCredential(
  supabase: SupabaseClient,
  paymentMethodId: string,
  farmId: string,
): Promise<{ authorizationCode: string; email: string } | null> {
  const { data } = await supabase
    .from("billing_payment_methods")
    .select("authorization_code, authorization_email, reusable, status, deleted_at")
    .eq("id", paymentMethodId)
    .eq("farm_id", farmId)
    .maybeSingle();
  const row = data as
    | {
        authorization_code: string | null;
        authorization_email: string | null;
        reusable: boolean;
        status: string;
        deleted_at: string | null;
      }
    | null;
  if (!row || row.deleted_at || row.status !== "active" || !row.reusable) return null;
  if (!row.authorization_code || !row.authorization_email) return null;
  return { authorizationCode: row.authorization_code, email: row.authorization_email };
}

/** A farm's live subscription, or null. */
export type SubscriptionRow = {
  id: string;
  farm_id: string;
  plan: string;
  billing_period: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  default_payment_method_id: string | null;
  plan_before_downgrade: string | null;
};

export const SUBSCRIPTION_COLUMNS =
  "id, farm_id, plan, billing_period, status, cancel_at_period_end, current_period_end, " +
  "default_payment_method_id, plan_before_downgrade";

export async function farmSubscription(
  supabase: SupabaseClient,
  farmId: string,
): Promise<SubscriptionRow | null> {
  const { data } = await supabase
    .from("billing_subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as SubscriptionRow | null) ?? null;
}

export type InvoiceRow = {
  id: string;
  farm_id: string;
  subscription_id: string | null;
  invoice_ref: string;
  status: string;
  total_incl_cents: number;
  amount_paid_cents: number;
  currency: string;
};

export const INVOICE_COLUMNS =
  "id, farm_id, subscription_id, invoice_ref, status, total_incl_cents, amount_paid_cents, currency";

/** The oldest open, unpaid invoice for a farm. */
export async function openInvoiceForFarm(
  supabase: SupabaseClient,
  farmId: string,
): Promise<InvoiceRow | null> {
  const { data } = await supabase
    .from("billing_invoices")
    .select(INVOICE_COLUMNS)
    .eq("farm_id", farmId)
    .eq("status", "open")
    .is("deleted_at", null)
    .order("due_on", { ascending: true, nullsFirst: false })
    .limit(5);
  const rows = (data ?? []) as InvoiceRow[];
  return rows.find((r) => r.total_incl_cents > r.amount_paid_cents) ?? null;
}

export async function getInvoiceById(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<InvoiceRow | null> {
  const { data } = await supabase
    .from("billing_invoices")
    .select(INVOICE_COLUMNS)
    .eq("id", invoiceId)
    .maybeSingle();
  return (data as InvoiceRow | null) ?? null;
}

// ── Writes that have no engine function ──────────────────────────────────────

/** Where the hosted checkout sent the customer. Evidence, not a credential — but a
 *  single-use payment URL all the same, so it is stored and never printed. */
export async function recordCheckoutSession(
  supabase: SupabaseClient,
  attemptId: string,
  session: { authorizationUrl: string; accessCode: string },
): Promise<void> {
  await supabase
    .from("billing_payment_attempts")
    .update({
      authorization_url: session.authorizationUrl,
      access_code: session.accessCode,
      updated_at: new Date().toISOString(),
    })
    .eq("id", attemptId);
}

/**
 * Append a reconciliation note.
 *
 * `reconcile_note` is evidence, so it is appended to rather than overwritten: the second
 * pass's finding does not erase the first's. Truncated at a size the column will always
 * take, oldest trimmed first, so a farm stuck in a nightly reconcile loop cannot grow one
 * row without limit.
 */
export async function noteReconciliation(
  supabase: SupabaseClient,
  attemptId: string,
  note: string,
  existing: string | null,
): Promise<void> {
  const stamped = `${new Date().toISOString()} ${redactMessage(note, 240)}`;
  const combined = existing ? `${existing}\n${stamped}` : stamped;
  await supabase
    .from("billing_payment_attempts")
    .update({
      reconciled_at: new Date().toISOString(),
      reconcile_note: combined.slice(-2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", attemptId);
}

/**
 * Store (or refresh) the card an authorization represents, and make it the farm's
 * default.
 *
 * Refuses a non-reusable authorization outright. Paystack marks an authorization
 * reusable only when it may be charged again; storing a one-off as if it were a
 * subscription card produces a farm that looks set up and then fails every renewal — and
 * `billing_payment_methods_reusable_ck` would reject the row anyway. Doing it here as
 * well means the refusal has a reason attached rather than arriving as a constraint
 * violation.
 *
 * Idempotent on `(farm_id, provider, signature)`: the same card captured twice — a
 * webhook and a callback racing, say — updates the one row.
 */
export async function storeAuthorization(
  supabase: SupabaseClient,
  farmId: string,
  txn: VerifiedTransaction,
  opts: { subscriptionId?: string | null; createdBy?: string | null } = {},
): Promise<{ paymentMethodId: string | null; reason?: string }> {
  const auth = txn.authorization;
  if (!auth || !auth.authorizationCode) return { paymentMethodId: null, reason: "no_authorization" };
  if (!auth.reusable) return { paymentMethodId: null, reason: "authorization_not_reusable" };
  const email = txn.customerEmail;
  if (!email) return { paymentMethodId: null, reason: "no_authorization_email" };

  const nowIso = new Date().toISOString();
  const payload = {
    farm_id: farmId,
    provider: "paystack",
    authorization_code: auth.authorizationCode,
    authorization_email: email,
    card_brand: auth.brand,
    last4: auth.last4,
    exp_month: auth.expMonth,
    exp_year: auth.expYear,
    card_type: auth.cardType,
    bank: auth.bank,
    country_code: auth.countryCode,
    bin: auth.bin,
    signature: auth.signature,
    reusable: true,
    paystack_customer_code: txn.customerCode,
    is_default: true,
    status: "active",
    updated_at: nowIso,
    ...(opts.createdBy ? { created_by: opts.createdBy } : {}),
  };

  // An existing card for this farm with the same Paystack fingerprint is the same card.
  let existingId: string | null = null;
  if (auth.signature) {
    const { data } = await supabase
      .from("billing_payment_methods")
      .select("id")
      .eq("farm_id", farmId)
      .eq("provider", "paystack")
      .eq("signature", auth.signature)
      .is("deleted_at", null)
      .maybeSingle();
    existingId = (data as { id: string } | null)?.id ?? null;
  }

  // Only one card per farm may be the default, and it is a partial unique index — so the
  // incumbent stands down before the newcomer claims it.
  await supabase
    .from("billing_payment_methods")
    .update({ is_default: false, updated_at: nowIso })
    .eq("farm_id", farmId)
    .eq("is_default", true)
    .is("deleted_at", null);

  let id = existingId;
  if (existingId) {
    const { error } = await supabase
      .from("billing_payment_methods")
      .update(payload)
      .eq("id", existingId);
    if (error) return { paymentMethodId: null, reason: redactMessage(error.message) };
  } else {
    const { data, error } = await supabase
      .from("billing_payment_methods")
      .insert(payload)
      .select("id")
      .maybeSingle();
    if (error) return { paymentMethodId: null, reason: redactMessage(error.message) };
    id = (data as { id: string } | null)?.id ?? null;
  }

  if (id && opts.subscriptionId) {
    await supabase
      .from("billing_subscriptions")
      .update({ default_payment_method_id: id, updated_at: nowIso })
      .eq("id", opts.subscriptionId)
      .eq("farm_id", farmId);
  }
  return { paymentMethodId: id };
}

// ── Checkout ─────────────────────────────────────────────────────────────────

/** Where the browser should go next, or why it cannot. */
export type CheckoutStart =
  | { ok: true; url: string; reference: string; invoiceId: string }
  | { ok: false; code: string };

/** `NEXT_PUBLIC_SITE_URL`, normalised, or null. Never the Host header. */
export function siteOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Only ever hand the browser somewhere the provider is entitled to send it.
 *
 * `authorization_url` arrives over the network. Redirecting to it unchecked would make a
 * compromised or mistyped adapter response into an open redirect the customer is
 * following with a payment in mind — the most credible phishing context there is.
 */
export function isPaystackCheckoutUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host === "paystack.com" || host.endsWith(".paystack.com") || host === "paystack.co" || host.endsWith(".paystack.co");
  } catch {
    return false;
  }
}

/**
 * Begin a hosted checkout for a farm's open invoice.
 *
 * The order is the whole safety property, and it is the same order the contract sets out:
 * find the invoice, mint and PERSIST the reference (which is what `claim` does), and only
 * then contact Paystack. A response lost after that point is recoverable because the
 * reference already exists in our database.
 *
 * Shared by the route and the owner's server action so there is one sequence, not two
 * that can drift.
 */
export async function beginCheckout(
  supabase: SupabaseClient,
  input: { farmId: string; email: string | null; userId?: string | null },
): Promise<CheckoutStart> {
  const provider = await getSaasProvider();
  if (!provider || !provider.enabled) return { ok: false, code: "billing-unavailable" };

  const origin = siteOrigin();
  if (!origin) return { ok: false, code: "billing-site-url-missing" };

  const email = (input.email ?? "").trim();
  // Paystack will only ever charge this authorization when presented with the SAME
  // address it was created against, so an absent one is a card that could be captured
  // and then never used.
  if (!email) return { ok: false, code: "billing-no-email" };

  const subscription = await farmSubscription(supabase, input.farmId);
  if (!subscription) return { ok: false, code: "billing-no-subscription" };

  let invoice = await openInvoiceForFarm(supabase, input.farmId);
  if (!invoice) {
    // Nothing open: it may simply be time to raise this period's. With no active price
    // version this makes nothing, which is the shipped state.
    await generateInvoicesFor(supabase, subscription.id);
    invoice = await openInvoiceForFarm(supabase, input.farmId);
  }
  if (!invoice) return { ok: false, code: "billing-nothing-due" };

  const amount = invoice.total_incl_cents - invoice.amount_paid_cents;
  if (amount <= 0) return { ok: false, code: "billing-nothing-due" };
  // Paystack refuses a ZAR transaction under R1.00. Refused here, with a reason, rather
  // than at the provider — where it would arrive as a decline and be indistinguishable
  // from a card problem.
  if (amount < PAYSTACK_MIN_CHARGE_CENTS) return { ok: false, code: "billing-below-minimum" };

  const reference = newAttemptReference();
  const { attemptId, error: claimError } = await claimBillingCharge(supabase, {
    invoiceId: invoice.id,
    reference,
    kind: "initial_checkout",
    amountCents: amount,
  });
  if (claimError) return { ok: false, code: "billing-claim-failed" };
  // Null means another attempt is already in flight on this invoice — possibly an
  // `unknown` one, which must be reconciled before anything else is tried.
  if (!attemptId) return { ok: false, code: "billing-in-flight" };

  const init: CheckoutInit = {
    farmId: input.farmId,
    invoiceId: invoice.id,
    reference,
    amountCents: amount,
    email,
    callbackUrl: `${origin}/api/billing/callback?reference=${encodeURIComponent(reference)}`,
    metadata: {
      farm_id: input.farmId,
      invoice_id: invoice.id,
      invoice_ref: invoice.invoice_ref,
      subscription_id: subscription.id,
    },
  };

  const session = await provider.initializeCheckout(init);
  if (!session.ok) {
    // `transaction/initialize` moves no money — it creates a page. A failure here cannot
    // have charged anybody, so the attempt is ABANDONED rather than left `unknown`: an
    // unknown would block every later attempt on this invoice for a request that never
    // could have taken a rand.
    await settleBillingAttempt(supabase, {
      attemptId,
      status: "abandoned",
      failureReason: session.reason,
    });
    return { ok: false, code: session.deferred ? "billing-unavailable" : "billing-checkout-failed" };
  }

  if (!isPaystackCheckoutUrl(session.authorizationUrl)) {
    await settleBillingAttempt(supabase, {
      attemptId,
      status: "abandoned",
      failureReason: "checkout url rejected",
    });
    return { ok: false, code: "billing-checkout-failed" };
  }

  await recordCheckoutSession(supabase, attemptId, {
    authorizationUrl: session.authorizationUrl,
    accessCode: session.accessCode,
  });

  return { ok: true, url: session.authorizationUrl, reference, invoiceId: invoice.id };
}

/** Build a `ChargeRequest` for a stored card. Kept here so the shape is written once. */
export function chargeRequestFor(
  row: { farm_id: string; invoice_id: string; invoice_ref: string; subscription_id: string | null },
  reference: string,
  amountCents: number,
  credential: { authorizationCode: string; email: string },
): ChargeRequest {
  return {
    farmId: row.farm_id,
    invoiceId: row.invoice_id,
    reference,
    amountCents,
    authorizationCode: credential.authorizationCode,
    email: credential.email,
    metadata: {
      farm_id: row.farm_id,
      invoice_id: row.invoice_id,
      invoice_ref: row.invoice_ref,
      ...(row.subscription_id ? { subscription_id: row.subscription_id } : {}),
    },
  };
}

// ── Company settings ─────────────────────────────────────────────────────────

/**
 * The singleton `billing_settings` row.
 *
 * Read by `singleton`, never by `id`. The primary key is a uuid — the shared `app_audit()`
 * trigger casts `id` to uuid, so a boolean primary key broke it — and the one-row property
 * is held by the `singleton` column and its unique index instead. A reader that looked the
 * row up by a hard-coded id would find nothing.
 */
export type BillingSettings = {
  vat_registered: boolean;
  vat_rate_bps: number;
  legal_name: string;
  billing_email: string | null;
  support_email: string | null;
  trial_days: number;
  grace_days: number;
  retry_offsets_days: number[] | null;
  downgrade_to_plan: string;
  cancel_at_period_end: boolean;
  payment_terms_days: number;
};

export const BILLING_SETTINGS_COLUMNS =
  "vat_registered, vat_rate_bps, legal_name, billing_email, support_email, trial_days, " +
  "grace_days, retry_offsets_days, downgrade_to_plan, cancel_at_period_end, payment_terms_days";

export async function billingSettings(
  supabase: SupabaseClient,
): Promise<BillingSettings | null> {
  const { data } = await supabase
    .from("billing_settings")
    .select(BILLING_SETTINGS_COLUMNS)
    .eq("singleton", true)
    .maybeSingle();
  return (data as BillingSettings | null) ?? null;
}

// ── Webhook events ───────────────────────────────────────────────────────────
//
// `billing_webhook_events` is granted to `service_role` and to nothing else — not even
// SELECT for `authenticated` — because a payload carries the customer's email and the
// full authorization object. Every function below therefore requires the service client.

export type WebhookRecord = {
  /** Row id, or null when the insert itself failed. */
  id: string | null;
  /** True when this exact `(provider, dedupe_key)` had already been delivered. */
  duplicate: boolean;
  error: ServiceError | null;
};

/**
 * Persist a delivery, idempotently, BEFORE anything is acted on.
 *
 * The uniqueness is the database's (`billing_webhook_events_dedupe_uq`), not a
 * read-then-write here: the route is precisely the thing being delivered to more than
 * once, sometimes concurrently, so "have we seen this before?" would lose the very race
 * it exists to win. The insert is attempted first and a duplicate-key error IS the
 * answer — at which point the only thing that happens is `delivery_count` going up, which
 * makes a redelivery storm visible instead of silent.
 */
export async function recordWebhookEvent(
  supabase: SupabaseClient,
  input: {
    provider: string;
    dedupeKey: string;
    eventType: string;
    signatureVerified: boolean;
    payload: unknown;
  },
): Promise<WebhookRecord> {
  const { data, error } = await supabase
    .from("billing_webhook_events")
    .insert({
      provider: input.provider,
      dedupe_key: input.dedupeKey,
      event_type: input.eventType,
      signature_verified: input.signatureVerified,
      payload: input.payload ?? null,
    })
    .select("id")
    .maybeSingle();

  if (!error) {
    return { id: (data as { id: string } | null)?.id ?? null, duplicate: false, error: null };
  }

  // 23505 = unique_violation: this exact delivery is already on file. Anything else is a
  // genuine failure to record, and a caller must not perform a side effect it cannot
  // prove it wrote down first.
  if (error.code !== "23505") {
    return {
      id: null,
      duplicate: false,
      error: { message: redactMessage(error.message), code: error.code },
    };
  }

  const { data: existing } = await supabase
    .from("billing_webhook_events")
    .select("id, delivery_count")
    .eq("provider", input.provider)
    .eq("dedupe_key", input.dedupeKey)
    .maybeSingle();
  const row = existing as { id: string; delivery_count: number } | null;
  if (row) {
    await supabase
      .from("billing_webhook_events")
      .update({ delivery_count: (row.delivery_count ?? 1) + 1 })
      .eq("id", row.id);
  }
  return { id: row?.id ?? null, duplicate: true, error: null };
}

/**
 * Close a delivery out.
 *
 * `processing_error` is redacted on the way in. It is read by a human working out why a
 * payment did not land, and the two things a provider message is most likely to quote
 * back at us are a customer's email address and an authorization code.
 */
export async function finishWebhookEvent(
  supabase: SupabaseClient,
  eventId: string | null,
  input: {
    error?: string | null;
    farmId?: string | null;
    invoiceId?: string | null;
    attemptId?: string | null;
  } = {},
): Promise<void> {
  if (!eventId) return;
  await supabase
    .from("billing_webhook_events")
    .update({
      processed_at: new Date().toISOString(),
      processing_error: input.error ? redactMessage(input.error, 400) : null,
      ...(input.farmId ? { farm_id: input.farmId } : {}),
      ...(input.invoiceId ? { invoice_id: input.invoiceId } : {}),
      ...(input.attemptId ? { attempt_id: input.attemptId } : {}),
    })
    .eq("id", eventId);
}

// ── Subscription writes the owner and Rapid Rise screens need ────────────────

/**
 * Ask for a cancellation.
 *
 * Period-end is the default and the only one an owner normally reaches: they have paid
 * for the period, so `non_renewing` keeps them fully entitled until `current_period_end`
 * and `app.billing_close_cancellations()` closes it on the night it expires. Immediate
 * cancellation ends it now. Nothing is deleted either way — that is the promise the whole
 * downgrade path is built on.
 */
export async function setCancellation(
  supabase: SupabaseClient,
  input: {
    subscriptionId: string;
    farmId: string;
    immediate: boolean;
    reason?: string | null;
  },
): Promise<{ error: ServiceError | null }> {
  const nowIso = new Date().toISOString();
  const patch = input.immediate
    ? {
        status: "cancelled",
        cancel_at_period_end: false,
        cancellation_reason: input.reason ?? null,
        cancelled_at: nowIso,
        ended_on: nowIso.slice(0, 10),
        updated_at: nowIso,
      }
    : {
        status: "non_renewing",
        cancel_at_period_end: true,
        cancellation_reason: input.reason ?? null,
        cancelled_at: nowIso,
        updated_at: nowIso,
      };

  const { error } = await supabase
    .from("billing_subscriptions")
    .update(patch)
    .eq("id", input.subscriptionId)
    .eq("farm_id", input.farmId);
  if (error) return { error: { message: redactMessage(error.message), code: error.code } };
  return { error: null };
}

/** Undo a period-end cancellation that has not yet closed. */
export async function resumeSubscription(
  supabase: SupabaseClient,
  input: { subscriptionId: string; farmId: string },
): Promise<{ error: ServiceError | null }> {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({
      status: "active",
      cancel_at_period_end: false,
      cancellation_reason: null,
      cancelled_at: null,
      updated_at: nowIso,
    })
    .eq("id", input.subscriptionId)
    .eq("farm_id", input.farmId)
    .eq("status", "non_renewing")
    .is("ended_on", null);
  if (error) return { error: { message: redactMessage(error.message), code: error.code } };
  return { error: null };
}

/**
 * Change what a farm has BOUGHT. Rapid Rise only.
 *
 * This writes `billing_subscriptions.plan` — the COMMERCIAL plan — and deliberately not
 * `farms.plan`, which is the EFFECTIVE plan every entitlement gate resolves from. The two
 * are reconciled by the engine (a downgrade for non-payment writes `farms.plan` and
 * remembers what it held; payment restores it), and an admin screen writing both would be
 * the one place able to silently un-downgrade a farm that has not paid.
 */
export async function adminSetSubscriptionPlan(
  supabase: SupabaseClient,
  input: { subscriptionId: string; plan: string; billingPeriod: string },
): Promise<{ error: ServiceError | null }> {
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({
      plan: input.plan,
      billing_period: input.billingPeriod,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.subscriptionId);
  if (error) return { error: { message: redactMessage(error.message), code: error.code } };
  return { error: null };
}

/**
 * Stand a stored card down.
 *
 * The credential columns are never touched from a browser-initiated path; this changes
 * only the usability state, so `app.due_billing_charges` (which requires an `active`,
 * reusable method) stops choosing it. The row and its evidence stay.
 */
export async function deactivatePaymentMethod(
  supabase: SupabaseClient,
  input: { paymentMethodId: string; farmId: string },
): Promise<{ error: ServiceError | null }> {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("billing_payment_methods")
    .update({ status: "inactive", is_default: false, removed_at: nowIso, updated_at: nowIso })
    .eq("id", input.paymentMethodId)
    .eq("farm_id", input.farmId);
  if (error) return { error: { message: redactMessage(error.message), code: error.code } };
  return { error: null };
}

/**
 * The farm's default (or any active) stored card, display columns only.
 *
 * Never selects `*`: `authorization_code` and `authorization_email` are withheld from
 * `authenticated` at the COLUMN level, so a `select=*` from a browser session errors —
 * and this runs as the service role, where it would succeed and quietly carry a charging
 * credential into whatever the caller does next.
 */
export async function activePaymentMethod(
  supabase: SupabaseClient,
  farmId: string,
): Promise<{ id: string; card_brand: string | null; last4: string | null } | null> {
  const { data } = await supabase
    .from("billing_payment_methods")
    .select("id, card_brand, last4, is_default")
    .eq("farm_id", farmId)
    .eq("status", "active")
    .is("deleted_at", null)
    .order("is_default", { ascending: false })
    .limit(1);
  const rows = (data ?? []) as unknown as {
    id: string;
    card_brand: string | null;
    last4: string | null;
  }[];
  return rows[0] ?? null;
}

/**
 * The address a NEW hosted checkout is raised against for a farm.
 *
 * ── Read this before using it anywhere else ──────────────────────────────────
 * This is for `initializeCheckout` ONLY — the first payment, where no authorization
 * exists yet. It must NEVER be used to charge a stored card. Paystack's rule is explicit:
 * "only the email used to create an authorization can be used to charge it", so a
 * recurring charge takes `billing_payment_methods.authorization_email` (part of the
 * credential, stored beside the code for exactly this reason) and nothing else. Looking
 * the address up again at charge time is how a farm ends up with a card that was captured
 * successfully and can then never be used, because somebody changed their email in
 * between.
 *
 * The farm's OWNER is the billing contact, not whoever happens to be pressing the button.
 * That matters when Rapid Rise starts a checkout on a customer's behalf from support: the
 * transaction must belong to the farmer, not to a staff member.
 *
 * `fallback` is the caller's own address, used only when the farm has no active owner on
 * file — which is a broken farm, but not a reason to refuse a payment.
 */
export async function billingContactEmail(
  supabase: SupabaseClient,
  farmId: string,
  fallback?: string | null,
): Promise<string | null> {
  const { data } = await supabase
    .from("users")
    .select("email")
    .eq("farm_id", farmId)
    .eq("role", "owner")
    .eq("active", true)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1);
  const rows = (data ?? []) as unknown as { email: string | null }[];
  const owner = rows[0]?.email;
  const chosen = (owner ?? fallback ?? "").trim();
  return chosen === "" ? null : chosen;
}
