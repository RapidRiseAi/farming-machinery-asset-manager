/**
 * The address bar forgets what an action reported, and remembers everything else.
 *
 * `ClearResultParams` runs this against `window.location.href` after a Flash is on screen.
 * Getting it wrong in one direction replays "Saved" on every refresh; in the other it
 * drops a filter or a step the page needs, which is worse, so both are pinned here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { RESULT_PARAMS, minusKept, withoutResultParams } from "./result-params";

const ORIGIN = "https://app.example.test";

test("drops the result key and nothing else", () => {
  assert.equal(withoutResultParams(`${ORIGIN}/documents?saved=1`), "/documents");
  assert.equal(
    withoutResultParams(`${ORIGIN}/machines?type=tractor&saved=1&q=john`),
    "/machines?type=tractor&q=john",
  );
});

test("drops several result keys at once, and an error with its text", () => {
  assert.equal(
    withoutResultParams(`${ORIGIN}/banking?imported=4&seen=6&status=open`),
    "/banking?status=open",
  );
  assert.equal(withoutResultParams(`${ORIGIN}/fuel?error=too%20high`), "/fuel");
});

test("returns null when there is nothing to clear, so no history call is made", () => {
  assert.equal(withoutResultParams(`${ORIGIN}/machines`), null);
  assert.equal(withoutResultParams(`${ORIGIN}/machines?type=tractor`), null);
});

test("keeps the state keys that look like outcomes but are not", () => {
  // /machines?retired=1 is a filter, /billing?checkout= and ?change= are steps.
  assert.equal(withoutResultParams(`${ORIGIN}/machines?retired=1`), null);
  assert.equal(withoutResultParams(`${ORIGIN}/billing?checkout=paid&change=plan&saved=x`), "/billing?checkout=paid&change=plan");
  for (const state of ["status", "q", "from", "to", "type", "sort", "page", "open", "edit", "retired", "checkout", "change", "reset", "resume", "email", "next"]) {
    assert.ok(!RESULT_PARAMS.includes(state), `${state} is page state and must never be cleared`);
  }
});

test("keeps the hash", () => {
  assert.equal(withoutResultParams(`${ORIGIN}/settings?saved=1#billing`), "/settings#billing");
});

test("keeps capture acknowledgements so job-card drafts clear only after their save", () => {
  assert.equal(
    withoutResultParams(`${ORIGIN}/jobcards/job-1?saved=1&intake_token=intake-1&line_token=line-1&kit_token=kit-1`),
    "/jobcards/job-1?intake_token=intake-1&line_token=line-1&kit_token=kit-1",
  );
});

test("honours an explicit key list", () => {
  assert.equal(withoutResultParams(`${ORIGIN}/billing?saved=slots-added&error=x`, ["saved"]), "/billing?error=x");
  assert.equal(withoutResultParams(`${ORIGIN}/billing?saved=1`, []), null);
});

test("a KeepResultParams marker protects its keys from every Flash", () => {
  // /billing: the card-expiry Flash renders on every visit, and must not clear the
  // sticky "do not pay again" `saved` notice.
  const keys = minusKept(RESULT_PARAMS, ["saved", null, "  "]);
  assert.ok(!keys.includes("saved"));
  assert.ok(keys.includes("error"));
  assert.equal(withoutResultParams(`${ORIGIN}/billing?saved=pending&error=x`, keys), "/billing?saved=pending");
  assert.deepEqual(minusKept(["saved", "error"], ["error saved"]), []);
});

test("a malformed address is left alone", () => {
  assert.equal(withoutResultParams("not a url"), null);
});
