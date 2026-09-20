import "server-only";

/**
 * Alerts by email, for the farmer who never opens the app.
 *
 * `notification_channel` has carried `email` since 0006 and nothing ever delivered it.
 * In-app needs somebody to look; push needs the app installed and permission granted on
 * the device; WhatsApp waits on a provider. Meanwhile `SCOPE.md` §1 promises the farmer
 * value "even if he personally never types anything".
 *
 * Leased and retryable, exactly like `push/deliver.ts` (20260908112916): a row is claimed
 * for five minutes, and only marked sent when the provider ACCEPTED it. A failure at
 * Resend releases the claim with a back-off, so a temporary outage delays a reminder
 * rather than discarding it. Opt-in per user (`users.notify_email`), and quiet hours are
 * already honoured upstream — `deliver_after` is set at enqueue, and the claim will not
 * pick a row up before it.
 *
 * WHAT IT WILL NOT PUT IN AN EMAIL
 * Money. An alert about a completed job or an invoice carries amounts, an inbox is not the
 * authenticated app, and the recipient may have lost cost access since it was queued. Those
 * get the neutral title and a link, which is the same rule `pushBody` applies to a lock
 * screen.
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emailConfigProblem, fromAddress, sendEmail } from "@/lib/email/resend";
import { formatNotification, notificationTitle, notificationUrl } from "@/lib/notifications/format";
import { t, type Lang, type Locale } from "@/lib/i18n";
import { APP_NAME, siteUrl } from "@/lib/env";

type NotifRow = {
  id: string;
  user_id: string | null;
  farm_id: string;
  template: string;
  payload: Record<string, unknown> | null;
};
type UserRow = { id: string; notify_email: boolean; language: Locale; email: string | null; name: string | null };

export type EmailDeliverResult = {
  ok: boolean;
  skipped?: string;
  error?: string;
  scanned: number;
  sent: number;
  failed: number;
  /** No address, or the person has not asked for email: done with, not retried. */
  skippedRows: number;
  deferred: number;
};

// The SQL lease is five minutes. Stay well inside it, including provider time.
const BATCH = 25;
const RUN_BUDGET_MS = 25_000;

/** Templates whose payload is about money. Same list as the push path, same reason. */
const FINANCIAL_TEMPLATES = new Set([
  "job_completed", "work_request_quoted", "work_request_invoiced",
  "partner_quote_received", "partner_invoice_received", "quote_awaiting", "invoice_awaiting",
  "invoice_due_soon", "invoice_overdue", "invoice_overdue_partner",
  "quote_accepted_partner", "payment_claimed_partner",
]);

