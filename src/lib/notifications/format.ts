/**
 * One place that turns a queued notification (template + payload) into human text, shared
 * by the in-app centre (src/app/(app)/notifications/page.tsx) and the Web-Push delivery
 * path (src/lib/push/deliver.ts) so both channels read identically.
 */
import type { Locale, Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";

export type NotePayload = Record<string, unknown>;

function fill(key: string, locale: Lang, vars: Record<string, string>): string {
  let s = t(key, locale);
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

/**
 * Body text for a notification. `machineName` (resolved from a live machines lookup) wins
 * over the name embedded in the payload; both fall back to "".
 */
export function formatNotification(
  template: string,
  payload: NotePayload,
  locale: Lang,
  machineName?: string
): string {
  const p = payload ?? {};
  const m = machineName ?? (p.machine_name as string) ?? "";
  const licenceType = p.licence_type ? t(`licenceType.${p.licence_type}`, locale) : "";
  switch (template) {
    case "service_due_soon":
      return fill("notifications.tplServiceDueSoon", locale, { machine: m, task: String(p.task ?? "") });
    case "service_overdue":
      return fill("notifications.tplServiceOverdue", locale, { machine: m, task: String(p.task ?? "") });
    case "stale_meter":
      return fill("notifications.tplStaleMeter", locale, { count: String(p.count ?? 0) });
    case "weekly_digest":
      return fill("notifications.tplWeeklyDigest", locale, {
        overdue: String(p.overdue_count ?? 0),
        dueSoon: String(p.due_soon_count ?? 0),
        faults: String(p.open_faults_count ?? 0),
      });
    case "fault_reported":
      return fill("notifications.tplFaultReported", locale, {
        machine: m,
        description: String(p.description ?? ""),
        urgency: String(p.urgency ?? ""),
      });
    case "job_completed":
      return fill("notifications.tplJobCompleted", locale, { machine: m, total: rands(p.total_cents as number) });
    case "fuel_anomaly":
      return fill("notifications.tplFuelAnomaly", locale, {
        machine: m,
        litres: String(p.litres ?? ""),
        delta: String(p.delta_pct ?? ""),
      });
    case "warranty_expiring":
      return fill("notifications.tplWarrantyExpiring", locale, { machine: m, date: String(p.expiry_date ?? "") });
    case "warranty_expired":
      return fill("notifications.tplWarrantyExpired", locale, { machine: m, date: String(p.expiry_date ?? "") });
    case "licence_expiring":
      return fill("notifications.tplLicenceExpiring", locale, {
        machine: m,
        type: licenceType,
        date: String(p.expiry_date ?? ""),
      });
    case "licence_expired":
      return fill("notifications.tplLicenceExpired", locale, {
        machine: m,
        type: licenceType,
        date: String(p.expiry_date ?? ""),
      });
    // Work-request activity (F12b trigger 0311) — surfaced in the owner inbox + alerts.
    case "work_request_status":
      return fill("notifications.tplWorkStatus", locale, {
        machine: m,
        kind: p.kind ? t(`workKind.${p.kind}`, locale) : "",
        status: p.status ? t(`workStatus.${p.status}`, locale) : "",
      });
    case "work_request_quoted":
      return fill("notifications.tplWorkQuoted", locale, { machine: m, amount: rands(p.amount_cents as number) });
    case "work_request_invoiced":
      return fill("notifications.tplWorkInvoiced", locale, { machine: m, amount: rands(p.amount_cents as number) });
    // A partner sent a quote or an invoice (F14, 0381 notify trigger). The amount is the
    // VAT-INCLUSIVE total, because that is what the farmer is being asked to agree to.
    case "partner_quote_received":
      return fill("notifications.tplPartnerQuote", locale, {
        number: String(p.number ?? ""),
        amount: rands(p.amount_cents as number),
      });
    case "partner_invoice_received":
      return fill("notifications.tplPartnerInvoice", locale, {
        number: String(p.number ?? ""),
        amount: rands(p.amount_cents as number),
      });
    // Outstanding-action reminders (F13 engine 0330).
    case "quote_awaiting":
      return fill("notifications.tplQuoteAwaiting", locale, { machine: m, amount: rands(p.amount_cents as number) });
    case "invoice_awaiting":
      return fill("notifications.tplInvoiceAwaiting", locale, { machine: m, amount: rands(p.amount_cents as number) });
    // The money clock (G2 engine 0414). Each of these has a partner-side twin — the same
    // fact told to the person who can act on it, which for an overdue invoice is both
    // sides at once.
    case "quote_expiring":
      return fill("notifications.tplQuoteExpiring", locale, { number: String(p.number ?? ""), due: String(p.due_date ?? "") });
    case "quote_expiring_partner":
      return fill("notifications.tplQuoteExpiringPartner", locale, {
        number: String(p.number ?? ""), customer: String(p.customer ?? ""), due: String(p.due_date ?? ""),
      });
    case "invoice_due_soon":
      return fill("notifications.tplInvoiceDueSoon", locale, {
        number: String(p.number ?? ""), amount: rands(p.amount as number), due: String(p.due_date ?? ""),
      });
    case "invoice_overdue":
      return fill("notifications.tplInvoiceOverdue", locale, {
        number: String(p.number ?? ""), amount: rands(p.amount as number), due: String(p.due_date ?? ""),
      });
    case "invoice_overdue_partner":
      return fill("notifications.tplInvoiceOverduePartner", locale, {
        number: String(p.number ?? ""), customer: String(p.customer ?? ""), amount: rands(p.amount as number),
      });
    // Answers from the customer's emailed link (G2). The partner is not watching the
    // screen when someone accepts at 9pm, which is exactly why these exist.
    case "quote_accepted_partner":
      return fill("notifications.tplQuoteAcceptedPartner", locale, {
        number: String(p.number ?? ""), by: String(p.by ?? ""), amount: rands(p.amount as number),
      });
    case "quote_declined_partner":
      return fill("notifications.tplQuoteDeclinedPartner", locale, {
        number: String(p.number ?? ""), reason: String(p.reason ?? ""),
      });
    case "payment_claimed_partner":
      return fill("notifications.tplPaymentClaimedPartner", locale, {
        number: String(p.number ?? ""), reference: String(p.reference ?? ""), amount: rands(p.amount as number),
      });
    // AARTO nomination-deadline reminder (G2 engine 0371). `status` = expiring | expired.
    case "aarto_nomination_due":
      return fill(
        p.status === "expired" ? "notifications.tplAartoNominationOverdue" : "notifications.tplAartoNominationDue",
        locale,
        { machine: m, deadline: String(p.deadline ?? ""), notice: String(p.notice_number ?? "") }
      );
    default:
      return template;
  }
}

/** Short category title for a push notification. */
export function notificationTitle(template: string, locale: Lang): string {
  const family = template.startsWith("service_")
    ? "service"
    : template.startsWith("warranty_")
      ? "warranty"
      : template.startsWith("licence_")
        ? "licence"
        : template.startsWith("fault_")
          ? "fault"
          : template.startsWith("job_")
            ? "job"
            : template.startsWith("fuel_")
              ? "fuel"
              : template.startsWith("work_request_") ||
                  template === "quote_awaiting" ||
                  template === "invoice_awaiting"
                ? "work"
                : template.startsWith("partner_") ||
                    template.startsWith("quote_") ||
                    template.startsWith("invoice_") ||
                    template.startsWith("payment_")
                  ? "documents"
                : template.startsWith("aarto_")
                  ? "aarto"
                  : template;
  return t(`pushTitle.${family}`, locale);
}

/** Deep link a notification click should open (best-effort; falls back to the alert centre). */
export function notificationUrl(template: string, payload: NotePayload): string {
  const p = payload ?? {};
  if (template.startsWith("fault_")) return "/faults";
  if (template === "job_completed" && p.job_card_id) return `/jobcards/${p.job_card_id}`;
  // Work-request activity + quote/invoice reminders deep-link to the request itself.
  if (
    (template.startsWith("work_request_") || template === "quote_awaiting" || template === "invoice_awaiting") &&
    p.work_request_id
  )
    return `/work/${p.work_request_id}`;
  // Anything that names a document opens that document — the partner-side reminders and
  // the customer's answers from the emailed link included.
  if (p.document_id) return `/documents/${p.document_id}`;
  // AARTO nomination reminders deep-link to the fines workflow.
  if (template.startsWith("aarto_")) return "/fines";
  if (p.machine_id) return `/machines/${p.machine_id}`;
  return "/notifications";
}
