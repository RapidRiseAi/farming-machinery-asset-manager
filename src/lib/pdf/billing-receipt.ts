import "server-only";

import { Pdf } from "@/lib/pdf/doc";
import { rands } from "@/lib/money";
import { t, type Lang } from "@/lib/i18n";
import { shortDate, vatPercent } from "@/lib/format";

/**
 * The receipt a farm gets when their FleetWise subscription is paid.
 *
 * ── Why this exists at all ───────────────────────────────────────────────────
 * Paystack already emails a receipt, and it is not enough. It carries the payment
 * reference and the amount: not our invoice number, not the period it covers, not
 * "3 vehicles at R73", not the registration number of the company charging them, and
 * not the fact that no VAT applies. A farmer querying the charge six months later
 * cannot settle it from that email or from their bank statement.
 *
 * ── Everything is read off the INVOICE, never off today's settings ───────────
 * `seller_snapshot` and `bill_to_snapshot` were frozen onto the invoice when it was
 * issued, exactly as a partner document freezes its letterhead. So a receipt reprinted
 * next year shows the company as it was when the money moved — a change of address, or
 * registering for VAT, cannot silently restate a receipt already in a customer's hands.
 * The one thing NOT snapshotted is the reader's language, which is a preference rather
 * than a fact about the transaction.
 *
 * ── Language ─────────────────────────────────────────────────────────────────
 * Fully translated, unlike the older PDFs in this engine whose headings stay English.
 * This document goes to a FARMER, not to a partner's accountant, and the project has
 * already moved this way once: G5 pulled statement row wording out of SQL because "a
 * statement posted to an Afrikaans farm was having half its lines written in English".
 */

export type BillingReceiptData = {
  invoiceRef: string;
  paidAt: string | null;
  periodStart: string;
  periodEnd: string;
  planLabel: string;
  assetCount: number;
  unitPriceInclCents: number;
  monthsCharged: number;
  subtotalExVatCents: number;
  vatCents: number;
  totalInclCents: number;
  vatRateBps: number;
  /** Frozen at issue: who charged, and under what registration. */
  seller: {
    legalName: string | null;
    tradingName: string | null;
    regNumber: string | null;
    vatRegistered: boolean;
    vatNumber: string | null;
    address: string | null;
    email: string | null;
  };
  /** Frozen at issue: who was charged. */
  billTo: {
    name: string | null;
    address: string | null;
    email: string | null;
  };
  /** How it was paid. Absent for a payment recorded by hand. */
  payment: {
    cardBrand: string | null;
    last4: string | null;
    reference: string | null;
    channel: string | null;
  } | null;
  locale: Lang;
};

function sellerName(d: BillingReceiptData): string {
  return d.seller.tradingName || d.seller.legalName || "FleetWise";
}

export async function buildBillingReceiptPdf(d: BillingReceiptData): Promise<Uint8Array> {
  const L = d.locale;
  const pdf = await Pdf.create(`${t("billingReceipt.title", L)} ${d.invoiceRef}`, {
    name: sellerName(d),
    // No partner branding here: this document is FROM Rapid Rise, so it carries the
    // product's own identity rather than a workshop's letterhead.
    poweredBy: false,
  });

  pdf.header(t("billingReceipt.subtitle", L));

  // ── Who charged, and who was charged ──────────────────────────────────────
  pdf.heading(t("billingReceipt.from", L));
  pdf.text(sellerName(d));
  if (d.seller.legalName && d.seller.tradingName && d.seller.legalName !== d.seller.tradingName) {
    pdf.text(d.seller.legalName);
  }
  if (d.seller.regNumber) pdf.kv(t("billingReceipt.regNumber", L), d.seller.regNumber);
  if (d.seller.address) pdf.text(d.seller.address);
  if (d.seller.email) pdf.text(d.seller.email);
  pdf.gap();

  pdf.heading(t("billingReceipt.to", L));
  pdf.text(d.billTo.name || "—");
  if (d.billTo.address) pdf.text(d.billTo.address);
  if (d.billTo.email) pdf.text(d.billTo.email);
  pdf.gap();

  pdf.hr();

  // ── What it was for ───────────────────────────────────────────────────────
  pdf.kv(t("billingReceipt.reference", L), d.invoiceRef);
  if (d.paidAt) pdf.kv(t("billingReceipt.paidOn", L), shortDate(d.paidAt, L));
  pdf.kv(
    t("billingReceipt.period", L),
    `${shortDate(d.periodStart, L)} – ${shortDate(d.periodEnd, L)}`,
  );
  pdf.gap();

  const perVehicle = `${rands(d.unitPriceInclCents)} ${t("billingReceipt.perVehicleMonth", L)}`;
  pdf.table(
    [
      t("billingReceipt.colDescription", L),
      t("billingReceipt.colVehicles", L),
      t("billingReceipt.colMonths", L),
      t("billingReceipt.colAmount", L),
    ],
    [[
      `${d.planLabel} — ${perVehicle}`,
      String(d.assetCount),
      String(d.monthsCharged),
      rands(d.totalInclCents),
    ]],
    [250, 70, 70, 100],
    [false, true, true, true],
  );
  pdf.gap();

  // ── The money ─────────────────────────────────────────────────────────────
  if (d.vatRateBps > 0) {
    pdf.kv(t("billingReceipt.subtotal", L), rands(d.subtotalExVatCents));
    pdf.kv(
      `${t("billingReceipt.vat", L)} (${vatPercent(d.vatRateBps)}%)`,
      rands(d.vatCents),
    );
  }
  pdf.kv(t("billingReceipt.totalPaid", L), rands(d.totalInclCents));
  pdf.gap();

  if (d.payment) {
    const card =
      d.payment.cardBrand && d.payment.last4
        ? `${d.payment.cardBrand.toUpperCase()} ••••${d.payment.last4}`
        : d.payment.channel || "—";
    pdf.kv(t("billingReceipt.paidWith", L), card);
    if (d.payment.reference) {
      pdf.kv(t("billingReceipt.paymentRef", L), d.payment.reference);
    }
    pdf.gap();
  }

  // The VAT position stated in words either way. A receipt that simply omits VAT leaves
  // the reader to guess whether it was included, forgotten, or not chargeable — and a
  // farmer reclaiming input VAT needs to know which.
  pdf.hr();
  if (d.seller.vatRegistered && d.seller.vatNumber) {
    pdf.kv(t("billingReceipt.vatNumber", L), d.seller.vatNumber);
  } else {
    pdf.text(t("billingReceipt.notVatRegistered", L), { size: 9 });
  }
  pdf.text(t("billingReceipt.keepThis", L), { size: 9 });

  return pdf.save();
}
