import assert from "node:assert/strict";
import test from "node:test";
import { deliveryWarnings } from "./delivery-health";

test("a fully set up deployment raises no delivery warning", () => {
  assert.deepEqual(
    deliveryWarnings({ errorReports: true, alertEmail: "ops@example.com", emailProblem: null, paymentKey: "sk_live_abc" }),
    [],
  );
});

test("each missing piece is named by its code, never by its value", () => {
  assert.deepEqual(deliveryWarnings({ errorReports: false, alertEmail: "", emailProblem: "RESEND_API_KEY is not set", paymentKey: "sk_live_abc" }), [
    "error_reports_off",
    "alert_email_unset",
    "email_not_configured",
  ]);
  // A placeholder or a stray word is not an address anyone receives.
  assert.deepEqual(deliveryWarnings({ errorReports: true, alertEmail: "[SENSITIVE]", emailProblem: null, paymentKey: "sk_live_abc" }), ["alert_email_unset"]);
  assert.deepEqual(deliveryWarnings({ errorReports: true, alertEmail: undefined, emailProblem: null, paymentKey: "sk_live_abc" }), ["alert_email_unset"]);
  const shown = deliveryWarnings({ errorReports: false, alertEmail: "x", emailProblem: "EMAIL_FROM is a placeholder", paymentKey: "sk_live_abc" }).join(" ");
  assert.ok(!shown.includes("EMAIL_FROM") && !shown.includes("placeholder"));
});

test("payments: a missing key and a test key are both named, a live key is not", () => {
  const base = { errorReports: true, alertEmail: "ops@example.com", emailProblem: null };
  assert.deepEqual(deliveryWarnings({ ...base }), ["payments_unset"]);
  assert.deepEqual(deliveryWarnings({ ...base, paymentKey: "sk_test_123" }), ["payments_test_mode"]);
  assert.deepEqual(deliveryWarnings({ ...base, paymentKey: " sk_live_123 " }), []);
  assert.ok(!deliveryWarnings({ ...base, paymentKey: "sk_test_SECRETVALUE" }).join(" ").includes("SECRETVALUE"));
});
