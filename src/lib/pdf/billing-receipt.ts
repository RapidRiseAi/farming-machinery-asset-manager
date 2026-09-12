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

/**
 * Which document this is.
 *
 * A receipt and an invoice are the same transaction read from either side of the payment,
 * which is why they share a builder, a data shape and — crucially — the same frozen
 * snapshot of who charged whom. What differs is the tense.
 */
export type BillingDocumentKind = "receipt" | "invoice";

export type BillingReceiptData = {
  kind: BillingDocumentKind;
  invoiceRef: string;
  paidAt: string | null;
  /** When the money is owed by. Null on an invoice raised without terms. */
  dueOn: string | null;
  /** What has been received against it — a part payment is not nothing. */
  amountPaidCents: number;
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
  const isInvoice = d.kind === "invoice";
  // What is still owed. Never negative: a refund is recorded as its own negative payment
  // (20260911210000) and an over-refunded invoice must not print as a bill for a minus.
  const outstandingCents = Math.max(d.totalInclCents - d.amountPaidCents, 0);
  // Compared at the moment of printing, which is the only honest reading — the document
  // says what was true when it was generated, and stamps that date in its own footer.
  const overdue =
    isInvoice && outstandingCents > 0 && !!d.dueOn && d.dueOn < new Date().toISOString().slice(0, 10);

  const pdf = await Pdf.create(
    `${t(isInvoice ? "billingReceipt.invoiceTitle" : "billingReceipt.title", L)} ${d.invoiceRef}`,
    {
    name: sellerName(d),
    // No partner branding here: this document is FROM Rapid Rise, so it carries the
    // product's own identity rather than a workshop's letterhead.
    poweredBy: false,
    // The engine's default stamp is `<name> · generated <ISO date>` — an English word and
    // an ISO date at the foot of a page that is translated everywhere else. Overriding it
    // HERE rather than in the engine leaves partner letterheads, job cards and machine
    // files untouched. "Generated", not "issued": the engine stamps TODAY, so a receipt
    // reprinted next year would be claiming the wrong issue date.
    footer: `${sellerName(d)} · ${t("billingReceipt.generatedOn", L)} ${shortDate(new Date(), L)}`,
    },
  );

  pdf.header(t("billingReceipt.subtitle", L));

  // ── The two facts somebody opens either document for ──────────────────────
  // How much, and where it stands. Everything below is the supporting detail, and it used
  // to come first with the total as one `kv` row among eight — the same visual weight as
  // the payment reference.
  //
  // An invoice that has been settled prints as settled rather than demanding money again:
  // somebody downloading the bill after paying it should not be told they owe it.
  if (isInvoice && outstandingCents > 0) {
    pdf.totalBlock(
      t("billingReceipt.amountDue", L),
      rands(outstandingCents),
      d.dueOn
        ? t(overdue ? "billingReceipt.wasDueOn" : "billingReceipt.dueBy", L).replace(
            "{date}",
            shortDate(d.dueOn, L),
          )
        : "",
    );
    // A part payment is not nothing, and an invoice that ignored it would be asking for
    // money already received.
    if (d.amountPaidCents > 0) {
      pdf.kv(
        t("billingReceipt.alreadyPaid", L),
        `${rands(d.amountPaidCents)} ${t("billingReceipt.ofTotal", L).replace("{total}", rands(d.totalInclCents))}`,
      );
    }
  } else {
    pdf.totalBlock(
      t(isInvoice ? "billingReceipt.totalDocument" : "billingReceipt.totalPaid", L),
      rands(d.totalInclCents),
      d.paidAt
        ? `${t("billingReceipt.paidInFull", L)} — ${shortDate(d.paidAt, L)}`
        : t("billingReceipt.paidInFull", L),
    );
  }

  // The reference next, because it is what somebody quotes when they ring about it. An
  // invoice number and a receipt number are not the same noun even when they are the same
  // string, and a farm office files them under different headings.
  pdf.kv(
    t(isInvoice ? "billingReceipt.invoiceReference" : "billingReceipt.reference", L),
    d.invoiceRef,
  );
  pdf.kv(
    t("billingReceipt.period", L),
    `${shortDate(d.periodStart, L)} – ${shortDate(d.periodEnd, L)}`,
  );
  pdf.gap();
  pdf.hr();

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
  // The reference, the period and the date are at the top now, beside the amount. This is
  // the itemisation: what the money bought.
  pdf.heading(t("billingReceipt.whatFor", L));

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
  // The total itself is in the block at the top and is deliberately NOT repeated here: one
  // figure, in one place, is the whole point of putting it where the eye lands first. The
  // split is still shown when there is one, because a farmer reclaiming input VAT needs
  // the ex-VAT figure and the VAT figure separately.
  if (d.vatRateBps > 0) {
    pdf.kv(t("billingReceipt.subtotal", L), rands(d.subtotalExVatCents));
    // `vatPercent` already returns "15%". This line used to append a second sign and
    // print "VAT (15%%)" to every VAT-registered customer, in both languages.
    pdf.kv(
      `${t("billingReceipt.vat", L)} (${vatPercent(d.vatRateBps)})`,
      rands(d.vatCents),
    );
    pdf.gap();
  }

  if (d.payment) {
    // Spelled out rather than masked with bullets. `sanitize()` in doc.ts maps "•" to "-"
    // for every PDF in the product (the standard PDF fonts have no bullet glyph), so
    // "VISA ••••4081" reached the customer as "VISA ----4081", which reads as a redaction
    // or a typo rather than a card number. Changing the shared map would restyle every
    // other document, so the receipt says it in words instead — and in the reader's
    // language, which bullets could never do.
    const card =
      d.payment.cardBrand && d.payment.last4
        ? `${d.payment.cardBrand.toUpperCase()} ${t("billingReceipt.cardEnding", L)} ${d.payment.last4}`
        : d.payment.channel || "—";
    pdf.kv(t("billingReceipt.paidWith", L), card);
    if (d.payment.reference) {
      pdf.kv(t("billingReceipt.paymentRef", L), d.payment.reference);
    }
    pdf.gap();
  }

  // ── How to pay it ─────────────────────────────────────────────────────────
  // Only on an invoice with money still owed, and deliberately WITHOUT bank details: Rapid
  // Rise collects by card through Paystack and has no account for this, so printing one
  // would be inventing a payment route that does not exist. What it does instead is name
  // the two-minute path and the address to write to for anything else.
  if (isInvoice && outstandingCents > 0) {
    pdf.hr();
    pdf.heading(t("billingReceipt.howToPay", L));
    pdf.text(t("billingReceipt.howToPayCard", L));
    if (d.seller.email) {
      pdf.text(t("billingReceipt.questionsAbout", L).replace("{email}", d.seller.email));
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
  pdf.text(t(isInvoice ? "billingReceipt.keepThisInvoice" : "billingReceipt.keepThis", L), {
    size: 9,
  });

  return pdf.save();
}
