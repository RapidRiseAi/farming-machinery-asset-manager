/**
 * Can anybody hear about a problem? The error reporter, the alert email and the email
 * sender are each wired, but each does nothing without its setting, and none of them can
 * say so where anyone would see it: an unset error tracker drops every report silently,
 * and an unset alert address turns a failed nightly run into one line in a log nobody
 * reads. The launch tracker carried "were these set?" as an open question for a week
 * because nothing in production would answer it.
 *
 * WARNINGS on /api/health, not failures: the product works without them; the people who
 * fix it just never find out. Short codes, never a value or a variable's contents, like
 * `siteUrlWarning`: the endpoint is public.
 */
export function deliveryWarnings(setup: {
  /** `observabilityEnabled()`: an error tracker is configured and parses. */
  errorReports: boolean;
  /** Where operational alerts go (OPS_ALERT_EMAIL, or AI_ALERT_EMAIL as the fallback). */
  alertEmail: string | undefined;
  /** `emailConfigProblem()`: null when email can be sent. */
  emailProblem: string | null;
  /**
   * PAYSTACK_SECRET_KEY. Only its prefix is read: a test key in production means every
   * "payment" is pretend, and the account being approved for live mode does not show which
   * key the deployment actually holds.
   */
  paymentKey?: string;
}): string[] {
  const out: string[] = [];
  if (!setup.errorReports) out.push("error_reports_off");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((setup.alertEmail ?? "").trim())) out.push("alert_email_unset");
  if (setup.emailProblem) out.push("email_not_configured");
  const key = (setup.paymentKey ?? "").trim();
  if (!key) out.push("payments_unset");
  else if (key.startsWith("sk_test_")) out.push("payments_test_mode");
  return out;
}
