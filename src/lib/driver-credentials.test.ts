/**
 * The screen's copy of two SQL rules, pinned to the SQL case by case.
 *
 * `credentialState` mirrors `app.expiry_status_of` (0263), which is what the nightly pass
 * uses to decide whether to warn a farm. `lapsedOn` mirrors
 * `app.driver_credential_lapses` (20260921090000), which is the authority when the
 * question is asked in the database. Either pair disagreeing means the screen says a PrDP
 * is fine on the morning the engine emails to say it expired, the same class of mistake
 * that once quoted a production farm R0,00 against a real R750,00 invoice.
 *
 * The cases below are the ones `supabase/tests/driver_credentials.sql` section (e) asserts
 * against a real database, written out again here against the pure functions.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { t } from "@/lib/i18n";
import {
  CREDENTIAL_TYPES,
  countTone,
  credentialLook,
  credentialPerson,
  credentialState,
  expiryOrder,
  lapsedOn,
  type CredentialRow,
} from "./driver-credentials";

function cred(over: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: "c1",
    farm_id: "farm-1",
    user_id: "user-1",
    person_name: null,
    type: "prdp",
    code: "G",
    number: "P-1",
    issued_on: null,
    expiry_date: "2026-06-30",
    reminder_lead_days: 30,
    notes: null,
    ...over,
  };
}

// == What state a document is in ==============================================

test("the last day on the card is a day the driver may still drive", () => {
  // `expiry < today` in SQL. On the 30th the PrDP is valid; on the 1st it is not. Off by
  // one here tells a farm their driver may not drive on a day they may, and a warning that
  // is wrong in that direction is a warning that stops being read.
  assert.equal(credentialState(cred({ expiry_date: "2026-06-30" }), "2026-06-30"), "expiring");
  assert.equal(credentialState(cred({ expiry_date: "2026-06-30" }), "2026-07-01"), "expired");
});

test("expiring starts exactly at the lead the farm chose", () => {
  const row = (lead: number | null) => cred({ expiry_date: "2026-07-01", reminder_lead_days: lead });
  // 30 days before, to the day.
  assert.equal(credentialState(row(30), "2026-06-01"), "expiring");
  assert.equal(credentialState(row(30), "2026-05-31"), "ok");
  // A shorter lead stays quiet for longer; a longer one speaks sooner.
  assert.equal(credentialState(row(7), "2026-06-01"), "ok");
  assert.equal(credentialState(row(90), "2026-05-01"), "expiring");
  // Null falls back to the same 30 the SQL's `coalesce(..., 30)` uses.
  assert.equal(credentialState(row(null), "2026-06-01"), "expiring");
  // A zero lead is a real choice, warn me on the day, not before, and not "use 30".
  assert.equal(credentialState(row(0), "2026-06-30"), "ok");
  assert.equal(credentialState(row(0), "2026-07-01"), "expiring");
});

test("no expiry date is its own answer, never a green badge", () => {
  // An induction that never expires and a licence nobody captured a date for look
  // identical in the database and mean opposite things to a farm.
  const none = credentialState(cred({ expiry_date: null }), "2026-06-01");
  assert.equal(none, "none");
  assert.notEqual(none, "ok");
  assert.equal(credentialLook("none").tone, "neutral");
});

test("the list puts trouble at the top", () => {
  const order = (["ok", "none", "expired", "expiring"] as const)
    .slice()
    .sort((a, b) => expiryOrder(a) - expiryOrder(b));
  assert.deepEqual(order, ["expired", "expiring", "ok", "none"]);
});

test("a count of zero is never a loud tile", () => {
  assert.equal(countTone(0, "expired"), "default");
  assert.equal(countTone(0, "expiring"), "default");
  assert.equal(countTone(1, "expired"), "overdue");
  assert.equal(countTone(1, "expiring"), "due");
});

test("every state and every document kind has words in both languages", () => {
  for (const lang of ["en", "af"] as const) {
    for (const state of ["expired", "expiring", "ok", "none"] as const) {
      const key = credentialLook(state).labelKey;
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
    for (const kind of CREDENTIAL_TYPES) {
      const key = `credentialType.${kind}`;
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
  }
});

// == Whose document it is =====================================================

test("a person is named, and an unresolvable one still prints something", () => {
  const names = new Map([["user-1", "Sipho Ndlovu"]]);
  assert.equal(credentialPerson(cred(), names), "Sipho Ndlovu");
  assert.equal(credentialPerson(cred({ user_id: null, person_name: "  Koos Casual  " }), names), "Koos Casual");
  // A compliance screen with a blank name in a row is worse than a short id.
  const orphan = credentialPerson(cred({ user_id: "user-9" }), names);
  assert.ok(orphan.length > 0, "a row whose user cannot be resolved printed nothing");
});

// == Were they licensed on the day of the offence? ============================

test("a nomination is judged on the offence date, not on today", () => {
  const rows = [
    cred({ id: "licence", type: "drivers_licence", expiry_date: "2027-12-31" }),
    cred({ id: "prdp", type: "prdp", expiry_date: "2026-05-31" }),
  ];
  // The 14th of June: the PrDP lapsed a fortnight earlier, the licence is good for a year.
  const june = lapsedOn(rows, { userId: "user-1", name: null }, "2026-06-14");
  assert.equal(june.length, 1);
  assert.equal(june[0]?.id, "prdp");

  // The 1st of May: both were valid. A warning here would be wrong, and a warning that is
  // sometimes wrong is one nobody reads.
  assert.equal(lapsedOn(rows, { userId: "user-1", name: null }, "2026-05-01").length, 0);

  // The last day is inclusive on this side too: on the 31st the PrDP still counted.
  assert.equal(lapsedOn(rows, { userId: "user-1", name: null }, "2026-05-31").length, 0);
  assert.equal(lapsedOn(rows, { userId: "user-1", name: null }, "2026-06-01").length, 1);
});

test("a typed name matches only documents filed against a name", () => {
  const rows = [
    cred({ id: "casual", user_id: null, person_name: "  Koos Casual  ", expiry_date: "2026-01-01" }),
    cred({ id: "sipho", user_id: "user-1", person_name: null, expiry_date: "2026-01-01" }),
  ];
  // Trimmed and case-folded, because a name typed twice is typed twice.
  const byName = lapsedOn(rows, { userId: null, name: "koos casual" }, "2026-06-14");
  assert.equal(byName.length, 1);
  assert.equal(byName[0]?.id, "casual");

  // And never against a real person's file. One careless free-text entry must not be able
  // to speak for a signed-in driver's record on a document the farm may later rely on.
  assert.equal(lapsedOn(rows, { userId: null, name: "Sipho Ndlovu" }, "2026-06-14").length, 0);

  // A fine with no driver identified at all warns about nobody.
  assert.equal(lapsedOn(rows, { userId: null, name: null }, "2026-06-14").length, 0);
  assert.equal(lapsedOn(rows, { userId: null, name: "   " }, "2026-06-14").length, 0);
});

test("a document with no expiry date never produces a lapse", () => {
  const rows = [cred({ id: "induction", type: "induction", expiry_date: null })];
  assert.equal(lapsedOn(rows, { userId: "user-1", name: null }, "2026-06-14").length, 0);
});

test("lapses come back oldest first, because that is the one to explain", () => {
  const rows = [
    cred({ id: "recent", expiry_date: "2026-06-01" }),
    cred({ id: "ancient", type: "medical", expiry_date: "2024-02-02" }),
  ];
  const out = lapsedOn(rows, { userId: "user-1", name: null }, "2026-06-14");
  assert.deepEqual(out.map((r) => r.id), ["ancient", "recent"]);
});
