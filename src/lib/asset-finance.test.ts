/**
 * The finance arithmetic, on the SAME worked examples supabase/tests/asset_finance.sql
 * asserts against `app.finance_schedule` and friends. If either side changes, one of the
 * two suites fails: that is how the TS mirror (the live preview, the cash flow) and the
 * SQL that builds the real schedule are kept from drifting apart (CLAUDE.md, "a screen and
 * the engine can disagree about the same number").
 */

import assert from "node:assert/strict";
import test from "node:test";

import { t } from "@/lib/i18n";
import { formatNotification, notificationTitle, notificationUrl } from "@/lib/notifications/format";
import { FINANCE_LABEL_KEYS } from "@/components/asset-finance/labels";
import {
  FINANCE_SAVED_KEYS,
  addDays,
  addMonths,
  agreementBalance,
  annuityPayment,
  bpsToPercentInput,
  buildSchedule,
  centsToInput,
  commitmentGross,
  contractCostType,
  contractPaymentDates,
  contractTone,
  financeReturnPath,
  impliedRateBps,
  instalmentCostCents,
  isFinanceRole,
  monthlyCashflow,
  noticeDate,
  percentToBps,
  periodInterest,
  scheduleTotals,
  settlementCharge,
  vatCents,
  wholeNumberIn,
  withResult,
  type Commitment,
  type InstalmentState,
} from "@/lib/asset-finance";

function rowsOf(result: ReturnType<typeof buildSchedule>) {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unreachable");
  return result.rows;
}

test("A: R500 000 at 11.75% over 60 months amortises to the cent", () => {
  assert.equal(annuityPayment(50000000, 1175, 60, 1), 1105916);
  const rows = rowsOf(buildSchedule({ principalCents: 50000000, rateBps: 1175, termMonths: 60, frequency: "monthly", firstDate: "2026-01-31" }));
  assert.equal(rows.length, 60);
  const totals = scheduleTotals(rows);
  // Capital adds up to the principal EXACTLY: the last row absorbs every rounding cent.
  assert.equal(totals.capitalCents, 50000000);
  assert.equal(totals.interestCents, 16354967);
  assert.deepEqual(
    { i: rows[0].interestCents, c: rows[0].capitalCents, d: rows[0].dueDate, b: rows[0].balanceAfterCents },
    { i: 489583, c: 616333, d: "2026-01-31", b: 49383667 },
  );
  // Month ends: 31 January, then 28 February (counted from the first date, not chained).
  assert.deepEqual({ i: rows[1].interestCents, c: rows[1].capitalCents, d: rows[1].dueDate }, { i: 483548, c: 622368, d: "2026-02-28" });
  assert.equal(rows[2].dueDate, "2026-03-31");
  const last = rows[59];
  assert.equal(last.interestCents + last.capitalCents, 1105923);
  assert.equal(last.capitalCents, 1095199);
  assert.equal(last.balanceAfterCents, 0);
  assert.equal(last.dueDate, "2030-12-31");
});

test("B: a balloon is its own row on the last date, and capital still sums to the principal", () => {
  const rows = rowsOf(buildSchedule({
    principalCents: 100000000, rateBps: 1050, termMonths: 48, frequency: "monthly", firstDate: "2026-03-15", balloonCents: 30000000,
  }));
  assert.equal(rows.length, 49);
  assert.deepEqual({ i: rows[0].interestCents, c: rows[0].capitalCents }, { i: 875000, c: 1179737 });
  assert.equal(rows[47].interestCents + rows[47].capitalCents, 2054713);
  assert.equal(rows[47].balanceAfterCents, 30000000);
  const balloon = rows[48];
  assert.deepEqual(
    { kind: balloon.kind, c: balloon.capitalCents, i: balloon.interestCents, d: balloon.dueDate, b: balloon.balanceAfterCents },
    { kind: "balloon", c: 30000000, i: 0, d: "2030-02-15", b: 0 },
  );
  const totals = scheduleTotals(rows);
  assert.equal(totals.interestCents, 28627352);
  assert.equal(totals.capitalCents, 100000000);
});

test("C: interest-free rounding puts the odd cent on the last instalment", () => {
  const rows = rowsOf(buildSchedule({ principalCents: 100000, rateBps: 0, termMonths: 3, frequency: "monthly", firstDate: "2026-11-01" }));
  assert.deepEqual(rows.map((r) => r.capitalCents), [33333, 33333, 33334]);
  assert.ok(rows.every((r) => r.interestCents === 0));
});

