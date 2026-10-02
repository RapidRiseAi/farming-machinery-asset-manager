/**
 * "Add to my partners" must not offer, or file, a second copy of a suggested partner.
 * The page and `adoptSuggested` both compare these keys, so the cases a farmer would
 * call "the same contractor" are pinned here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { partnerMatchKey } from "./partner-match";

test("case and spacing in the name do not matter", () => {
  assert.equal(partnerMatchKey("TJ  Service & Repairs ", "0825550134"), partnerMatchKey("tj service & repairs", "0825550134"));
});

test("+27 and 0 forms of the same number match, whatever the spacing", () => {
  assert.equal(partnerMatchKey("TJ", "+27 82 555 0134"), partnerMatchKey("TJ", "082 555 0134"));
  assert.equal(partnerMatchKey("TJ", "27825550134"), partnerMatchKey("TJ", "082-555-0134"));
});

test("a different number or name is a different partner", () => {
  assert.notEqual(partnerMatchKey("TJ", "0825550134"), partnerMatchKey("TJ", "0825550135"));
  assert.notEqual(partnerMatchKey("TJ", "0825550134"), partnerMatchKey("AgriParts", "0825550134"));
});

test("missing phone and name do not throw", () => {
  assert.equal(partnerMatchKey(null, undefined), "|");
  assert.equal(partnerMatchKey("TJ", null), partnerMatchKey("tj", ""));
});
