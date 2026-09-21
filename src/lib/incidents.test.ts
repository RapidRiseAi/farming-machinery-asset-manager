/**
 * The claim arithmetic, and the two SQL constraints the form has to know about.
 *
 * `outstandingClaimCents` is the number a farm would ring their broker about, so the cases
 * below are mostly about what it must NOT count. `requiredFor` mirrors
 * `incidents_lodged_ck` and `incidents_settled_ck` from 20260921100000, the database
 * stays the authority; this exists so the refusal is a sentence rather than a constraint
 * name, and it is walked against every status so a new one cannot be added on one side.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { t } from "@/lib/i18n";
import {
  INCIDENT_KINDS,
  INCIDENT_STATUSES,
  claimOpen,
  daysWaiting,
  incidentLook,
  incidentOpen,
  incidentOrder,
  outstandingClaimCents,
  requiredFor,
  settledClaimCents,
  type IncidentRow,
  type IncidentStatus,
} from "./incidents";

function inc(over: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: "i1",
    farm_id: "farm-1",
    machine_id: "m1",
    kind: "collision",
    status: "claim_lodged",
    occurred_at: "2026-06-14T09:00:00Z",
    location: null,
    description: null,
    driver_user_id: null,
    driver_name: null,
    saps_case_number: null,
    saps_station: null,
    third_party_name: null,
    third_party_contact: null,
    third_party_reg_no: null,
    third_party_insurer: null,
    injuries: false,
    injury_notes: null,
    insurer: "Santam",
    claim_number: "CLM-1",
    claim_lodged_on: "2026-06-20",
    excess_incl_cents: 500000,
    claimed_incl_cents: 4500000,
    settled_incl_cents: null,
    settled_on: null,
    claim_notes: null,
    job_card_id: null,
    created_at: "2026-06-14T10:00:00Z",
    ...over,
  };
}

test("only a lodged claim is money the insurer still owes", () => {
  const rows = [
    inc({ id: "lodged", status: "claim_lodged", claimed_incl_cents: 4500000 }),
    // Paid. Counting it would say the farm is owed money it has already banked.
    inc({ id: "settled", status: "claim_settled", claimed_incl_cents: 300000,
          settled_incl_cents: 280000, settled_on: "2026-08-01" }),
    // The insurer said no. It is not owed, however much it was worth.
    inc({ id: "rejected", status: "claim_rejected", claimed_incl_cents: 900000 }),
    // The farm chose not to claim, below the excess. Nobody was ever asked for it.
    inc({ id: "none", status: "no_claim", claimed_incl_cents: 120000, claim_lodged_on: null }),
    inc({ id: "reported", status: "reported", claimed_incl_cents: 700000, claim_lodged_on: null }),
  ];
  assert.equal(outstandingClaimCents(rows), 4500000);
  assert.equal(settledClaimCents(rows), 280000);
});

test("a lodged claim with no figure counts as nothing, not as nothing there", () => {
  // It still shows in the count of open claims beside the total, which is what tells the
  // farm a number is missing. Dropping the row instead would make the two disagree.
  const rows = [inc({ claimed_incl_cents: null })];
  assert.equal(outstandingClaimCents(rows), 0);
  assert.equal(rows.filter((r) => claimOpen(r.status)).length, 1);
});

test("how long a claim has been waiting matches what the nightly chase says", () => {
  // `app.enqueue_incident_claim_chases` puts `current_date - claim_lodged_on` in the
  // payload and the screen has to agree with it, or the reminder says 60 and the row it
  // links to says something else.
  assert.equal(daysWaiting(inc({ claim_lodged_on: "2026-06-20" }), "2026-08-19"), 60);
  assert.equal(daysWaiting(inc({ claim_lodged_on: "2026-06-20" }), "2026-06-20"), 0);
  // Not waiting: settled, rejected, never lodged.
  assert.equal(daysWaiting(inc({ status: "claim_settled" }), "2026-08-19"), null);
  assert.equal(daysWaiting(inc({ status: "reported", claim_lodged_on: null }), "2026-08-19"), null);
});

test("the longest-waiting claim is the top row", () => {
  const rows = [
    inc({ id: "young", claim_lodged_on: "2026-08-01" }),
    inc({ id: "closed", status: "closed", claim_lodged_on: null, occurred_at: "2026-07-01T00:00:00Z" }),
    inc({ id: "old", claim_lodged_on: "2026-02-01" }),
    inc({ id: "open-no-claim", status: "reported", claim_lodged_on: null, occurred_at: "2026-07-20T00:00:00Z" }),
  ];
  const order = rows.slice().sort((a, b) => incidentOrder(a, b, "2026-08-19")).map((r) => r.id);
  // Waiting claims first, oldest of them at the top; then anything still open; then done.
  assert.deepEqual(order, ["old", "young", "open-no-claim", "closed"]);
});

test("what still needs somebody, and what does not", () => {
  assert.equal(incidentOpen("reported"), true);
  assert.equal(incidentOpen("investigating"), true);
  assert.equal(incidentOpen("claim_lodged"), true);
  assert.equal(incidentOpen("claim_rejected"), true, "a rejection still needs a decision");
  // Three ways of being finished: paid, deliberately not claimed, or closed.
  assert.equal(incidentOpen("claim_settled"), false);
  assert.equal(incidentOpen("no_claim"), false);
  assert.equal(incidentOpen("closed"), false);
});

test("the form asks for exactly what the database will insist on", () => {
  // `incidents_lodged_ck`: a lodging date on anything past lodging.
  for (const s of ["claim_lodged", "claim_settled", "claim_rejected"] as const) {
    assert.equal(requiredFor(s).lodgedOn, true, `${s} must carry a lodging date`);
  }
  for (const s of ["reported", "investigating", "no_claim", "closed"] as const) {
    assert.equal(requiredFor(s).lodgedOn, false, `${s} must not demand a lodging date`);
  }
  // `incidents_settled_ck`: a settled claim has a figure AND a date, or it is not settled.
  assert.equal(requiredFor("claim_settled").settlement, true);
  for (const s of INCIDENT_STATUSES.filter((x) => x !== "claim_settled")) {
    assert.equal(requiredFor(s).settlement, false, `${s} must not demand a settlement`);
  }
});

test("a rejection and a decision not to claim do not look alike", () => {
  // One is the insurer saying no; the other is the farm choosing not to ask. Showing them
  // alike loses the difference on the screen as well as in the call with the broker.
  assert.notEqual(incidentLook("claim_rejected").tone, incidentLook("no_claim").tone);
  assert.equal(incidentLook("claim_rejected").tone, "danger");
  assert.equal(incidentLook("no_claim").tone, "neutral");
});

test("every status and every kind has words in both languages", () => {
  // `enumLabel` prints the raw Postgres value on a miss, which looks plausible enough to
  // ship, four billing groups did exactly that from day one.
  for (const lang of ["en", "af"] as const) {
    for (const s of INCIDENT_STATUSES) {
      const key = incidentLook(s).labelKey;
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
    for (const k of INCIDENT_KINDS) {
      const key = `incidentKind.${k}`;
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
  }
});
