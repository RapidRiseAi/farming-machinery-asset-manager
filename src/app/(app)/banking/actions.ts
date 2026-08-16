"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, currentWorkshop, requireWorkshopEntitlement } from "@/lib/auth";
import { parseStatement, MAX_STATEMENT_ROWS } from "@/lib/banking";

/**
 * Bank statement import and reconciliation (G15).
 *
 * Two rules govern everything in this file.
 *
 * FIRST: the import writes nothing to the books. It stores what the bank says and stops.
 * A statement is a claim about cash, not an instruction to post entries, and a product that
 * turns one into the other automatically is a product that silently marks the wrong invoice
 * paid at three in the morning. Every settlement below starts with a person pressing a
 * button next to a suggestion they can see.
 *
 * SECOND: settling money IN means inserting a `partner_payments` row and NOTHING else. The
 * document's paid amount and its status are moved by the 0381 rollup trigger, which is
 * already the single place that decision is made — for a payment captured by hand, for a
 * PayFast callback, and now for this. Writing `amount_paid_cents` here as well would put a
 * second author on the same number, and the two would eventually disagree.
 *
 * Every write goes through the ordinary RLS client. `bank_lines` is workshop-scoped and
 * `partner_payments` is scoped to documents the caller's workshop issued, so a guessed id
 * from another business matches zero rows rather than someone else's money.
 */

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

/** Postgres unique violation. Not an error the partner needs to see as one — see below. */
const isDuplicate = (code: string | undefined) => code === "23505";

/**
 * Load a bank statement that has already been mapped into our canonical columns by the
 * browser. The server therefore parses one known shape, exactly as the machines importer
 * does, and knows nothing about which bank produced the file.
 *
 * Duplicate suppression is left entirely to the `bank_lines_natural_uq` index (0470). There
 * is deliberately no "which of these do I already have?" query in front of the insert: that
 * is a check-then-act, and two tabs or a double-tapped button on a phone both pass the check
 * before either writes. `ignoreDuplicates` turns it into a single `on conflict do nothing`,
 * and PostgREST returns only the rows that were actually inserted — which is also the
 * honest count to report back ("30 rows, 12 were new").
 */
