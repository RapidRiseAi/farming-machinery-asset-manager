import assert from "node:assert/strict";
import test from "node:test";
import { cleanCode, mfaGate } from "./mfa";

test("a verified session carries on, whoever it is", () => {
  assert.equal(mfaGate("rr_admin", { current: "aal2", next: "aal2" }), null);
  assert.equal(mfaGate("owner", { current: "aal2", next: "aal2" }), null);
});

test("anyone with a code set up gives it before the app", () => {
  assert.equal(mfaGate("owner", { current: "aal1", next: "aal2" }), "verify");
  assert.equal(mfaGate("operator", { current: "aal1", next: "aal2" }), "verify");
  assert.equal(mfaGate("rr_admin", { current: "aal1", next: "aal2" }), "verify");
});

test("Rapid Rise staff without a code set one up; everyone else may skip it", () => {
  assert.equal(mfaGate("rr_admin", { current: "aal1", next: "aal1" }), "setup");
  assert.equal(mfaGate("owner", { current: "aal1", next: "aal1" }), null);
  assert.equal(mfaGate("workshop", { current: "aal1", next: "aal1" }), null);
});

test("an unreadable assurance does not lock anyone out by itself", () => {
  assert.equal(mfaGate("rr_admin", { current: null, next: null }), null);
});

test("codes are six digits, however the app spaced them", () => {
  assert.equal(cleanCode("123 456"), "123456");
  assert.equal(cleanCode("123-456"), "123456");
  assert.equal(cleanCode(" 123456 "), "123456");
  assert.equal(cleanCode("12345"), null);
  assert.equal(cleanCode("12345a"), null);
  assert.equal(cleanCode("1234567"), null);
});
