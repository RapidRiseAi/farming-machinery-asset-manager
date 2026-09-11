import assert from "node:assert/strict";
import test from "node:test";

import { bearerMatches } from "./bearer";

/**
 * The cron routes run the entire billing pass and are reachable from the public internet,
 * so the thing guarding them is worth asserting rather than assuming.
 *
 * These test BEHAVIOUR, not timing. Measuring constant-time-ness in a unit test is a
 * well-known way to produce a flaky suite — a GC pause dwarfs the difference — so the
 * guarantee here comes from `timingSafeEqual` and from hashing both sides to a fixed
 * width. What is tested is that it says yes and no in the right places, including the
 * cases where a naive implementation says yes by accident.
 */

test("the exact token is accepted", () => {
  assert.equal(bearerMatches("Bearer s3cret-value", "s3cret-value"), true);
});

test("a wrong token is refused", () => {
  assert.equal(bearerMatches("Bearer wrong", "s3cret-value"), false);
});

test("a token that is a PREFIX of the secret is refused", () => {
  // The case a length check alone would get right and a naive `startsWith` would not.
  assert.equal(bearerMatches("Bearer s3cret", "s3cret-value"), false);
});

test("a token the secret is a prefix OF is refused", () => {
  assert.equal(bearerMatches("Bearer s3cret-value-and-more", "s3cret-value"), false);
});

test("the scheme must be there, and spelled right", () => {
  assert.equal(bearerMatches("s3cret-value", "s3cret-value"), false);
  assert.equal(bearerMatches("bearer s3cret-value", "s3cret-value"), false);
  assert.equal(bearerMatches("Basic s3cret-value", "s3cret-value"), false);
  assert.equal(bearerMatches("Bearer  s3cret-value", "s3cret-value"), false);
});

test("no secret configured refuses everything, including an empty header", () => {
  // The fail-closed direction. A deployment that forgot CRON_SECRET must not be open to
  // anybody who sends nothing, which is exactly what `undefined === undefined` would do.
  assert.equal(bearerMatches("Bearer anything", undefined), false);
  assert.equal(bearerMatches("Bearer anything", ""), false);
  assert.equal(bearerMatches(null, undefined), false);
  assert.equal(bearerMatches(null, "s3cret-value"), false);
  assert.equal(bearerMatches("", ""), false);
  assert.equal(bearerMatches("Bearer ", ""), false);
});

test("it does not throw on inputs of wildly different lengths", () => {
  // `timingSafeEqual` throws when the buffers differ in length, which is why both sides
  // are hashed first. A throw here would be a 500 rather than a 401 — and a 500 on a
  // guard is its own kind of information.
  assert.equal(bearerMatches("Bearer " + "x".repeat(10_000), "s"), false);
  assert.equal(bearerMatches("B", "s".repeat(10_000)), false);
});

test("unicode and bytes are compared, not code points", () => {
  assert.equal(bearerMatches("Bearer schlüssel", "schlüssel"), true);
  assert.equal(bearerMatches("Bearer schlussel", "schlüssel"), false);
});
