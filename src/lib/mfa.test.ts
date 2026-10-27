import assert from "node:assert/strict";
import test from "node:test";
import { assuranceFrom, cleanCode, mfaGate, rapidRiseLockPath, rapidRiseVerdict } from "./mfa";

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

// == A Rapid Rise account this session may not act as (20261014120000) ================
test("a test account with a Rapid Rise role goes to the test-account page, code or no code", () => {
  for (const current of ["aal1", "aal2", null] as const) {
    assert.equal(rapidRiseLockPath(true, { current, next: "aal2" }, "/admin/farms"), "/test-account");
  }
});

test("a real admin without the code goes to the step it still owes, and comes back", () => {
  assert.equal(rapidRiseLockPath(false, { current: "aal1", next: "aal1" }, "/admin/ai"), "/mfa/setup?next=%2Fadmin%2Fai");
  assert.equal(rapidRiseLockPath(false, { current: "aal1", next: "aal2" }, "/admin/billing?farm=x"), "/mfa/verify?next=%2Fadmin%2Fbilling%3Ffarm%3Dx");
});

test("a real admin refused after giving the code is sent to sign-in, never let through", () => {
  assert.equal(rapidRiseLockPath(false, { current: "aal2", next: "aal2" }, "/admin/farms"), "/login?error=mfa-required");
});

// == The profile loader's decision (20261014120000) =================================
test("only a Rapid Rise account the database refused is ever held back", () => {
  for (const role of ["owner", "manager", "mechanic", "operator", "workshop"]) {
    assert.equal(rapidRiseVerdict(role, true, false), "allow", role);
    assert.equal(rapidRiseVerdict(role, false, false), "allow", role);
  }
  assert.equal(rapidRiseVerdict("rr_admin", true, true), "allow");
});

test("a refused Rapid Rise session is sent on if active, withheld quietly if not", () => {
  assert.equal(rapidRiseVerdict("rr_admin", true, false), "lock");
  assert.equal(rapidRiseVerdict("rr_admin", false, false), "withhold");
  // A deactivated account the database still answers yes for is the database's call: the
  // loader's other checks (requireProfile refuses inactive profiles) still apply.
  assert.equal(rapidRiseVerdict("rr_admin", false, true), "allow");
});

/** A token with the given claims; the signature is not part of what is read. */
const token = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

test("assurance comes from the token and the user Auth confirmed", () => {
  assert.deepEqual(assuranceFrom(token({ aal: "aal1" }), { factors: [{ status: "verified" }] }), { current: "aal1", next: "aal2" });
  assert.deepEqual(assuranceFrom(token({ aal: "aal2" }), { factors: [{ status: "verified" }] }), { current: "aal2", next: "aal2" });
  assert.deepEqual(assuranceFrom(token({ aal: "aal1" }), { factors: [] }), { current: "aal1", next: "aal1" });
});

test("an unverified factor does not make the code step reachable", () => {
  assert.deepEqual(assuranceFrom(token({ aal: "aal1" }), { factors: [{ status: "unverified" }] }), { current: "aal1", next: "aal1" });
});

test("an unreadable token is unknown, which never locks anyone out on its own", () => {
  assert.deepEqual(assuranceFrom("not-a-token", { factors: [] }), { current: null, next: null });
  assert.deepEqual(assuranceFrom(undefined, null), { current: null, next: null });
  assert.equal(mfaGate("owner", assuranceFrom("x.y.z", null)), null);
});
