import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTimeline,
  filterTimeline,
  groupByMonth,
  readTimelineFilter,
  timelineCounts,
  type TimelineEvent,
} from "./machine-timeline";

const ev = (date: string, kind: TimelineEvent["kind"], title: string = kind): TimelineEvent => ({ date, kind, title, sub: "" });
const many = (n: number) => `changed ${n} times`;

test("newest first, and the purchase stays below everything else on its own day", () => {
  const out = buildTimeline(
    [ev("2026-03-01", "fault"), ev("2026-05-10", "jobcard"), ev("2026-03-01", "checklist"), ev("2026-03-01", "origin")],
    many,
  );
  assert.deepEqual(out.map((e) => e.kind), ["jobcard", "fault", "checklist", "origin"]);
});

test("neighbouring record edits on one day fold into one row; other days and kinds do not", () => {
  const out = buildTimeline(
    [ev("2026-04-02", "audit"), ev("2026-04-02", "audit"), ev("2026-04-02", "audit"), ev("2026-04-01", "audit"), ev("2026-04-02", "fault")],
    many,
  );
  assert.deepEqual(out.map((e) => [e.date, e.kind, e.count ?? 1]), [
    ["2026-04-02", "audit", 3],
    ["2026-04-02", "fault", 1],
    ["2026-04-01", "audit", 1],
  ]);
  assert.equal(out[0].title, "changed 3 times");
});

test("folding never changes the caller's events", () => {
  const input = [ev("2026-04-02", "audit", "edited"), ev("2026-04-02", "audit", "edited")];
  buildTimeline(input, many);
  assert.deepEqual(input.map((e) => [e.title, e.count]), [["edited", undefined], ["edited", undefined]]);
});

test("a chip shows its kinds only, and the purchase only under All", () => {
  const all = [ev("2026-05-01", "fault"), ev("2026-04-01", "watch"), ev("2026-03-01", "jobcard"), ev("2020-01-01", "origin")];
  assert.deepEqual(filterTimeline(all, "problems").map((e) => e.kind), ["fault", "watch"]);
  assert.deepEqual(filterTimeline(all, "service").map((e) => e.kind), ["jobcard"]);
  assert.equal(filterTimeline(all, "all").length, 4);
  assert.deepEqual(timelineCounts(all), { all: 4, problems: 2, service: 1, checks: 0, work: 0, changes: 0 });
});

test("an unknown or hostile ?tl= is All", () => {
  assert.equal(readTimelineFilter("problems"), "problems");
  assert.equal(readTimelineFilter(undefined), "all");
  assert.equal(readTimelineFilter("toString"), "all");
  assert.equal(readTimelineFilter("__proto__"), "all");
  assert.equal(readTimelineFilter("PROBLEMS"), "all");
});

test("months group consecutive rows, newest first", () => {
  const groups = groupByMonth(buildTimeline(
    [ev("2026-05-30", "fault"), ev("2026-05-01", "jobcard"), ev("2026-04-30", "checklist"), ev("2025-05-15", "origin")],
    many,
  ));
  assert.deepEqual(groups.map((g) => [g.month, g.events.length]), [["2026-05", 2], ["2026-04", 1], ["2025-05", 1]]);
});