export async function importBankStatement(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");
  await requireWorkshopEntitlement("financials", "/banking");

  const csv = String(formData.get("csv") ?? "");
  const parsed = parseStatement(csv);
  if (parsed.headerError) redirect(`/banking/import?error=${parsed.headerError}`);
  if (parsed.validCount === 0) redirect("/banking/import?error=nothing_valid");
  if (parsed.validCount > MAX_STATEMENT_ROWS) redirect("/banking/import?error=too_many");

  const supabase = await createClient();

  const { data: batch, error: batchError } = await supabase
    .from("bank_statement_imports")
    .insert({
      workshop_id: workshop.id,
      file_name: s(formData, "file_name"),
      account_label: s(formData, "account_label"),
      rows_in_file: parsed.rows.length,
      rows_added: 0,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (batchError || !batch) redirect(`/banking/import?error=${encodeURIComponent(batchError?.message ?? "failed")}`);

  const rows = parsed.rows
    .filter((r) => r.row)
    .map((r) => ({
      workshop_id: workshop.id,
      import_id: (batch as { id: string }).id,
      txn_date: r.row!.txn_date,
      description: r.row!.description,
      reference: r.row!.reference,
      amount_cents: r.row!.amount_cents,
      row_no: r.row!.row_no,
      occurrence: r.row!.occurrence,
      created_by: profile.id,
    }));

  // Chunked so a full year's statement does not become one enormous request. Each chunk is
  // independently idempotent, so a retry after a half-completed load adds only what is
  // still missing rather than a second copy of everything.
  let added = 0;
  for (let i = 0; i < rows.length; i += 400) {
    const { data, error } = await supabase
      .from("bank_lines")
      .upsert(rows.slice(i, i + 400), {
        onConflict: "workshop_id,txn_date,amount_cents,fingerprint,occurrence",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) redirect(`/banking/import?error=${encodeURIComponent(error.message)}`);
    added += (data ?? []).length;
  }

  await supabase
    .from("bank_statement_imports")
    .update({ rows_added: added, updated_at: new Date().toISOString() })
    .eq("id", (batch as { id: string }).id);

  revalidatePath("/banking");
  redirect(`/banking?imported=${added}&seen=${parsed.validCount}`);
}

/**
 * Confirm one suggestion. The only place in this feature that writes to the ledger.
 *
 * Pressing it twice is EXPECTED, not exceptional — a phone on a bad signal in a workshop
 * yard is exactly where people press again while the first request is still in flight. The
 * second attempt loses the race against `partner_payments_bank_line_uq` / `partner_expenses
 * _bank_line_uq` (0471) and comes back as a unique violation, which is reported as "already
 * done" rather than as a failure, because from the partner's point of view it is not one.
 * The status check above it is a courtesy that saves a round trip; the index is the
 * guarantee, because only the database can decide a race.
 */
export async function confirmMatch(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  await requireWorkshopEntitlement("financials", "/banking");
  const lineId = s(formData, "line_id");
  const targetId = s(formData, "target_id");
  const kind = String(formData.get("target_kind") ?? "");
  if (!lineId || !targetId) redirect("/banking?error=not_found");

  const supabase = await createClient();
  const { data: line } = await supabase
    .from("bank_lines")
    .select("id, amount_cents, txn_date, description, reference, status")
    .eq("id", lineId)
    .is("deleted_at", null)
    .maybeSingle();

  if (!line) redirect("/banking?error=not_found");
  const l = line as {
    id: string; amount_cents: number; txn_date: string;
    description: string | null; reference: string | null; status: string;
  };
  if (l.status === "matched") redirect("/banking?already=1");

  if (kind === "invoice") {
    if (l.amount_cents <= 0) redirect("/banking?error=wrong_direction");

    const { data: doc } = await supabase
      .from("partner_documents")
      .select("id, farm_id, kind, status, total_cents, amount_paid_cents")
      .eq("id", targetId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!doc) redirect("/banking?error=not_found");
    const d = doc as {
      id: string; farm_id: string | null; kind: string; status: string;
      total_cents: number; amount_paid_cents: number;
    };
    if (d.kind !== "invoice") redirect("/banking?error=not_an_invoice");

    const outstanding = Math.max(0, d.total_cents - d.amount_paid_cents);
    if (outstanding <= 0) redirect("/banking?error=already_settled");
    // Refused rather than trimmed. Posting only part of a bank line would leave the rest of
    // the money silently unaccounted for while the line disappeared off the unreconciled
    // list — which is the exact hole this feature exists to close.
    if (l.amount_cents > outstanding) redirect("/banking?error=more_than_owed");

    const { error } = await supabase.from("partner_payments").insert({
      document_id: d.id,
      farm_id: d.farm_id,
      amount_cents: l.amount_cents,
      // The date the money actually moved, not the date somebody got around to
      // reconciling it. A statement that lands three weeks late must not restate cash.
      paid_on: l.txn_date,
      method: "eft",
      reference: l.reference,
      note: l.description,
      recorded_by: profile.id,
      bank_line_id: l.id,
    });
    if (error) {
      if (isDuplicate(error.code)) redirect("/banking?already=1");
      redirect(`/banking?error=${encodeURIComponent(error.message)}`);
    }
  } else if (kind === "expense") {
    if (l.amount_cents >= 0) redirect("/banking?error=wrong_direction");

    // `.is("paid_on", null)` is the second half of the idempotency: a supplier invoice that
    // is already settled is not re-stamped with a different date by a second press.
    const { data, error } = await supabase
      .from("partner_expenses")
      .update({ paid_on: l.txn_date, bank_line_id: l.id, updated_at: new Date().toISOString() })
      .eq("id", targetId)
      .is("paid_on", null)
      .is("deleted_at", null)
      .select("id");
    if (error) {
      if (isDuplicate(error.code)) redirect("/banking?already=1");
      redirect(`/banking?error=${encodeURIComponent(error.message)}`);
    }
    if ((data ?? []).length === 0) redirect("/banking?already=1");
  } else {
    redirect("/banking?error=not_found");
  }

  revalidatePath("/banking");
  revalidatePath("/documents");
  revalidatePath("/expenses");
  revalidatePath("/money");
  redirect("/banking?matched=1");
}

/**
 * Take a confirmation back.
 *
 * Nothing here touches `bank_lines.status`: removing the settlement row is what makes the
 * line unreconciled again, through the 0472 resync trigger. That is the whole reason the
 * status is derived — an undo written in two places is an undo that can be half done.
 *
 * The payment is SOFT deleted, like everything else in this schema, so the audit trail
 * keeps the fact that it was once recorded and then reversed. `bank_line_id` is cleared on
 * an expense because the unique index would otherwise keep that pairing reserved for ever
 * and the partner could never re-match the same line to the same bill after fixing a date.
 */
export async function undoMatch(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  await requireWorkshopEntitlement("financials", "/banking");
  const lineId = s(formData, "line_id");
  if (!lineId) redirect("/banking?error=not_found");

  const supabase = await createClient();
  const { data: line } = await supabase
    .from("bank_lines")
    .select("id, matched_payment_id, matched_expense_id")
    .eq("id", lineId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!line) redirect("/banking?error=not_found");
  const l = line as { id: string; matched_payment_id: string | null; matched_expense_id: string | null };

  if (l.matched_payment_id) {
    await supabase
      .from("partner_payments")
      .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
      .eq("id", l.matched_payment_id);
  }
  if (l.matched_expense_id) {
    await supabase
      .from("partner_expenses")
      .update({ paid_on: null, bank_line_id: null, updated_at: new Date().toISOString() })
      .eq("id", l.matched_expense_id);
  }

  revalidatePath("/banking");
  revalidatePath("/documents");
  revalidatePath("/expenses");
  revalidatePath("/money");
  redirect("/banking?undone=1");
}

/**
 * "This one will never match anything in here" — bank charges, interest, a transfer to the
 * owner's own account, rent already captured in a different month.
 *
 * Without it the unreconciled list only ever grows, and a list that is never empty is a list
 * nobody opens. Reversible on purpose: it is a filing decision, not a deletion.
 */
export async function setAsideLine(formData: FormData) {
  await requireRole(["workshop"]);
  await requireWorkshopEntitlement("financials", "/banking");
  const lineId = s(formData, "line_id");
  if (!lineId) redirect("/banking?error=not_found");

  const supabase = await createClient();
  await supabase
    .from("bank_lines")
    .update({ status: "ignored", updated_at: new Date().toISOString() })
    .eq("id", lineId)
    .eq("status", "unmatched");

  revalidatePath("/banking");
  redirect("/banking?aside=1");
}

export async function restoreLine(formData: FormData) {
  await requireRole(["workshop"]);
  await requireWorkshopEntitlement("financials", "/banking");
  const lineId = s(formData, "line_id");
  if (!lineId) redirect("/banking?error=not_found");

  const supabase = await createClient();
  await supabase
    .from("bank_lines")
    .update({ status: "unmatched", updated_at: new Date().toISOString() })
    .eq("id", lineId)
    .eq("status", "ignored");

  revalidatePath("/banking");
  redirect("/banking?restored=1");
}

/**
 * Remove a line that should not be in here at all — a heading the parser read as data, a
 * row from the wrong account.
 *
 * Soft delete, and the natural-key index in 0470 deliberately covers deleted rows, so this
 * survives the statement being uploaded again. That is what "remove" has to mean: a line
 * that came back every Friday would make the button worthless.
 */
export async function removeLine(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  await requireWorkshopEntitlement("financials", "/banking");
  const lineId = s(formData, "line_id");
  if (!lineId) redirect("/banking?error=not_found");

  const supabase = await createClient();
  await supabase
    .from("bank_lines")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", lineId)
    .eq("status", "unmatched");

  revalidatePath("/banking");
  redirect("/banking?removed=1");
}
