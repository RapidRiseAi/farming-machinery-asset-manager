import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { emailConfigured, sendEmail } from "@/lib/email/resend";
import { buildBillingReceiptPdf, type BillingReceiptData } from "@/lib/pdf/billing-receipt";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import { t, type Lang } from "@/lib/i18n";
import { BILLING_RPC } from "@/lib/billing/service";

/**
 * Telling the farm what happened to their money.
 *
 * Two messages, one mechanism:
 *
 *   - a RECEIPT when a subscription payment succeeds. Paystack sends one of its own and
 *     it is not enough: it has the amount and a payment reference, and none of what the
 *     money was for. This one carries our invoice number, the period, the vehicle count
 *     and unit price, the company registration number, and the VAT position in words.
 *
 *   - a FAILURE NOTICE when a renewal is declined. Until now the dunning engine wrote an
 *     in-app alert, which is worth nothing to a farmer who is not logged in and whose
 *     access is about to narrow. Each failed attempt gets its own notice, deliberately:
 *     every retry that does not go through moves them a step closer to losing the plan
 *     they are paying for, and "we tried again and it failed again" is news.
 *
 * ── Exactly once ─────────────────────────────────────────────────────────────
 * Claim first, send second. `billing_claim_receipt` stamps the row only where it is
 * still unstamped, so exactly one caller gets `true` and the loser of the webhook/verify
 * race sends nothing. `false` is the ordinary answer, never an error.
 *
 * If the send then fails, the claim is HANDED BACK with the reason recorded, so the
 * nightly pass tries again. A receipt nobody received must not look sent — that is the
 * whole reason `release` exists rather than just letting the stamp stand.
 *
 * ── Env-gated, like everything else that leaves the building ─────────────────
 * With `RESEND_API_KEY` unset this reports `skipped` and claims nothing, so a fresh
 * clone, the test suite and a preview deployment with no mail account all behave. There
 * is no silent success, and nothing is marked sent that was not.
 */

export type NoticeSummary = {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  reasons: string[];
};

const EMPTY: NoticeSummary = { considered: 0, sent: 0, skipped: 0, failed: 0, reasons: [] };