test("D: quarterly payments from the 28th of February", () => {
  const rows = rowsOf(buildSchedule({ principalCents: 20000000, rateBps: 900, termMonths: 12, frequency: "quarterly", firstDate: "2026-02-28" }));
  assert.deepEqual(rows.map((r) => r.dueDate), ["2026-02-28", "2026-05-28", "2026-08-28", "2026-11-28"]);
  assert.equal(rows[3].interestCents + rows[3].capitalCents, 5284377);
  assert.equal(rows[3].interestCents, 116282);
});

test("the lender's own figure: the implied rate, the fee, and the last row", () => {
  assert.equal(impliedRateBps(50000000, 1105900, 60, 1), 1175);
  assert.equal(impliedRateBps(50000000, 1110000 - 6900, 60, 1), 1164);
  const result = buildSchedule({
    principalCents: 50000000, rateBps: 1164, termMonths: 60, frequency: "monthly", firstDate: "2026-01-31",
    instalmentCents: 1110000, feeCents: 6900,
  });
  const rows = rowsOf(result);
  assert.deepEqual({ i: rows[0].interestCents, c: rows[0].capitalCents, f: rows[0].feeCents }, { i: 485000, c: 618100, f: 6900 });
  assert.equal(rows[59].interestCents + rows[59].capitalCents + rows[59].feeCents, 1113865);
  // No rate given: the schedule implies it from the instalment.
  const implied = buildSchedule({
    principalCents: 50000000, rateBps: null, termMonths: 60, frequency: "monthly", firstDate: "2026-01-31",
    instalmentCents: 1110000, feeCents: 6900,
  });
  assert.equal(implied.ok && implied.rateBps, 1164);
});

test("refusals carry the same reason the SQL raises", () => {
  const base = { principalCents: 50000000, rateBps: 1175, termMonths: 60, frequency: "monthly", firstDate: "2026-01-31" };
  assert.deepEqual(buildSchedule({ ...base, instalmentCents: 400000 }), { ok: false, error: "finance-instalment-too-low" });
  assert.deepEqual(buildSchedule({ ...base, instalmentCents: 2000000 }), { ok: false, error: "finance-instalment-too-high" });
  assert.deepEqual(buildSchedule({ ...base, balloonCents: 50000000 }), { ok: false, error: "finance-balloon-too-large" });
  assert.deepEqual(buildSchedule({ ...base, termMonths: 10, frequency: "quarterly" }), { ok: false, error: "finance-term-frequency" });
  assert.deepEqual(buildSchedule({ ...base, rateBps: null }), { ok: false, error: "finance-rate-or-instalment" });
  assert.deepEqual(buildSchedule({ ...base, principalCents: 0 }), { ok: false, error: "finance-schedule-invalid" });
});

test("interest rounds half up on exact integers, never through a float", () => {
  // 1 000 cents at 6% for a month is exactly 5 cents; 1 010 at 6% is 5.05, rounded to 5.
  assert.equal(periodInterest(1000, 600, 1), 5);
  assert.equal(periodInterest(1010, 600, 1), 5);
  // 3 000 cents at 2% is exactly 5.0; 3 300 at 2% is 5.5, which rounds UP to 6.
  assert.equal(periodInterest(3300, 200, 1), 6);
  assert.equal(periodInterest(0, 1000, 1), 0);
  // Large balances stay exact (BigInt): R50m at 11.75% is 489 583,33, rounded to 489 583.
  assert.equal(periodInterest(50000000, 1175, 1), 489583);
});

const inst = (over: Partial<InstalmentState>): InstalmentState => ({
  kind: "instalment", status: "open", dueDate: "2026-01-31", interestCents: 489583, capitalCents: 616333,
  feeCents: 0, paidCents: 0, paidOn: null, ...over,
});

test("a payment covers interest first, then fees, then capital", () => {
  const agreement = { status: "active", principalCents: 50000000, statementBalanceCents: null, statementBalanceOn: null };
  const part = agreementBalance(agreement, [inst({ paidCents: 100000, paidOn: "2026-02-01" })], "2026-02-10");
  assert.equal(part.outstandingCapitalCents, 50000000, "a part payment below the interest moves no capital");
  assert.equal(part.balanceSource, "schedule");
  assert.equal(part.overdueCount, 1);
  const full = agreementBalance(agreement, [inst({ paidCents: 1105916, status: "paid", paidOn: "2026-01-31" })], "2026-02-10");
  assert.equal(full.outstandingCapitalCents, 50000000 - 616333);
  assert.equal(full.overdueCount, 0);
});

