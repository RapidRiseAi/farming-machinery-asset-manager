/**
 * What an error report says about a database failure (asReportable). PostgREST returns its
 * errors as plain objects, and these were all reported as "[object Object]".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { asReportable } from "./observability";

test("a PostgREST error keeps its code, not '[object Object]'", () => {
  const error = asReportable({ code: "23505", message: 'duplicate key value violates unique constraint "x"', details: "Key (email)=(a@b.c)", hint: null });
  assert.equal(error.message, "23505");
  assert.equal(error.name, "DatabaseError");
});

test("a message that can quote what the user typed is not sent", () => {
  const error = asReportable({ code: "22P02", message: 'invalid input syntax for type uuid: "someone@farm.co.za"' });
  assert.equal(error.message, "22P02");
});

test("schema errors keep their text, which names tables and columns, never rows", () => {
  assert.equal(
    asReportable({ code: "PGRST201", message: "Could not embed because more than one relationship was found" }).message,
    "PGRST201: Could not embed because more than one relationship was found",
  );
  assert.match(asReportable({ code: "42703", message: "column machines.nope does not exist" }).message, /^42703: column/);
});

test("details and hint are never part of the report", () => {
  const error = asReportable({ code: "PGRST200", message: "no relationship", details: "secret detail", hint: "secret hint" });
  assert.doesNotMatch(error.message, /secret/);
});

test("real errors pass through, anything else is stringified", () => {
  const real = new Error("boom");
  assert.equal(asReportable(real), real);
  assert.equal(asReportable("plain words").message, "plain words");
  assert.equal(asReportable({ message: "no code here" }).message, "no code");
});

test("a database that could not be reached says how, in the library's own words", () => {
  const timeout = asReportable({ code: "", message: "AbortError: This operation was aborted", details: "AbortError: ...", hint: "Request was aborted (timeout or manual cancellation). Note: Your request URL is 9000 characters" });
  assert.equal(timeout.message, "no code: AbortError: This operation was aborted (Request was aborted (timeout or manual cancellation))");
  assert.equal(timeout.name, "DatabaseUnreachable");
  assert.equal(asReportable({ code: "", message: "TypeError: fetch failed", hint: "" }).message, "no code: TypeError: fetch failed");
});

test("a codeless message that is not the library's fetch text is still not sent", () => {
  assert.equal(asReportable({ code: "", message: "someone@farm.co.za said hello" }).message, "no code");
});