function isFinancial(n: NotifRow): boolean {
  const payload = n.payload ?? {};
  return FINANCIAL_TEMPLATES.has(n.template) || n.template.startsWith("billing_") ||
    Object.keys(payload).some((key) => key.endsWith("_cents") || ["amount", "cost", "total"].includes(key));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function deliverNotificationEmail(
  supabase: SupabaseClient,
  deps: { now: () => number } = { now: Date.now },
): Promise<EmailDeliverResult> {
  const result: EmailDeliverResult = {
    ok: true, scanned: 0, sent: 0, failed: 0, skippedRows: 0, deferred: 0,
  };
  const problem = emailConfigProblem();
  // Say WHICH problem. "email-not-configured" on its own cost this project weeks.
  if (problem) return { ...result, skipped: `email-not-configured: ${problem}` };

  const deadline = deps.now() + RUN_BUDGET_MS;
  const claimId = randomUUID();
  const fail = (reason: string) => {
    result.ok = false;
    result.failed++;
    result.error ??= reason;
  };

  let notifs: NotifRow[];
  try {
    const claimed = await supabase.rpc("claim_notification_email", { p_claim_id: claimId, p_limit: BATCH });
    if (claimed.error) throw new Error("claim-failed");
    notifs = (claimed.data as NotifRow[] | null) ?? [];
  } catch {
    fail("claim-failed");
    return result;
  }
  result.scanned = notifs.length;
  if (!notifs.length) return result;

  const finish = async (n: NotifRow, terminal: boolean, error?: string) => {
    if (!terminal) result.deferred++;
    try {
      const done = await supabase.rpc("finish_notification_email", {
        p_notification_id: n.id, p_claim_id: claimId, p_terminal: terminal, p_error: error ?? null,
      });
      if (done.error || done.data !== true) throw new Error("finish-failed");
    } catch {
      // Never claim success when persistence failed: the lease expires and it is retried.
      fail("finish-failed");
    }
  };

  const userIds = [...new Set(notifs.flatMap((n) => (n.user_id ? [n.user_id] : [])))];
  const machineIds = [...new Set(notifs.flatMap((n) =>
    typeof n.payload?.machine_id === "string" ? [n.payload.machine_id] : []))];

  let users: Map<string, UserRow>;
  let machineNames: Map<string, string>;
  try {
    const [usersRes, machinesRes] = await Promise.all([
      supabase.from("users").select("id, notify_email, language, email, name")
        .is("deleted_at", null).eq("active", true).in("id", userIds),
      machineIds.length
        ? supabase.from("machines").select("id, name").in("id", machineIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
    ]);
    // A failed lookup is not "nobody wants email": keep the whole batch for the next pass.
    if (usersRes.error || machinesRes.error) throw new Error("lookup-failed");
    users = new Map(((usersRes.data as UserRow[] | null) ?? []).map((u) => [u.id, u]));
    machineNames = new Map(((machinesRes.data as { id: string; name: string }[] | null) ?? [])
      .map((m) => [m.id, m.name]));
  } catch {
    fail("lookup-failed");
    await Promise.all(notifs.map((n) => finish(n, false, "lookup-failed")));
    return result;
  }

  for (const n of notifs) {
    if (deps.now() >= deadline) {
      await finish(n, false, "run-budget");
      continue;
    }
    const user = n.user_id ? users.get(n.user_id) : undefined;
    const address = user?.email?.trim();
    // Terminal: this row has nothing to send to and never will have. Retrying it every
    // five minutes for ever would be its own kind of failure.
    if (!user || !user.notify_email || !address) {
      result.skippedRows++;
      await finish(n, true);
      continue;
    }

    const locale = (user.language ?? "en") as Lang;
    const machineName = typeof n.payload?.machine_id === "string"
      ? machineNames.get(n.payload.machine_id) : undefined;
    const title = notificationTitle(n.template, locale);
    const body = isFinancial(n)
      ? t("notifyEmail.financialBody", locale)
      : formatNotification(n.template, n.payload ?? {}, locale, machineName);
    const openLabel = t("notifyEmail.open", locale);
    const why = t("notifyEmail.why", locale);
    // No NEXT_PUBLIC_SITE_URL means no honest absolute link. The alert still goes; a
    // half-built URL in somebody's inbox would be worse than none.
    const base = siteUrl();
    const link = base ? `${base}${notificationUrl(n.template, n.payload ?? {})}` : null;

    const text = [title, "", body, ...(link ? ["", `${openLabel}: ${link}`] : []), "", why].join("\n");
    const html =
      `<p style="font-size:16px;margin:0 0 12px"><strong>${escapeHtml(title)}</strong></p>` +
      `<p style="font-size:16px;margin:0 0 16px">${escapeHtml(body)}</p>` +
      (link
        ? `<p style="margin:0 0 16px"><a href="${escapeHtml(link)}">${escapeHtml(openLabel)}</a></p>`
        : "") +
      `<p style="font-size:12px;color:#5d5a52;margin:0">${escapeHtml(why)}</p>`;

    try {
      const sent = await sendEmail({
        to: address,
        from: fromAddress(APP_NAME),
        subject: title,
        html,
        text,
      });
      if (sent.ok) {
        result.sent++;
        await finish(n, true);
      } else {
        fail(sent.error);
        await finish(n, false, sent.error);
      }
    } catch {
      fail("send-failed");
      await finish(n, false, "send-failed");
    }
  }

  return result;
}
