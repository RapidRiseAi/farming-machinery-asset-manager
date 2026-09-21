/**
 * Calendar arithmetic, done in strings.
 *
 * The reason this file exists at all is that a calendar built on `Date` picks up the
 * SERVER's timezone. This product renders on Vercel and is read on a farm; a service due
 * on the 1st would show on the 30th for anybody west of the server, and nobody would ever
 * report it as a bug because the date on the machine page would look right. So none of
 * these functions constructs a Date, and these cases check the arithmetic that replaces it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { t } from "@/lib/i18n";
import {
  CALENDAR_KINDS,
  byDay,
  daysInMonth,
  isMonth,
  itemHref,
  leadingBlanks,
  monthDays,
  monthRange,
  monthTotals,
  shiftMonth,
  stateLook,
  weekdayIndex,
  worstState,
  type CalendarItem,
} from "./calendar";

function item(over: Partial<CalendarItem> = {}): CalendarItem {
  return {
    kind: "service_due",
    item_id: "i1",
    machine_id: "m1",
    machine_name: "Rooi Massey",
    title: "500-hour service",
    detail: null,
    on_date: "2026-10-12",
    state: "due_soon",
    ...over,
  };
}

test("February knows about leap years without asking a Date", () => {
  assert.equal(daysInMonth("2026-02"), 28);
  assert.equal(daysInMonth("2028-02"), 29);
  // The centuries, which is where a naive rule breaks.
  assert.equal(daysInMonth("1900-02"), 28);
  assert.equal(daysInMonth("2000-02"), 29);
  assert.equal(daysInMonth("2026-04"), 30);
  assert.equal(daysInMonth("2026-12"), 31);
});

test("a month range covers the whole month and nothing else", () => {
  assert.deepEqual(monthRange("2026-10"), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(monthRange("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(monthRange("2028-02"), { from: "2028-02-01", to: "2028-02-29" });
});

test("stepping months wraps the year in both directions", () => {
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-06", 0), "2026-06");
  assert.equal(shiftMonth("2026-01", -13), "2024-12");
  assert.equal(shiftMonth("2026-11", 14), "2028-01");
});

test("weekdays are computed, not looked up in the server's timezone", () => {
  // Known days, Monday = 0. 21 September 2026 is a Monday.
  assert.equal(weekdayIndex("2026-09-21"), 0);
  assert.equal(weekdayIndex("2026-09-22"), 1);
  assert.equal(weekdayIndex("2026-09-27"), 6, "Sunday is the last column");
  // Across a leap day, which is where a hand-rolled congruence usually goes wrong.
  assert.equal(weekdayIndex("2028-02-29"), weekdayIndex("2028-03-01") - 1 + 0);
  // And January, which Zeller counts as month 13 of the previous year.
  assert.equal(weekdayIndex("2026-01-01"), 3, "1 January 2026 is a Thursday");
});

test("the grid starts on the right column", () => {
  // October 2026 begins on a Thursday, so three blanks come first in a Monday-first grid.
  assert.equal(leadingBlanks("2026-10"), 3);
  // A month beginning on a Monday needs none.
  assert.equal(leadingBlanks("2026-06"), 0);
});

test("a day takes the colour of the worst thing on it", () => {
  const day = [item({ state: "ok" }), item({ state: "overdue" }), item({ state: "due_soon" })];
  assert.equal(worstState(day), "overdue");
  assert.equal(worstState([item({ state: "ok" }), item({ state: "due_soon" })]), "due_soon");
  assert.equal(worstState([item({ state: "ok" })]), "ok");
  // An empty day has no colour at all, which is not the same as a quiet one.
  assert.equal(worstState([]), null);
});

test("inside a day the loudest is first", () => {
  const grouped = byDay([
    item({ item_id: "quiet", state: "ok" }),
    item({ item_id: "late", state: "overdue" }),
    item({ item_id: "soon", state: "due_soon" }),
    item({ item_id: "other-day", on_date: "2026-10-13" }),
  ]);
  assert.deepEqual(
    grouped.get("2026-10-12")?.map((i) => i.item_id),
    ["late", "soon", "quiet"],
  );
  assert.equal(grouped.get("2026-10-13")?.length, 1);
  assert.equal(grouped.get("2026-10-14"), undefined);
});

test("every day of the month is listed, in order", () => {
  const days = monthDays("2026-02");
  assert.equal(days.length, 28);
  assert.equal(days[0], "2026-02-01");
  assert.equal(days[27], "2026-02-28");
  // Zero-padded, or string comparison against the database's dates stops working.
  assert.ok(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
});

test("a month query parameter is validated before it is trusted", () => {
  assert.equal(isMonth("2026-10"), true);
  assert.equal(isMonth("2026-13"), false);
  assert.equal(isMonth("2026-00"), false);
  assert.equal(isMonth("2026-1"), false);
  assert.equal(isMonth("nonsense"), false);
  assert.equal(isMonth(null), false);
  assert.equal(isMonth(undefined), false);
});

test("each kind links to the thing a planner would act on", () => {
  assert.equal(itemHref(item({ kind: "job_card", item_id: "jc1" })), "/jobcards/jc1");
  assert.equal(itemHref(item({ kind: "work_request", item_id: "wr1" })), "/work/wr1");
  // A driver document has no machine, so it goes to the personnel screen.
  assert.equal(
    itemHref(item({ kind: "driver_document", machine_id: null, machine_name: null })),
    "/team/licences",
  );
  assert.equal(itemHref(item({ kind: "service_due", machine_id: "m9" })), "/machines/m9");
  assert.equal(itemHref(item({ kind: "licence", machine_id: null })), "/machines");
});

test("the month tiles count what is loud, not what is there", () => {
  const totals = monthTotals([
    item({ state: "overdue" }),
    item({ state: "overdue" }),
    item({ state: "due_soon" }),
    item({ state: "ok" }),
  ]);
  assert.equal(totals.overdue, 2);
  assert.equal(totals.dueSoon, 1);
  assert.equal(totals.total, 4);
});

test("every state and every kind has words in both languages", () => {
  for (const lang of ["en", "af"] as const) {
    for (const s of ["overdue", "due_soon", "ok"] as const) {
      const key = stateLook(s).labelKey;
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
    for (const k of CALENDAR_KINDS) {
      const key = `calendarKind.${k}`;
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
  }
});
