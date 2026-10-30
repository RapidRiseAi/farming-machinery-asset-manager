"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentFarmId, requireProfile, requireUsableFarm, type Profile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { errorCode, reportUnlessRefused } from "@/lib/action-errors";
import { runOnce } from "@/lib/request-claim";
import { parseRandsToCents } from "@/lib/money";
import { isIsoDate, isUuid } from "@/lib/ids";
import { captureError } from "@/lib/observability";
import { canViewFarmFinance } from "@/lib/asset-finance-read";
import {
  DEFAULT_CONTRACT_LEAD_DAYS,
  DEFAULT_INSTALMENT_LEAD_DAYS,
  financeReturnPath,
  isAgreementFrequency,
  isAgreementKind,
  isContractFrequency,
  isContractKind,
  percentToBps,
  wholeNumberIn,
  withResult,
} from "@/lib/asset-finance";

/**
 * Finance agreements, leases and contracts: every write.
 *
 * == The database is the door =================================================
 * The browser roles may only READ these tables (20261028110100). Each action here calls a
 * SECURITY DEFINER function that checks `app.can_view_farm_finance` (owners and managers of
 * the row's farm), validates, rebuilds the schedule and books the costs in one transaction.
 * So the checks in this file are courtesies that produce a sentence; the refusal that
 * matters is the database's, and `supabase/tests/asset_finance.sql` proves it by trying as
 * a mechanic, an operator, a contractor and another farm's owner.
 *
 * == Where the person lands ===================================================
 * The forms live on two screens, the Finance page and a machine's Costs tab, and post
 * `back` so the answer arrives where the question was asked (`financeReturnPath` accepts
 * only those two shapes).
 *
 * == Once per request =========================================================
 * Creating an agreement or a contract, recording a payment, settling and attaching a file
 * each run through `runOnce`: a payment recorded twice on farm signal is a balance that is
 * wrong by an instalment.
 */

