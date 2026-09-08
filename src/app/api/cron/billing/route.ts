import { NextResponse } from "next/server";

import { sendDueFailureNotices, sendDueReceipts } from "@/lib/billing/receipt";
import { BILLING_RPC } from "@/lib/billing/service";
import { reconcileStuckAttempts, runBillingCharges } from "@/lib/billing/worker";
import { captureError } from "@/lib/observability";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * The billing cron. SEPARATE from `/api/cron/nightly`, on purpose.
 *
 * The nightly route runs fifteen maintenance engines whose worst failure is a reminder
 * nobody received. This one moves money. Keeping them apart means:
 *
 *  - billing can be scheduled at its own hour, paused, or re-run on its own without
 *    re-running every notification engine in the product;
 *  - a failure in either is legible on its own — "billing failed" and "the digest failed"
 *    are different sentences to be woken up by;
 *  - and, the one that matters most, nobody can accidentally make a payment run happen by
 *    poking the nightly maintenance job.
 *
 * ── Order, and why ────────────────────────────────────────────────────────────
 *  1. reconcile stuck attempts  — an `unknown` BLOCKS its invoice, so clearing last
 *                                 night's ambiguity first is what lets tonight charge it.
 *                                 Runs whether or not charging is enabled.
 *  2. capture asset snapshots   — what each farm is billed FOR, recorded before it is
 *                                 billed, so an invoice can always be explained.
 *  3. generate invoices         — raises nothing while `billing_price_versions` is empty,
 *                                 which is the state the product ships in.
 *  4. run charges               — claim → charge → settle, and nothing at all when the
 *                                 kill switch is off.
 *  5. apply downgrades          — grace expired: reduce the EFFECTIVE plan, delete nothing.
 *  6. close cancellations       — period-end cancellations that have reached their end.
 *  7. enqueue reminders         — tell the farm, after every state above has settled, so a
 *                                 farmer is never told they are past due minutes before a
 *                                 successful charge in the same pass clears it.
 *
 * ── Re-running is safe ────────────────────────────────────────────────────────
 * Every step is idempotent by construction rather than by a guard in this file: invoice
 * generation is keyed on the period, claiming is keyed on the in-flight unique index,
 * reminders dedupe from the notification queue itself, and closing a cancellation is a
 * conditional update. A double-fired schedule, a manual re-run and a retry all land in
 * the same place.
 *
 * A failed step is reported and the pass CONTINUES — the same rule the nightly route
 * settled on. Step 4 failing must not stop 5, 6 and 7, because a partial pass is worth far
 * more than none.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const steps: Record<string, string> = {};

  const run = async (name: string, fn: string): Promise<void> => {
    const { error } = await supabase.rpc(fn);
    steps[name] = error ? `error: ${error.message}` : "ok";
    if (error) {
      // Into the observability layer, not just into this response body — which goes back
      // to Vercel's scheduler and is read by nobody. A billing engine that quietly stopped
      // working is the failure with the longest half-life in this product.
      captureError(new Error(error.message), { where: `cron:billing:${name}`, extra: { rpc: fn } });
    }
  };

  // 1 ── Reconcile before charging. Runs with the kill switch off: verifying a payment
  // already taken is not a new charge, and turning charging off must never strand money.
  try {
    const reconciled = await reconcileStuckAttempts(supabase);
    steps["reconcile"] = reconciled.skipped
      ? `skipped (${reconciled.skipped})`
      : `ok (checked ${reconciled.checked}, resolved ${reconciled.resolved}, still open ${reconciled.stillOpen})`;
    for (const message of reconciled.errors) {
      captureError(new Error(message), { where: "cron:billing:reconcile" });
    }
  } catch (err) {
    steps["reconcile"] = `error: ${err instanceof Error ? err.message : "unknown"}`;
    captureError(err, { where: "cron:billing:reconcile" });
  }

  // 2 ── What each farm is billed for, recorded before it is billed.
  await run("asset_snapshots", BILLING_RPC.captureSnapshots);

  // 3 ── Raise the period's invoices. Nothing happens with no active price version.
  await run("generate_invoices", BILLING_RPC.cronGenerateInvoices);

  // 4 ── The charges themselves.
  try {
    const charges = await runBillingCharges(supabase);
    steps["charges"] = charges.skipped
      ? `skipped (${charges.skipped})`
      : `ok (considered ${charges.considered}, succeeded ${charges.succeeded}, ` +
        `failed ${charges.failed}, unknown ${charges.unknown}, passed ${charges.passed})`;
    for (const message of charges.errors) {
      captureError(new Error(message), { where: "cron:billing:charges" });
    }
  } catch (err) {
    steps["charges"] = `error: ${err instanceof Error ? err.message : "unknown"}`;
    captureError(err, { where: "cron:billing:charges" });
  }

  // 5 ── Grace has run out for somebody. Reduce the effective plan; delete nothing.
  await run("apply_downgrades", BILLING_RPC.applyDowngrades);

  // 6 ── Cancellations that have reached their period end.
  await run("close_cancellations", BILLING_RPC.closeCancellations);

  // 7 ── Tell the farm, last, once every state above has settled.
  await run("reminders", BILLING_RPC.enqueueReminders);

  // 8 ── Email what step 7 could only put in the app.
  //
  // Both are SAFETY NETS as much as senders. The receipt is normally emailed the moment
  // the webhook lands; this pass catches the ones where that request died, where the
  // mailbox was full, or where email was not configured at the time. Both claim before
  // sending, so running this twice sends nothing twice.
  try {
    const receipts = await sendDueReceipts(supabase);
    steps["receipts"] =
      receipts.skipped && !receipts.considered
        ? `skipped (${receipts.reasons[0] ?? "nothing due"})`
        : `ok (considered ${receipts.considered}, sent ${receipts.sent}, ` +
          `skipped ${receipts.skipped}, failed ${receipts.failed})`;
    for (const message of receipts.reasons.slice(0, 5)) {
      if (receipts.failed) captureError(new Error(message), { where: "cron:billing:receipts" });
    }
  } catch (err) {
    steps["receipts"] = `error: ${err instanceof Error ? err.message : "unknown"}`;
    captureError(err, { where: "cron:billing:receipts" });
  }

  try {
    const notices = await sendDueFailureNotices(supabase);
    steps["failure_notices"] =
      notices.skipped && !notices.considered
        ? `skipped (${notices.reasons[0] ?? "nothing due"})`
        : `ok (considered ${notices.considered}, sent ${notices.sent}, ` +
          `skipped ${notices.skipped}, failed ${notices.failed})`;
    for (const message of notices.reasons.slice(0, 5)) {
      if (notices.failed) captureError(new Error(message), { where: "cron:billing:notices" });
    }
  } catch (err) {
    steps["failure_notices"] = `error: ${err instanceof Error ? err.message : "unknown"}`;
    captureError(err, { where: "cron:billing:notices" });
  }

  const ok = Object.values(steps).every((s) => s.startsWith("ok") || s.startsWith("skipped"));
  return NextResponse.json(
    { ok, ranAt: new Date().toISOString(), steps },
    { status: ok ? 200 : 500 },
  );
}