test("the lender's statement wins only when it is at least as new as the last payment", () => {
  const rows = [inst({ paidCents: 1105916, status: "paid", paidOn: "2026-01-31" })];
  const newer = agreementBalance(
    { status: "active", principalCents: 50000000, statementBalanceCents: 49000000, statementBalanceOn: "2026-02-05" },
    rows, "2026-02-10",
  );
  assert.deepEqual({ b: newer.balanceCents, s: newer.balanceSource }, { b: 49000000, s: "statement" });
  const older = agreementBalance(
    { status: "active", principalCents: 50000000, statementBalanceCents: 49000000, statementBalanceOn: "2026-01-15" },
    rows, "2026-02-10",
  );
  assert.deepEqual({ b: older.balanceCents, s: older.balanceSource }, { b: 50000000 - 616333, s: "schedule" });
  const settled = agreementBalance(
    { status: "settled", principalCents: 50000000, statementBalanceCents: null, statementBalanceOn: null },
    rows, "2026-02-10",
  );
  assert.deepEqual({ b: settled.balanceCents, s: settled.balanceSource }, { b: 0, s: "closed" });
});

test("capital is never a cost: an instalment costs its interest and fee, once due", () => {
  const row = inst({ feeCents: 6900 });
  assert.equal(instalmentCostCents(row, "2026-01-30"), 0, "nothing before the due date");
  assert.equal(instalmentCostCents(row, "2026-01-31"), 489583 + 6900);
  assert.equal(instalmentCostCents({ ...row, status: "settled" }, "2026-06-01"), 0, "a row a settlement closed accrues nothing");
  // Over a whole schedule the cost is the interest total, never principal plus interest.
  const rows = rowsOf(buildSchedule({ principalCents: 50000000, rateBps: 1175, termMonths: 60, frequency: "monthly", firstDate: "2026-01-31" }));
  const cost = rows.reduce((sum, r) => sum + instalmentCostCents({ ...inst({}), ...r, status: "open", paidCents: 0, paidOn: null }, "2031-01-01"), 0);
  assert.equal(cost, 16354967);
  assert.equal(settlementCharge(1000000, 1025000), 25000);
  assert.equal(settlementCharge(1000000, 990000), 0, "a discount on capital is not an income here");
});

test("contract payment dates, VAT and cost types", () => {
  assert.deepEqual(contractPaymentDates("2026-01-31", "monthly", "2026-02-01", "2026-04-30"), ["2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.deepEqual(contractPaymentDates("2026-05-01", "once", "2026-01-01", "2026-12-31"), ["2026-05-01"]);
  assert.deepEqual(contractPaymentDates("2026-05-01", "once", "2026-06-01", "2026-12-31"), []);
  // A long-running contract starts near the window, not in 2010.
  assert.deepEqual(contractPaymentDates("2010-03-15", "annual", "2026-01-01", "2027-12-31"), ["2026-03-15", "2027-03-15"]);
  assert.equal(vatCents(500000, 1500), 75000);
  assert.equal(vatCents(333, 1500), 50, "49.95 rounds half up to 50");
  assert.equal(vatCents(500000, 0), 0);
  assert.equal(contractCostType("operating_lease"), "lease");
  assert.equal(contractCostType("rental"), "lease");
  assert.equal(contractCostType("service_contract"), "other");
  assert.equal(noticeDate("2026-12-31", 60), "2026-11-01");
  assert.equal(noticeDate(null, 60), null);
});

test("the cash flow counts gross money by month and keeps empty months", () => {
  const c = (over: Partial<Commitment>): Commitment => ({
    kind: "instalment", source_id: "a", item_id: "i", machine_id: null, machine_name: null, party: "Bank",
    reference: null, on_date: "2026-11-15", amount_cents: 100000, vat_cents: 0, ...over,
  });
  const months = monthlyCashflow([
    c({}),
    c({ kind: "contract_payment", on_date: "2026-11-30", amount_cents: 500000, vat_cents: 75000 }),
    c({ kind: "contract_notice", on_date: "2026-12-01", amount_cents: null, vat_cents: null }),
    c({ kind: "balloon", on_date: "2027-01-10", amount_cents: 3000000 }),
  ], "2026-11", 3);
  assert.deepEqual(months, [
    { month: "2026-11", financeCents: 100000, contractCents: 575000, totalCents: 675000 },
    { month: "2026-12", financeCents: 0, contractCents: 0, totalCents: 0 },
    { month: "2027-01", financeCents: 3000000, contractCents: 0, totalCents: 3000000 },
  ]);
  assert.equal(commitmentGross(c({ amount_cents: 500000, vat_cents: 75000 })), 575000);
});

test("dates in strings: month ends, leap years and the year boundary", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonths("2026-11-30", 3), "2027-02-28");
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  assert.equal(addDays("2027-01-02", -3), "2026-12-30");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
});

