import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SUPPORT_CALENDAR,
  calendarFrom,
  dueState,
  isCustomerKind,
  isWeekdays,
  nextDue,
  supportDueAt,
  type SupportCalendar,
} from "./sla";

// The SA public holidays the migration seeds that these cases cross (20261028100300).
const SA: SupportCalendar = {
  ...DEFAULT_SUPPORT_CALENDAR,
  holidays: new Set([
    "2026-04-03", "2026-04-06", "2026-08-09", "2026-08-10", "2026-12-16", "2026-12-25",
    "2026-12-26", "2027-12-25", "2027-12-26", "2027-12-27",
  ]),
};

/** A SAST wall-clock time as an instant (SAST is UTC+2 all year). */
const sast = (s: string) => new Date(`${s.replace(" ", "T")}:00+02:00`);
/** An instant as a SAST wall-clock "YYYY-MM-DD HH:MM". */
const show = (d: Date) => new Date(d.getTime() + 2 * 3600_000).toISOString().slice(0, 16).replace("T", " ");

// The same cases as supabase/tests/support_desk.sql (a), so SQL and TypeScript agree.
const CASES: Array<[string, string, string]> = [
  ["2026-10-30 10:00", "2026-10-30 17:00", "Friday morning: 17:00 the same day"],
  ["2026-10-30 09:00", "2026-10-30 17:00", "exactly opening: the same day"],
  ["2026-10-30 15:59", "2026-10-30 17:00", "just before the cutoff: the same day"],
  ["2026-10-30 16:00", "2026-11-02 12:00", "the cutoff itself: Monday noon"],
  ["2026-10-30 16:30", "2026-11-02 12:00", "Friday after the cutoff: Monday noon"],
  ["2026-10-31 11:00", "2026-11-02 12:00", "Saturday: Monday noon"],
  ["2026-11-01 23:30", "2026-11-02 12:00", "Sunday night: Monday noon"],
  ["2026-11-02 08:00", "2026-11-02 12:00", "Monday before opening: noon that day"],
  ["2026-11-02 01:00", "2026-11-02 12:00", "Monday 01:00 SAST is still Sunday in UTC"],
  ["2026-12-16 10:00", "2026-12-17 12:00", "Day of Reconciliation: the next day noon"],
  ["2026-12-24 16:30", "2026-12-28 12:00", "Christmas Eve late"],
  ["2026-04-02 16:01", "2026-04-07 12:00", "before Easter"],
  ["2026-08-07 17:30", "2026-08-11 12:00", "Women's Day on a Sunday, Monday observed"],
  ["2027-12-24 12:00", "2027-12-24 17:00", "Christmas Eve 2027 is a working Friday"],
  ["2027-12-24 16:15", "2027-12-28 12:00", "2027 Christmas weekend and the Monday observed"],
];

test("answer-by times follow the support hours, weekends and public holidays", () => {
  for (const [received, due, why] of CASES) {
    assert.equal(show(supportDueAt(sast(received), SA)), due, why);
  }
});

test("the calendar is data: a later cutoff and a declared holiday change the answer", () => {
  const later = { ...SA, sameDayCutoff: "16:30" };
  assert.equal(show(supportDueAt(sast("2026-10-30 16:15"), later)), "2026-10-30 17:00");
  const declared = { ...SA, holidays: new Set([...SA.holidays, "2026-11-03"]) };
  assert.equal(show(supportDueAt(sast("2026-11-02 16:45"), declared)), "2026-11-04 12:00");
});

test("a calendar with every day closed still answers", () => {
  const closed = { ...SA, workingDays: [] as number[] };
  assert.ok(supportDueAt(sast("2026-10-30 10:00"), closed) instanceof Date);
});

test("calendarFrom reads the settings row and falls back to the defaults", () => {
  const cal = calendarFrom({ timezone: "Africa/Johannesburg", opens_at: "08:00", closes_at: "16:00", same_day_cutoff: "15:00", next_day_due: "11:00", working_days: [1, 2, 3, 4, 5, 6] }, ["2026-12-25"]);
  assert.equal(cal.opensAt, "08:00");
  assert.deepEqual([...cal.workingDays], [1, 2, 3, 4, 5, 6]);
  assert.ok(cal.holidays.has("2026-12-25"));
  assert.equal(show(supportDueAt(sast("2026-10-31 10:00"), cal)), "2026-10-31 16:00", "Saturday is a working day here");
  const fallback = calendarFrom(null);
  assert.equal(fallback.sameDayCutoff, "16:00");
  assert.deepEqual([...fallback.workingDays], [1, 2, 3, 4, 5]);
});

const base = {
  kind: "help_request",
  status: "open",
  due_at: "2026-10-30T15:00:00Z",
  first_response_due_at: "2026-10-30T15:00:00Z",
  first_response_at: null,
  last_customer_at: "2026-10-30T08:00:00Z",
  last_staff_at: null,
};

test("what is due: the first answer, then only an unanswered customer reply", () => {
  assert.equal(nextDue(base), base.first_response_due_at, "before the first answer");
  const answered = { ...base, first_response_at: "2026-10-30T09:00:00Z", last_staff_at: "2026-10-30T09:00:00Z" };
  assert.equal(nextDue(answered), null, "answered, nothing new from the customer");
  const replied = { ...answered, last_customer_at: "2026-10-30T10:00:00Z", due_at: "2026-10-30T15:00:00Z" };
  assert.equal(nextDue(replied), replied.due_at, "the customer wrote again");
  assert.equal(nextDue({ ...base, status: "waiting" }), null, "waiting on the customer");
  assert.equal(nextDue({ ...base, status: "resolved" }), null, "resolved");
  assert.equal(nextDue({ ...base, kind: "dispute", status: "waiting", first_response_at: "x" }), base.due_at, "a dispute keeps its clock");
});

test("due states read in South African time", () => {
  const now = sast("2026-10-30 10:00");
  assert.equal(dueState(null, now), "none");
  assert.equal(dueState(sast("2026-10-30 09:59").toISOString(), now), "overdue");
  assert.equal(dueState(sast("2026-10-30 23:30").toISOString(), now), "today");
  // 00:30 SAST on Saturday is still Friday in UTC: it is NOT today.
  assert.equal(dueState(sast("2026-10-31 00:30").toISOString(), now), "later");
});

test("customer kinds and weekday wording", () => {
  assert.ok(isCustomerKind("privacy_request"));
  assert.ok(!isCustomerKind("dispute"));
  assert.ok(isWeekdays([5, 4, 3, 2, 1]));
  assert.ok(!isWeekdays([1, 2, 3, 4, 5, 6]));
});
