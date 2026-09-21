/**
 * What the job card says about cover, and what the dealer still owes.
 *
 * The cover arithmetic is SQL's (`app.job_card_warranty_cover`) and stays there; what is
 * pinned here is how the screen READS that answer. The important case is the third one:
 * "no warranty recorded" is not "not covered", and collapsing the two is how a real claim
 * goes unmade because a screen told somebody they had none.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { t } from "@/lib/i18n";
import {
  WARRANTY_STATUSES,
  claimLook,
  claimOpen,
  claimTotals,
  coverLook,
  coverReasonKey,
  coverVerdict,
  daysWaiting,
  requiredFor,
  type WarrantyClaimRow,
  type WarrantyCover,
} from "./warranty-claims";

function cover(over: Partial<WarrantyCover> = {}): WarrantyCover {
  return {
    job_card_id: "jc1",
    machine_id: "m1",
    on_date: "2026-01-15",
    meter_reading: 1500,
    covered_by_date: true,
    covered_by_hours: true,
    covered: true,
    ...over,
  };
}

function claim(over: Partial<WarrantyClaimRow> = {}): WarrantyClaimRow {
  return {
    id: "c1",
    farm_id: "farm-1",
    machine_id: "m1",
    job_card_id: "jc1",
    supplier: "Dealer",
    reference: "W-1",
    status: "submitted",
    submitted_on: "2026-06-20",
    decided_on: null,
    claimed_ex_vat_cents: 450000,
    recovered_ex_vat_cents: null,
    notes: null,
    covered_by_date: true,
    covered_by_hours: true,
    created_at: "2026-06-20T08:00:00Z",
    ...over,
  };
}

test("no warranty recorded is its own answer, never a refusal", () => {
  // The machine may well be covered; nobody typed the dates in. Telling a farm they are
  // not covered here is how a claim that would have been paid never gets made.
  assert.equal(coverVerdict(cover({ covered: null })), "unknown");
  assert.equal(coverVerdict(null), "unknown");
  assert.notEqual(coverVerdict(cover({ covered: null })), "not-covered");
  // And it is the one verdict that asks for attention rather than sitting quietly.
  assert.equal(coverLook("unknown").tone, "warning");
  assert.equal(coverLook("not-covered").tone, "neutral");
  assert.equal(coverLook("covered").tone, "ok");
});

test("the screen says WHICH basis ran out", () => {
  // The two expire independently, and a farm arguing with a dealer needs to know which
  // one it was: only one of them may be wrong in the records.
  assert.equal(
    coverReasonKey(cover({ covered: false, covered_by_date: true, covered_by_hours: false })),
    "warranty.reasonHours",
  );
  assert.equal(
    coverReasonKey(cover({ covered: false, covered_by_date: false, covered_by_hours: true })),
    "warranty.reasonDate",
  );
  assert.equal(
    coverReasonKey(cover({ covered: false, covered_by_date: false, covered_by_hours: false })),
    "warranty.reasonBoth",
  );
  // Nothing to explain when it WAS covered, or when nobody knows.
  assert.equal(coverReasonKey(cover({ covered: true })), null);
  assert.equal(coverReasonKey(cover({ covered: null })), null);
});

test("only a claim actually with the dealer is money still owed", () => {
  const rows = [
    claim({ id: "sent", status: "submitted", claimed_ex_vat_cents: 450000 }),
    claim({ id: "agreed", status: "approved", claimed_ex_vat_cents: 120000 }),
    // Paid: already banked, so counting it would say the farm is owed it twice.
    claim({ id: "paid", status: "paid", claimed_ex_vat_cents: 300000,
            recovered_ex_vat_cents: 280000, decided_on: "2026-08-01" }),
    // Never sent, refused, or dropped. None of these is owed by anybody.
    claim({ id: "draft", status: "draft", submitted_on: null, claimed_ex_vat_cents: 900000 }),
    claim({ id: "no", status: "rejected", claimed_ex_vat_cents: 700000 }),
    claim({ id: "gone", status: "withdrawn", submitted_on: null, claimed_ex_vat_cents: 500000 }),
  ];
  const totals = claimTotals(rows);
  assert.equal(totals.outstanding, 570000);
  assert.equal(totals.recovered, 280000);
  assert.equal(totals.openCount, 2);
});

test("how long a claim has waited matches what the nightly chase says", () => {
  assert.equal(daysWaiting(claim({ submitted_on: "2026-06-20" }), "2026-08-19"), 60);
  assert.equal(daysWaiting(claim({ submitted_on: "2026-08-19" }), "2026-08-19"), 0);
  // Not waiting: settled, refused, never sent.
  assert.equal(daysWaiting(claim({ status: "paid" }), "2026-08-19"), null);
  assert.equal(daysWaiting(claim({ status: "rejected" }), "2026-08-19"), null);
  assert.equal(daysWaiting(claim({ status: "draft", submitted_on: null }), "2026-08-19"), null);
});

test("the form asks for exactly what the database will insist on", () => {
  // `warranty_claims_submitted_ck`: anything past draft carries the day it went.
  for (const s of ["submitted", "approved", "paid", "rejected"] as const) {
    assert.equal(requiredFor(s).submittedOn, true, `${s} must carry a submission date`);
  }
  for (const s of ["draft", "withdrawn"] as const) {
    assert.equal(requiredFor(s).submittedOn, false, `${s} must not demand one`);
  }
  // `warranty_claims_paid_ck`: paid carries the amount and the date, or it is not paid.
  assert.equal(requiredFor("paid").payout, true);
  for (const s of WARRANTY_STATUSES.filter((x) => x !== "paid")) {
    assert.equal(requiredFor(s).payout, false, `${s} must not demand a payout`);
  }
});

test("a refusal and a withdrawal do not look alike", () => {
  // One is the dealer saying no; the other is the farm choosing not to pursue it. The
  // difference matters the next time somebody asks why this repair was never claimed.
  assert.notEqual(claimLook("rejected").tone, claimLook("withdrawn").tone);
  assert.equal(claimOpen("rejected"), false);
  assert.equal(claimOpen("submitted"), true);
  assert.equal(claimOpen("approved"), true, "approved is agreed but not yet paid");
});

test("every status and every verdict has words in both languages", () => {
  for (const lang of ["en", "af"] as const) {
    for (const s of WARRANTY_STATUSES) {
      const key = claimLook(s).labelKey;
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
    for (const v of ["covered", "not-covered", "unknown"] as const) {
      const key = coverLook(v).labelKey;
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
    for (const key of ["warranty.reasonDate", "warranty.reasonHours", "warranty.reasonBoth"]) {
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
  }
});
