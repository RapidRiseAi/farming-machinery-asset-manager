import "server-only";

import { emailConfigured, sendEmail } from "@/lib/email/resend";

/**
 * Email the founder when a scheduled run finishes with a failed step.
 *
 * Every failed step is already sent to error tracking (`captureError`), but until a Sentry
 * project exists that reaches nobody, and a billing or reminder run that half-failed is the
 * one thing that must not wait to be noticed. Sent to OPS_ALERT_EMAIL, or AI_ALERT_EMAIL
 * when that is the only one set, so one address covers both. Only the failed steps' own
 * words go in it: step names and counts, never a person or a row.
 *
 * A run that never starts sends nothing from here; `/api/health` is what catches that.
 * Never throws: an alert must not turn a finished run into a failed one.
 */
export async function alertCronFailure(route: string, steps: Record<string, string>): Promise<boolean> {
  const to = (process.env.OPS_ALERT_EMAIL || process.env.AI_ALERT_EMAIL || "").trim();
  const failed = Object.entries(steps).filter(([, outcome]) => outcome.startsWith("error"));
  if (!to || failed.length === 0 || !emailConfigured()) return false;
  const lines = [
    `FleetWise ${route} finished with ${failed.length} failed step${failed.length === 1 ? "" : "s"}:`,
    "",
    ...failed.map(([step, outcome]) => `${step}: ${outcome}`),
    "",
    "The rest of the run completed. Each step is retried on the next run; see /admin/billing for the run history.",
  ];
  const text = lines.join("\n");
  try {
    const sent = await sendEmail({
      to,
      from: process.env.EMAIL_FROM || "documents@fleetwise.app",
      subject: `FleetWise: ${route} had ${failed.length} failed step${failed.length === 1 ? "" : "s"}`,
      text,
      html: `<pre>${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c)}</pre>`,
    });
    return sent.ok;
  } catch {
    return false;
  }
}
