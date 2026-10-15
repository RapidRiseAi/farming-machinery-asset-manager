/**
 * Whose email it is (20261014120000): a test farm, workshop or account only reaches test
 * addresses. The database answers (public.email_recipients_allowed, tested in
 * supabase/tests/test_account_fence.sql); these cases cover what the sender does with the
 * answer, including when there is none.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { emailScopeProblem, type RecipientCheck } from "./resend";

const answer = (allowed: boolean, error?: string): RecipientCheck => async () => ({ allowed, error });

test("Rapid Rise's own mail is never checked", async () => {
  const never: RecipientCheck = async () => {
    throw new Error("checked platform mail");
  };
  assert.equal(await emailScopeProblem("platform", ["anyone@gmail.com"], never), null);
});

test("an allowed scope sends; a refused one says why", async () => {
  assert.equal(await emailScopeProblem({ farmId: "f" }, ["a@b.co"], answer(true)), null);
  assert.equal(await emailScopeProblem({ farmId: "f" }, ["a@b.co"], answer(false)), "email-test-only");
});

test("a check that cannot be made refuses rather than guessing", async () => {
  assert.match((await emailScopeProblem({ workshopId: "w" }, ["a@b.co"], answer(false, "timeout"))) ?? "", /^email-scope-check-failed: timeout/);
  const throws: RecipientCheck = async () => {
    throw new Error("network down");
  };
  assert.match((await emailScopeProblem({ userId: "u" }, ["a@b.co"], throws)) ?? "", /^email-scope-check-failed: network down/);
});

test("the copy line counts as a recipient; blanks do not", async () => {
  let seen: string[] = [];
  const record: RecipientCheck = async (_scope, recipients) => {
    seen = recipients;
    return { allowed: true };
  };
  await emailScopeProblem({ farmId: "f" }, ["to@example.com", "cc@example.com", "", null, undefined, "  "], record);
  assert.deepEqual(seen, ["to@example.com", "cc@example.com"]);
});
