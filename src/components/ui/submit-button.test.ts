/**
 * Which button spins.
 *
 * Reported from the live site: typing an email and a password on /login and pressing
 * "Sign in" started the spinner on "Email me a link" as well. `useFormStatus()` reports
 * the state of the FORM, so every SubmitButton inside one form saw the same `pending` and
 * every one of them animated. Two spinners mean two things are happening, and somebody
 * about to be asked for a card number should not have to guess which one they started.
 *
 * The rule is tested here rather than in a browser because that is where it can be pinned:
 * a regression would otherwise only show up as "it looks wrong", which is exactly how this
 * shipped in the first place.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PRESSED_FIELD, isOwnSubmission } from "./submit-button";

/** The two buttons on the login form, as React gives them ids. */
const SIGN_IN = ":r0:";
const MAGIC_LINK = ":r1:";

/** What the browser posts when a given submit button activates the form. */
function submissionFrom(buttonValue: string, fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("email", "danie@kruger.co.za");
  data.set("password", "hunter2");
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  data.set(PRESSED_FIELD, buttonValue);
  return data;
}

test("pressing Sign in spins Sign in, and nothing else", () => {
  const data = submissionFrom(SIGN_IN);
  assert.equal(isOwnSubmission(data, PRESSED_FIELD, SIGN_IN), true);
  // The bug, in one line. Before the fix this button read the form's `pending` and span
  // alongside the one that was actually pressed.
  assert.equal(isOwnSubmission(data, PRESSED_FIELD, MAGIC_LINK), false);
});

test("pressing the second way in spins only the second way in", () => {
  const data = submissionFrom(MAGIC_LINK);
  assert.equal(isOwnSubmission(data, PRESSED_FIELD, MAGIC_LINK), true);
  assert.equal(isOwnSubmission(data, PRESSED_FIELD, SIGN_IN), false);
});

test("nothing in flight means nothing spins", () => {
  // `useFormStatus().data` is null when the form is idle, and can be null for a submission
  // React could not serialise. Both mean "not me", a button that never spins is a smaller
  // failure than every button spinning.
  assert.equal(isOwnSubmission(null, PRESSED_FIELD, SIGN_IN), false);
  assert.equal(isOwnSubmission(undefined, PRESSED_FIELD, SIGN_IN), false);
});

test("a button with its own name and value is matched on those", () => {
  // Several screens give a submit button a name so the server knows which row it belongs
  // to. Those must keep working: the button identifies itself by its own pair, and the
  // generated one is never written over it.
  const data = new FormData();
  data.set("action", "approve");
  assert.equal(isOwnSubmission(data, "action", "approve"), true);
  assert.equal(isOwnSubmission(data, "action", "reject"), false);
  // And a caller's field is not confused with the generated one.
  assert.equal(isOwnSubmission(data, PRESSED_FIELD, "approve"), false);
});

test("two buttons sharing a name are told apart by their value", () => {
  // The shape a row of Approve/Reject buttons takes: one name, two values, one form.
  const data = new FormData();
  data.set("decision", "reject");
  assert.equal(isOwnSubmission(data, "decision", "reject"), true);
  assert.equal(isOwnSubmission(data, "decision", "approve"), false);
});

test("the marker field is namespaced, because it rides along in every submission", () => {
  // Every SubmitButton now posts this. It has to be something no form would use for real
  // data, and obviously internal to anybody reading a request body.
  assert.ok(PRESSED_FIELD.startsWith("__"), `${PRESSED_FIELD} does not look internal`);
});
