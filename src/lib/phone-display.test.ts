import test from "node:test";
import assert from "node:assert/strict";

import { formatPhone } from "./phone-display";

test("groups a South African number in international form", () => {
  assert.equal(formatPhone("+27825550134"), "+27 82 555 0134");
  assert.equal(formatPhone("27825550134"), "+27 82 555 0134");
  assert.equal(formatPhone("0027825550134"), "+27 82 555 0134");
  assert.equal(formatPhone("+27 (82) 555-0134"), "+27 82 555 0134");
});

test("groups a South African number in local form", () => {
  assert.equal(formatPhone("0825550134"), "082 555 0134");
  assert.equal(formatPhone("082-555-0134"), "082 555 0134");
  assert.equal(formatPhone("021 555 0134"), "021 555 0134");
});

test("leaves anything it does not recognise as typed", () => {
  assert.equal(formatPhone("+44 20 7946 0958"), "+44 20 7946 0958");
  assert.equal(formatPhone("  ext 12 "), "ext 12");
  assert.equal(formatPhone("08255501"), "08255501");
});

test("empty in, empty out", () => {
  assert.equal(formatPhone(null), "");
  assert.equal(formatPhone(undefined), "");
  assert.equal(formatPhone("   "), "");
});