function field(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

function back(fd: FormData): string {
  return financeReturnPath(field(fd, "back"));
}

/** Back where the form was, with a refusal code `errors.ts` turns into a sentence. */
function bounce(path: string, code: string): never {
  redirect(path.includes("?") ? `${path}&error=${code}` : `${path}?error=${code}`);
}

/** A failed database call: `errorCode()` has already encoded it, and reported it if ours. */
function bounceDb(path: string, encoded: string): never {
  bounce(path, encoded);
}

function done(path: string, saved: string): string {
  revalidatePath("/finance");
  revalidatePath("/calendar");
  const machine = path.match(/^\/machines\/([0-9a-f-]{36})/i);
  if (machine) revalidatePath(`/machines/${machine[1]}`);
  return withResult(path, "saved", saved);
}

/** A Rand amount, or null for blank; a value that is not money refuses with `code`. */
function money(fd: FormData, key: string, path: string, code: string): number | null {
  const raw = field(fd, key);
  if (raw === "") return null;
  const cents = parseRandsToCents(raw);
  if (cents == null || cents < 0) bounce(path, code);
  return cents;
}

function date(fd: FormData, key: string, path: string, code: string): string | null {
  const raw = field(fd, key);
  if (raw === "") return null;
  if (!isIsoDate(raw)) bounce(path, code);
  return raw;
}

function id(fd: FormData, key: string, path: string): string {
  const raw = field(fd, key);
  if (!isUuid(raw)) bounce(path, "finance-not-found");
  return raw;
}

/** The agreement's terms as the save function reads them (20261028110500). */
function agreementFields(fd: FormData, path: string): Record<string, unknown> {
  const kind = field(fd, "kind") || "instalment_sale";
  const frequency = field(fd, "frequency") || "monthly";
  if (!isAgreementKind(kind) || !isAgreementFrequency(frequency)) bounce(path, "finance-schedule-invalid");
  const rate = percentToBps(field(fd, "interest_rate"));
  if (rate === false) bounce(path, "finance-rate-invalid");
  const term = wholeNumberIn(field(fd, "term_months"), 1, 360);
  if (term === false || term == null) bounce(path, "finance-term-required");
  const lead = wholeNumberIn(field(fd, "reminder_lead_days"), 0, 90);
  if (lead === false) bounce(path, "finance-lead-invalid");
  const reminders = fd.get("reminders") !== null;
  return {
    kind,
    lender: field(fd, "lender"),
    agreement_number: field(fd, "agreement_number"),
    principal_cents: money(fd, "principal", path, "finance-amount-invalid"),
    deposit_cents: money(fd, "deposit", path, "finance-amount-invalid") ?? 0,
    interest_rate_bps: rate,
    term_months: term,
    frequency,
    instalment_cents: money(fd, "instalment", path, "finance-amount-invalid"),
    fee_cents: money(fd, "fee", path, "finance-amount-invalid") ?? 0,
    balloon_cents: money(fd, "balloon", path, "finance-amount-invalid") ?? 0,
    start_date: date(fd, "start_date", path, "finance-dates"),
    first_instalment_date: date(fd, "first_instalment_date", path, "finance-dates"),
    auto_mark_paid: fd.get("auto_mark_paid") !== null,
    // Unticked "remind me" stores no lead (no reminders); ticked with a blank lead is the default.
    reminder_lead_days: reminders ? (lead ?? DEFAULT_INSTALMENT_LEAD_DAYS) : null,
    notes: field(fd, "notes"),
  };
}

/**
 * requireProfile plus the stop gate on the farm in use: these actions find their farm
 * through the record they change, so without it a paused farm went on recording finance
 * from a tab opened before the pause.
 */
async function actingProfile(): Promise<Profile> {
  const profile = await requireProfile();
  await requireUsableFarm(await currentFarmId(profile), profile);
  return profile;
}

// == Finance agreements =======================================================

/** Capture a finance agreement on a machine; its schedule is built in the same call. */
export async function createFinanceAgreement(formData: FormData) {
  const path = back(formData);
  return runOnce(formData, "finance:create-agreement", async () => {
    const profile = await actingProfile();
    const supabase = await createClient();
    const machineId = id(formData, "machine_id", path);
    const { data: machine, error: machineError } = await supabase
      .from("machines")
      .select("farm_id")
      .eq("id", machineId)
      .is("deleted_at", null)
      .maybeSingle();
    if (machineError) bounceDb(path, errorCode(machineError, "finance:create-agreement:machine"));
    const farmId = (machine as { farm_id: string } | null)?.farm_id;
    if (!farmId) bounce(path, "finance-machine-invalid");
    if (!(await canViewFarmFinance(supabase, farmId))) bounce(path, "forbidden");
    await requireUsableFarm(farmId, profile);

    const fields = agreementFields(formData, path);
    // Part-way through the term: instalments due before this day are taken as paid.
    const paidBefore = formData.get("already_paid") !== null ? date(formData, "paid_before", path, "finance-dates") : null;
    const { error } = await supabase.rpc("finance_save_agreement", {
      p_agreement: null,
      p_machine: machineId,
      p_fields: fields,
      p_mark_paid_before: paidBefore,
    });
    if (error) bounceDb(path, errorCode(error, "finance:create-agreement"));
    return done(path, "finance-agreement");
  }, { whileRunning: withResult(path, "error", "still-saving") });
}

/** Edit an agreement's terms. The schedule's unpaid rows are rebuilt when a term changed. */
export async function updateFinanceAgreement(formData: FormData) {
  await actingProfile();
  const path = back(formData);
  const agreementId = id(formData, "agreement_id", path);
  const fields = agreementFields(formData, path);
  const supabase = await createClient();
  // The statement balance is its own small form; keep what is there.
  const { data: current, error: readError } = await supabase
    .from("finance_agreements")
    .select("statement_balance_cents, statement_balance_on")
    .eq("id", agreementId)
    .maybeSingle();
  if (readError) bounceDb(path, errorCode(readError, "finance:update-agreement:read"));
  if (!current) bounce(path, "finance-not-found");
  const { error } = await supabase.rpc("finance_save_agreement", {
    p_agreement: agreementId,
    p_machine: null,
    p_fields: { ...fields, ...(current as Record<string, unknown>) },
  });
  if (error) bounceDb(path, errorCode(error, "finance:update-agreement"));
  redirect(done(path, "finance-agreement"));
}

/** The lender's statement balance, which then wins over the schedule's estimate. */
export async function recordStatementBalance(formData: FormData) {
  await actingProfile();
  const path = back(formData);
  const agreementId = id(formData, "agreement_id", path);
  const balance = money(formData, "statement_balance", path, "finance-amount-invalid");
  const on = date(formData, "statement_on", path, "finance-dates");
  if ((balance == null) !== (on == null)) bounce(path, "finance-statement-incomplete");

  const supabase = await createClient();
  const { data, error: readError } = await supabase
    .from("finance_agreements")
    .select("kind, lender, agreement_number, principal_cents, deposit_cents, interest_rate_bps, term_months, frequency, instalment_cents, fee_cents, balloon_cents, start_date, first_instalment_date, auto_mark_paid, reminder_lead_days, notes")
    .eq("id", agreementId)
    .maybeSingle();
  if (readError) bounceDb(path, errorCode(readError, "finance:statement:read"));
  if (!data) bounce(path, "finance-not-found");
  // The same terms, so nothing is rebuilt: only the statement changes.
  const { error } = await supabase.rpc("finance_save_agreement", {
    p_agreement: agreementId,
    p_machine: null,
    p_fields: { ...(data as Record<string, unknown>), statement_balance_cents: balance, statement_balance_on: on },
  });
  if (error) bounceDb(path, errorCode(error, "finance:statement"));
  redirect(done(path, "finance-statement"));
}

/** Record what was paid on one instalment; blank pays what is left on it. */
export async function recordFinancePayment(formData: FormData) {
  const path = back(formData);
  return runOnce(formData, "finance:record-payment", async () => {
    await actingProfile();
    const instalmentId = id(formData, "instalment_id", path);
    const amount = money(formData, "amount", path, "finance-payment-amount");
    const paidOn = date(formData, "paid_on", path, "finance-dates");
    const supabase = await createClient();
    const { error } = await supabase.rpc("finance_record_payment", {
      p_instalment: instalmentId,
      p_amount_cents: amount,
      p_paid_on: paidOn,
      p_reference: field(formData, "reference") || null,
    });
    if (error) bounceDb(path, errorCode(error, "finance:record-payment"));
    return done(path, "finance-payment");
  }, { whileRunning: withResult(path, "error", "still-saving") });
}

/** Undo a payment recorded by mistake. */
export async function clearFinancePayment(formData: FormData) {
  await actingProfile();
  const path = back(formData);
  const instalmentId = id(formData, "instalment_id", path);
  const supabase = await createClient();
  const { error } = await supabase.rpc("finance_clear_payment", { p_instalment: instalmentId });
  if (error) bounceDb(path, errorCode(error, "finance:clear-payment"));
  redirect(done(path, "finance-payment-cleared"));
}

/** Correct one row of the schedule: the lender moved a date or charged another amount. */
export async function updateFinanceInstalment(formData: FormData) {
  await actingProfile();
  const path = back(formData);
  const instalmentId = id(formData, "instalment_id", path);
  const due = date(formData, "due_date", path, "finance-dates");
  const amount = money(formData, "amount", path, "finance-amount-invalid");
  if (!due || amount == null) bounce(path, "finance-schedule-invalid");
  const supabase = await createClient();
  const { error } = await supabase.rpc("finance_update_instalment", {
    p_instalment: instalmentId,
    p_due_date: due,
    p_amount_cents: amount,
  });
  if (error) bounceDb(path, errorCode(error, "finance:update-instalment"));
  redirect(done(path, "finance-schedule"));
}

/** Rebuild the unpaid rows on the agreement's current terms. */
export async function regenerateFinanceSchedule(formData: FormData) {
  await actingProfile();
  const path = back(formData);
  const agreementId = id(formData, "agreement_id", path);
  const supabase = await createClient();
  const { error } = await supabase.rpc("finance_regenerate_schedule", { p_agreement: agreementId });
  if (error) bounceDb(path, errorCode(error, "finance:regenerate"));
  redirect(done(path, "finance-schedule"));
}

/** Settle early: every open row closes, and any charge above the capital is a cost. */
export async function settleFinanceAgreement(formData: FormData) {
  const path = back(formData);
  return runOnce(formData, "finance:settle", async () => {
    await actingProfile();
    const agreementId = id(formData, "agreement_id", path);
    const on = date(formData, "settled_on", path, "finance-settle-date");
    const amount = money(formData, "settlement", path, "finance-payment-amount");
    if (!on) bounce(path, "finance-settle-date");
    if (amount == null) bounce(path, "finance-payment-amount");
    const supabase = await createClient();
    const { error } = await supabase.rpc("finance_settle_agreement", {
      p_agreement: agreementId,
      p_settled_on: on,
      p_settlement_cents: amount,
    });
    if (error) bounceDb(path, errorCode(error, "finance:settle"));
    return done(path, "finance-settled");
  }, { whileRunning: withResult(path, "error", "still-saving") });
}

/** Remove an agreement captured by mistake (soft; the costs it booked are withdrawn). */
export async function deleteFinanceAgreement(formData: FormData) {
  await actingProfile();
  const path = back(formData);
  const agreementId = id(formData, "agreement_id", path);
  const supabase = await createClient();
  const { error } = await supabase.rpc("finance_delete_agreement", { p_agreement: agreementId });
  if (error) bounceDb(path, errorCode(error, "finance:delete-agreement"));
  redirect(done(path, "finance-removed"));
}

// == Leases, rentals and service contracts ====================================

function contractFields(fd: FormData, path: string): Record<string, unknown> {
  const kind = field(fd, "kind") || "operating_lease";
  const frequency = field(fd, "frequency") || "monthly";
  if (!isContractKind(kind) || !isContractFrequency(frequency)) bounce(path, "finance-schedule-invalid");
  const machine = field(fd, "machine_id");
  if (machine !== "" && !isUuid(machine)) bounce(path, "finance-machine-invalid");
  const renewal = wholeNumberIn(field(fd, "renewal_months"), 1, 120);
  const notice = wholeNumberIn(field(fd, "notice_days"), 0, 365);
  const lead = wholeNumberIn(field(fd, "reminder_lead_days"), 0, 365);
  if (renewal === false || notice === false || lead === false) bounce(path, "finance-lead-invalid");
  const reminders = fd.get("reminders") !== null;
  return {
    kind,
    machine_id: machine || null,
    party: field(fd, "party"),
    reference: field(fd, "reference"),
    start_date: date(fd, "start_date", path, "contract-dates"),
    end_date: date(fd, "end_date", path, "contract-dates"),
    amount_cents: money(fd, "amount", path, "finance-amount-invalid") ?? 0,
    vat_charged: fd.get("vat_charged") !== null,
    frequency,
    first_payment_date: date(fd, "first_payment_date", path, "contract-dates"),
    auto_renews: fd.get("auto_renews") !== null,
    renewal_months: renewal,
    notice_days: notice,
    // Ticked: the payments are booked as costs when due. Unticked when a contractor's
    // invoices already bring them into the ledger, so nothing is counted twice.
    post_costs: fd.get("post_costs") !== null,
    reminder_lead_days: reminders ? (lead ?? DEFAULT_CONTRACT_LEAD_DAYS) : null,
    notes: field(fd, "notes"),
  };
}

/** Capture a lease, rental or service contract, on one machine or the whole farm. */
export async function createContract(formData: FormData) {
  const path = back(formData);
  return runOnce(formData, "finance:create-contract", async () => {
    await actingProfile();
    const farmId = id(formData, "farm_id", path);
    const supabase = await createClient();
    if (!(await canViewFarmFinance(supabase, farmId))) bounce(path, "forbidden");
    const { error } = await supabase.rpc("asset_contract_save", {
      p_contract: null,
      p_farm: farmId,
      p_fields: contractFields(formData, path),
    });
    if (error) bounceDb(path, errorCode(error, "finance:create-contract"));
    return done(path, "finance-contract");
  }, { whileRunning: withResult(path, "error", "still-saving") });
}

export async function updateContract(formData: FormData) {
  await actingProfile();
  const path = back(formData);
  const contractId = id(formData, "contract_id", path);
  const supabase = await createClient();
  const { error } = await supabase.rpc("asset_contract_save", {
    p_contract: contractId,
    p_farm: null,
    p_fields: contractFields(formData, path),
  });
  if (error) bounceDb(path, errorCode(error, "finance:update-contract"));
  redirect(done(path, "finance-contract"));
}

/** End a contract on a day: nothing falls due after it and it no longer renews. */
export async function endContract(formData: FormData) {
  await actingProfile();
  const path = back(formData);
  const contractId = id(formData, "contract_id", path);
  const on = date(formData, "end_date", path, "contract-dates");
  if (!on) bounce(path, "contract-dates");
  const supabase = await createClient();
  const { error } = await supabase.rpc("asset_contract_end", { p_contract: contractId, p_end_date: on });
  if (error) bounceDb(path, errorCode(error, "finance:end-contract"));
  redirect(done(path, "finance-contract-ended"));
}

/** Renew to a later end date, optionally at a new amount. */
export async function renewContract(formData: FormData) {
  await actingProfile();
  const path = back(formData);
  const contractId = id(formData, "contract_id", path);
  const on = date(formData, "end_date", path, "contract-renew-date");
  if (!on) bounce(path, "contract-renew-date");
  const amount = money(formData, "amount", path, "finance-amount-invalid");
  const supabase = await createClient();
  const { error } = await supabase.rpc("asset_contract_renew", {
    p_contract: contractId,
    p_end_date: on,
    p_amount_cents: amount,
  });
  if (error) bounceDb(path, errorCode(error, "finance:renew-contract"));
  redirect(done(path, "finance-contract-renewed"));
}

export async function deleteContract(formData: FormData) {
  await actingProfile();
  const path = back(formData);
  const contractId = id(formData, "contract_id", path);
  const supabase = await createClient();
  const { error } = await supabase.rpc("asset_contract_delete", { p_contract: contractId });
  if (error) bounceDb(path, errorCode(error, "finance:delete-contract"));
  redirect(done(path, "finance-removed"));
}

// == Documents =================================================================

// Below the 10 MB server-action body limit (next.config.mjs) with room for the form around
// it, so an oversized file gets OUR sentence rather than dying inside the framework.
const MAX_DOC_BYTES = 8 * 1024 * 1024;
const DOC_TYPES = /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i;

/**
 * Attach the signed agreement, the lease or the policy schedule. Through the CALLER's
 * client, not the service key: the `finance-docs` bucket and the attachment policies
 * (20261028110200) apply the same owner-and-manager rule, so a mechanic cannot upload here
 * even by posting the form by hand.
 */
export async function uploadFinanceDocument(formData: FormData) {
  const path = back(formData);
  return runOnce(formData, "finance:upload-document", async () => {
    const profile = await actingProfile();
    const parentType = field(formData, "parent_type");
    if (parentType !== "finance_agreement" && parentType !== "asset_contract") bounce(path, "finance-not-found");
    const parentId = id(formData, "parent_id", path);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) bounce(path, "finance-doc-missing");
    if (file.size > MAX_DOC_BYTES) bounce(path, "finance-doc-too-big");
    if (!DOC_TYPES.test(file.type)) bounce(path, "finance-doc-type");

    const supabase = await createClient();
    const table = parentType === "finance_agreement" ? "finance_agreements" : "asset_contracts";
    const { data: parent, error: parentError } = await supabase
      .from(table)
      .select("farm_id")
      .eq("id", parentId)
      .is("deleted_at", null)
      .maybeSingle();
    if (parentError) bounceDb(path, errorCode(parentError, "finance:upload-document:parent"));
    const farmId = (parent as { farm_id: string } | null)?.farm_id;
    if (!farmId) bounce(path, "finance-not-found");

    // The person's own file name is arbitrary input on a path; keep only the kind of file.
    const ext = file.type === "application/pdf" ? "pdf" : (file.type.split("/")[1] ?? "jpg").replace("jpeg", "jpg");
    const objectPath = `${farmId}/${parentId}/${crypto.randomUUID()}.${ext}`;
    const upload = await supabase.storage.from("finance-docs").upload(objectPath, file, { contentType: file.type });
    if (upload.error) {
      reportUnlessRefused(upload.error, "finance:upload-document:storage");
      bounce(path, "finance-doc-failed");
    }
    const { error } = await supabase.from("attachments").insert({
      farm_id: farmId,
      parent_type: parentType,
      parent_id: parentId,
      kind: "doc",
      storage_path: objectPath,
      created_by: profile.id,
    });
    if (error) {
      // Never leave a file nobody can find: take back the object this request stored.
      const removed = await supabase.storage.from("finance-docs").remove([objectPath]);
      if (removed.error) captureError(removed.error, { where: "finance:upload-document:cleanup" });
      bounceDb(path, errorCode(error, "finance:upload-document"));
    }
    return done(path, "finance-document");
  }, { whileRunning: withResult(path, "error", "still-saving") });
}

/** Remove an attached document (the row is soft-deleted; the activity log keeps it). */
export async function removeFinanceDocument(formData: FormData) {
  const profile = await actingProfile();
  const path = back(formData);
  const docId = id(formData, "document_id", path);
  const supabase = await createClient();
  const { data: existing, error: readError } = await supabase
    .from("attachments")
    .select("id")
    .eq("id", docId)
    .in("parent_type", ["finance_agreement", "asset_contract"])
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) bounceDb(path, errorCode(readError, "finance:remove-document:read"));
  if (!existing) bounce(path, "finance-not-found");
  // Not asked back: the select policy hides the row the moment it is soft-deleted.
  const { error } = await supabase
    .from("attachments")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", docId);
  if (error) bounceDb(path, errorCode(error, "finance:remove-document"));
  redirect(done(path, "finance-document-removed"));
}