function fromLine(sellerName: string): string {
  const base = process.env.EMAIL_FROM || "billing@fleetwise.app";
  const safe = sellerName.replace(/["\\<>]/g, "").trim().slice(0, 60);
  return safe ? `${safe} <${base}>` : base;
}

/** The reader's language: the farm owner's own choice, falling back to English. */
async function farmLocale(supabase: SupabaseClient, farmId: string): Promise<Lang> {
  const { data } = await supabase
    .from("users")
    .select("language")
    .eq("farm_id", farmId)
    .eq("role", "owner")
    .eq("active", true)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1);
  const rows = (data ?? []) as { language: string | null }[];
  const lang = rows[0]?.language;
  return lang === "af" ? "af" : "en";
}

type InvoiceRow = {
  id: string;
  farm_id: string;
  invoice_ref: string;
  period_start: string;
  period_end: string;
  plan: string;
  asset_count: number;
  unit_price_incl_cents: number;
  months_charged: number;
  subtotal_ex_vat_cents: number;
  vat_cents: number;
  total_incl_cents: number;
  vat_rate_bps: number;
  seller_snapshot: Record<string, unknown> | null;
  bill_to_snapshot: Record<string, unknown> | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

async function loadReceipt(
  supabase: SupabaseClient,
  invoiceId: string,
  locale: Lang,
): Promise<BillingReceiptData | null> {
  const { data } = await supabase
    .from("billing_invoices")
    .select(
      "id, farm_id, invoice_ref, period_start, period_end, plan, asset_count, " +
        "unit_price_incl_cents, months_charged, subtotal_ex_vat_cents, vat_cents, " +
        "total_incl_cents, vat_rate_bps, seller_snapshot, bill_to_snapshot",
    )
    .eq("id", invoiceId)
    .maybeSingle();
  const inv = data as InvoiceRow | null;
  if (!inv) return null;

  // How it was paid, and when. A payment recorded by hand has no card, which the PDF
  // renders as an absent block rather than inventing one.
  const { data: payData } = await supabase
    .from("billing_payments")
    .select("paid_at, channel, provider_reference, attempt_id")
    .eq("invoice_id", invoiceId)
    .is("deleted_at", null)
    .order("paid_at", { ascending: false })
    .limit(1);
  const pay = ((payData ?? []) as {
    paid_at: string | null;
    channel: string | null;
    provider_reference: string | null;
    attempt_id: string | null;
  }[])[0];

  let cardBrand: string | null = null;
  let last4: string | null = null;
  if (pay?.attempt_id) {
    const { data: pmData } = await supabase
      .from("billing_payment_attempts")
      .select("payment_method_id")
      .eq("id", pay.attempt_id)
      .maybeSingle();
    const pmId = (pmData as { payment_method_id: string | null } | null)?.payment_method_id;
    if (pmId) {
      // Display columns only. The authorization code is not selected here and must never
      // be: this object is on its way into a PDF and an email.
      const { data: card } = await supabase
        .from("billing_payment_methods")
        .select("card_brand, last4")
        .eq("id", pmId)
        .maybeSingle();
      const c = card as { card_brand: string | null; last4: string | null } | null;
      cardBrand = c?.card_brand ?? null;
      last4 = c?.last4 ?? null;
    }
  }

  const seller = (inv.seller_snapshot ?? {}) as Record<string, unknown>;
  const billTo = (inv.bill_to_snapshot ?? {}) as Record<string, unknown>;

  return {
    invoiceRef: inv.invoice_ref,
    paidAt: pay?.paid_at ?? null,
    periodStart: inv.period_start,
    periodEnd: inv.period_end,
    planLabel: t(`plan.${inv.plan}`, locale),
    assetCount: inv.asset_count,
    unitPriceInclCents: inv.unit_price_incl_cents,
    monthsCharged: inv.months_charged,
    subtotalExVatCents: inv.subtotal_ex_vat_cents,
    vatCents: inv.vat_cents,
    totalInclCents: inv.total_incl_cents,
    vatRateBps: inv.vat_rate_bps,
    seller: {
      legalName: str(seller.legal_name),
      tradingName: str(seller.trading_name),
      regNumber: str(seller.reg_number),
      vatRegistered: seller.vat_registered === true,
      vatNumber: str(seller.vat_number),
      address: str(seller.billing_address),
      email: str(seller.billing_email),
    },
    billTo: {
      name: str(billTo.name) ?? str(billTo.trading_name),
      address: str(billTo.billing_address),
      email: str(billTo.billing_email),
    },
    payment: pay
      ? {
          cardBrand,
          last4,
          reference: pay.provider_reference,
          channel: pay.channel,
        }
      : null,
    locale,
  };
}

function receiptBody(d: BillingReceiptData, farmName: string): { html: string; text: string } {
  const L = d.locale;
  const amount = rands(d.totalInclCents);
  const period = `${shortDate(d.periodStart, L)} – ${shortDate(d.periodEnd, L)}`;
  const lines = [
    t("billingReceiptEmail.greeting", L).replace("{name}", farmName),
    "",
    t("billingReceiptEmail.body", L)
      .replace("{amount}", amount)
      .replace("{period}", period)
      .replace("{ref}", d.invoiceRef),
    "",
    `${t("billingReceipt.colVehicles", L)}: ${d.assetCount}`,
    `${t("billingReceipt.totalPaid", L)}: ${amount}`,
    "",
    t("billingReceiptEmail.attached", L),
    "",
    d.seller.tradingName || d.seller.legalName || "FleetWise",
  ];
  const text = lines.join("\n");
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;color:#242824">` +
    lines
      .map((l) => (l === "" ? "<p></p>" : `<p style="margin:0 0 8px">${escapeHtml(l)}</p>`))
      .join("") +
    `</div>`;
  return { html, text };
}

function failureBody(
  row: FailureRow,
  locale: Lang,
): { html: string; text: string; subject: string } {
  const L = locale;
  const amount = rands(row.amount_incl_cents);
  const lines = [
    t("billingFailureEmail.greeting", L).replace("{name}", row.farm_name ?? ""),
    "",
    t("billingFailureEmail.body", L).replace("{amount}", amount),
    "",
    row.next_retry_on
      ? t("billingFailureEmail.willRetry", L).replace("{date}", shortDate(row.next_retry_on, L))
      : t("billingFailureEmail.noMoreRetries", L),
    row.grace_ends_on
      ? t("billingFailureEmail.graceEnds", L).replace("{date}", shortDate(row.grace_ends_on, L))
      : "",
    "",
    t("billingFailureEmail.whatToDo", L),
  ].filter((l, i, a) => !(l === "" && a[i - 1] === ""));
  const text = lines.join("\n");
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;color:#242824">` +
    lines
      .map((l) => (l === "" ? "<p></p>" : `<p style="margin:0 0 8px">${escapeHtml(l)}</p>`))
      .join("") +
    `</div>`;
  return { html, text, subject: t("billingFailureEmail.subject", L).replace("{amount}", amount) };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type ReceiptDue = {
  invoice_id: string;
  farm_id: string;
  invoice_ref: string;
  total_incl_cents: number;
  recipient_email: string | null;
  farm_name: string | null;
};

type FailureRow = {
  attempt_id: string;
  invoice_id: string | null;
  farm_id: string;
  invoice_ref: string | null;
  amount_incl_cents: number;
  failure_reason: string | null;
  recipient_email: string | null;
  farm_name: string | null;
  next_retry_on: string | null;
  grace_ends_on: string | null;
};

/** Email a receipt for every subscription payment that has not had one. */
export async function sendDueReceipts(
  supabase: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<NoticeSummary> {
  if (!emailConfigured()) {
    return { ...EMPTY, skipped: 1, reasons: ["email-not-configured"] };
  }

  const { data, error } = await supabase.rpc(BILLING_RPC.receiptsDue, {
    p_limit: opts.limit ?? 50,
  });
  if (error) return { ...EMPTY, failed: 1, reasons: [error.message] };

  const rows = (data ?? []) as ReceiptDue[];
  const out: NoticeSummary = { considered: rows.length, sent: 0, skipped: 0, failed: 0, reasons: [] };

  for (const row of rows) {
    if (!row.recipient_email) {
      out.skipped += 1;
      out.reasons.push(`${row.invoice_ref}: no recipient`);
      continue;
    }

    // Claim BEFORE building anything. Losing here is the normal outcome of the race.
    const { data: won, error: claimErr } = await supabase.rpc(BILLING_RPC.claimReceipt, {
      p_invoice: row.invoice_id,
    });
    if (claimErr) {
      out.failed += 1;
      out.reasons.push(`${row.invoice_ref}: ${claimErr.message}`);
      continue;
    }
    if (won !== true) {
      out.skipped += 1;
      continue;
    }

    try {
      const locale = await farmLocale(supabase, row.farm_id);
      const receipt = await loadReceipt(supabase, row.invoice_id, locale);
      if (!receipt) throw new Error("invoice vanished between listing and loading");

      const pdf = await buildBillingReceiptPdf(receipt);
      const body = receiptBody(receipt, row.farm_name ?? "");
      const sellerName =
        receipt.seller.tradingName || receipt.seller.legalName || "FleetWise";

      const sent = await sendEmail({
        to: row.recipient_email,
        from: fromLine(sellerName),
        replyTo: receipt.seller.email ?? null,
        subject: t("billingReceiptEmail.subject", locale)
          .replace("{amount}", rands(receipt.totalInclCents))
          .replace("{ref}", receipt.invoiceRef),
        html: body.html,
        text: body.text,
        attachments: [{ filename: `${receipt.invoiceRef}.pdf`, content: pdf }],
      });

      if (!sent.ok) throw new Error(sent.error);
      out.sent += 1;
    } catch (err) {
      // Hand the claim back so tonight's pass tries again, and record why.
      const reason = err instanceof Error ? err.message : "send failed";
      await supabase.rpc(BILLING_RPC.releaseReceipt, {
        p_invoice: row.invoice_id,
        p_error: reason,
      });
      out.failed += 1;
      out.reasons.push(`${row.invoice_ref}: ${reason}`);
    }
  }

  return out;
}

/** Email the farm about every failed charge they have not been told about. */
export async function sendDueFailureNotices(
  supabase: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<NoticeSummary> {
  if (!emailConfigured()) {
    return { ...EMPTY, skipped: 1, reasons: ["email-not-configured"] };
  }

  const { data, error } = await supabase.rpc(BILLING_RPC.failureNoticesDue, {
    p_limit: opts.limit ?? 50,
  });
  if (error) return { ...EMPTY, failed: 1, reasons: [error.message] };

  const rows = (data ?? []) as FailureRow[];
  const out: NoticeSummary = { considered: rows.length, sent: 0, skipped: 0, failed: 0, reasons: [] };

  for (const row of rows) {
    if (!row.recipient_email) {
      out.skipped += 1;
      continue;
    }

    const { data: won, error: claimErr } = await supabase.rpc(BILLING_RPC.claimFailureNotice, {
      p_attempt: row.attempt_id,
    });
    if (claimErr) {
      out.failed += 1;
      out.reasons.push(claimErr.message);
      continue;
    }
    if (won !== true) {
      out.skipped += 1;
      continue;
    }

    try {
      const locale = await farmLocale(supabase, row.farm_id);
      const body = failureBody(row, locale);
      const sent = await sendEmail({
        to: row.recipient_email,
        from: fromLine("FleetWise"),
        subject: body.subject,
        html: body.html,
        text: body.text,
      });
      if (!sent.ok) throw new Error(sent.error);
      out.sent += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "send failed";
      // Hand the claim back, exactly as the receipt does. This reverses the call made in
      // 20260907120000, which withheld the release to avoid nightly re-sends over a full
      // mailbox. Driving it showed the harm runs the other way: a transient provider
      // error meant the farmer was NEVER told their payment failed and lost their plan
      // 31 days later without warning, while the cost of retrying a dead address is a
      // line in a log. Never being told is worse than being told twice.
      await supabase.rpc(BILLING_RPC.releaseFailureNotice, { p_attempt: row.attempt_id });
      out.failed += 1;
      out.reasons.push(reason);
    }
  }

  return out;
}
