import { test } from "node:test";
import assert from "node:assert/strict";

import { CLOSURE_TOKEN, exportIsFresh, hashClosureToken, newClosureToken, sameBusinessName } from "./farm-closure";

test("a confirmation link is unguessable, and stored only as a hash", () => {
  const { token, tokenHash } = newClosureToken();
  assert.match(token, CLOSURE_TOKEN);
  assert.equal(hashClosureToken(token), tokenHash);
  assert.notEqual(token, tokenHash);
  assert.notEqual(newClosureToken().token, token);
});

test("an export has to be recent", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  assert.equal(exportIsFresh("2026-11-07T01:00:00Z", now), true);
  assert.equal(exportIsFresh("2026-11-06T11:59:00Z", now), false);
  assert.equal(exportIsFresh(null, now), false);
  assert.equal(exportIsFresh("2026-11-08T01:00:00Z", now), false);
});

test("typing the name is forgiving about spacing and capitals, and nothing else", () => {
  assert.equal(sameBusinessName("  TJ   service ", "TJ Service"), true);
  assert.equal(sameBusinessName("TJ Services", "TJ Service"), false);
  assert.equal(sameBusinessName("", ""), false);
  assert.equal(sameBusinessName("   ", "   "), false);
});
