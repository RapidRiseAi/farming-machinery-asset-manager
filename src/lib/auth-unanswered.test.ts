/**
 * Signed out, or Auth did not answer (authUnanswered). Only the second keeps a signed-in
 * person off the sign-in page during an outage, so the line between them is tested with
 * the shapes @supabase/auth-js actually returns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { authUnanswered } from "./auth-unanswered";

test("no session or a refused token means signed out", () => {
  assert.equal(authUnanswered(null), false);
  assert.equal(authUnanswered(undefined), false);
  assert.equal(authUnanswered({ name: "AuthSessionMissingError", status: 400 }), false);
  assert.equal(authUnanswered({ name: "AuthApiError", status: 401 }), false);
  assert.equal(authUnanswered({ name: "AuthApiError", status: 403 }), false);
  assert.equal(authUnanswered({ name: "AuthApiError", status: 400 }), false);
});

test("Auth unreachable, failing, or answering nothing readable is not signed out", () => {
  assert.equal(authUnanswered({ name: "AuthRetryableFetchError", status: 0 }), true);
  assert.equal(authUnanswered({ name: "AuthRetryableFetchError", status: 503 }), true);
  assert.equal(authUnanswered({ name: "AuthApiError", status: 500 }), true);
  assert.equal(authUnanswered({ name: "AuthUnknownError" }), true);
});