test("what a person types becomes cents and basis points, or a refusal", () => {
  assert.equal(percentToBps("11,75"), 1175);
  assert.equal(percentToBps("11.75%"), 1175);
  assert.equal(percentToBps(""), null);
  assert.equal(percentToBps("101"), false);
  assert.equal(percentToBps("abc"), false);
  assert.equal(bpsToPercentInput(1175), "11.75");
  assert.equal(bpsToPercentInput(1100), "11");
  assert.equal(bpsToPercentInput(1105), "11.05");
  assert.equal(centsToInput(1105916), "11059.16");
  assert.equal(centsToInput(5), "0.05");
  assert.equal(centsToInput(null), "");
  assert.equal(wholeNumberIn("60", 1, 360), 60);
  assert.equal(wholeNumberIn("", 1, 360), null);
  assert.equal(wholeNumberIn("0", 1, 360), false);
  assert.equal(wholeNumberIn("6.5", 1, 360), false);
});

test("finance is for owners and managers (founder default), and Rapid Rise", () => {
  assert.equal(isFinanceRole("owner"), true);
  assert.equal(isFinanceRole("manager"), true);
  assert.equal(isFinanceRole("rr_admin"), true);
  for (const role of ["mechanic", "operator", "workshop", null, undefined]) assert.equal(isFinanceRole(role), false);
});

test("a contract is loud when its notice or end date is inside its lead", () => {
  const base = { status: "active", end_date: "2027-06-30", notice_date: "2027-05-01", reminder_lead_days: 30 };
  assert.equal(contractTone(base, "2026-11-01"), "ok");
  assert.equal(contractTone(base, "2027-04-10"), "warning");
  assert.equal(contractTone({ ...base, status: "ended" }, "2027-04-10"), "neutral");
});

test("the return path is one of the two screens, never an arbitrary address", () => {
  const machine = "/machines/af200000-0000-4000-8000-000000000001";
  assert.equal(financeReturnPath(machine), `${machine}?tab=costs`);
  assert.equal(financeReturnPath("/finance"), "/finance");
  assert.equal(financeReturnPath("https://example.test/steal"), "/finance");
  assert.equal(financeReturnPath("/machines/../admin"), "/finance");
  assert.equal(withResult(`${machine}?tab=costs`, "saved", "finance-payment"), `${machine}?tab=costs&saved=finance-payment`);
  assert.equal(withResult("/finance", "error", "x"), "/finance?error=x");
});

test("every finance word exists in both languages", () => {
  for (const lang of ["en", "af"] as const) {
    for (const key of [...FINANCE_LABEL_KEYS, ...Object.values(FINANCE_SAVED_KEYS), "assetFinance.pushTitle", "costType.lease"]) {
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
  }
  // The Afrikaans is written, not copied across.
  assert.notEqual(t("assetFinance.recordPayment", "af"), t("assetFinance.recordPayment", "en"));
});

test("reminders read as sentences, carry no amount, and open the right screen", () => {
  const payload = {
    agreement_id: "a1", machine_id: "m1", machine_name: "Tractor", lender: "Test Bank", seq: 4, count: 60,
    kind: "instalment", due_date: "2026-11-30",
  };
  const text = formatNotification("finance_instalment_due", payload, "en");
  assert.match(text, /Test Bank/);
  assert.match(text, /Tractor/);
  assert.doesNotMatch(text, /R\d/);
  assert.doesNotMatch(text, /\{/);
  assert.match(formatNotification("finance_instalment_due", { ...payload, lender: "-" }, "en"), /Lender not recorded/);
  assert.match(formatNotification("contract_notice_due", { party: "Lease Co", notice_date: "2026-11-01", end_date: "2026-12-31", auto_renews: true }, "af"), /Lease Co/);
  assert.equal(notificationTitle("finance_instalment_overdue", "en"), t("assetFinance.pushTitle", "en"));
  assert.equal(notificationTitle("contract_ending", "en"), t("assetFinance.pushTitle", "en"));
  assert.equal(notificationUrl("finance_instalment_due", payload), "/machines/m1?tab=costs");
  assert.equal(notificationUrl("contract_ending", { contract_id: "c1", machine_id: null }), "/finance");
});
