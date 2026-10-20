import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure } from "./action-errors";

test("our own refusals keep their words and are not reported", () => {
  assert.deepEqual(classifyFailure({ code: "P0001", message: "A meter reading cannot decrease." }), {
    report: false,
    code: "A meter reading cannot decrease.",
  });
  assert.equal(classifyFailure({ code: "23505", message: "duplicate key" }).report, false);
  assert.equal(classifyFailure({ code: "23514", message: "check" }).report, false);
});

test("anything else is ours: reported, and the person is told to try again", () => {
  assert.deepEqual(classifyFailure({ code: "08006", message: "connection failure" }), { report: true, code: "try-again" });
  assert.deepEqual(classifyFailure({ message: "fetch failed" }), { report: true, code: "try-again" });
  assert.deepEqual(classifyFailure(new Error("boom")), { report: true, code: "try-again" });
  // A refusal code without words is no use to the person.
  assert.deepEqual(classifyFailure({ code: "P0001" }), { report: true, code: "try-again" });
});

test("Auth and Storage refusals (a 4xx status) keep their words and are not reported", () => {
  assert.deepEqual(classifyFailure({ message: "Invalid login credentials", status: 400 } as never), {
    report: false,
    code: "Invalid login credentials",
  });
  assert.deepEqual(classifyFailure({ message: "upstream timeout", status: 504 } as never), { report: true, code: "try-again" });
});

test("row-level security refusals are reported and said as not allowed", () => {
  assert.deepEqual(classifyFailure({ code: "42501", message: "new row violates row-level security policy" }), {
    report: true,
    code: "forbidden",
  });
});

test("no error object: the caller's fallback code, not reported; without one, reported", () => {
  assert.deepEqual(classifyFailure(null, "work-changed"), { report: false, code: "work-changed" });
  assert.deepEqual(classifyFailure(undefined), { report: true, code: "try-again" });
});
