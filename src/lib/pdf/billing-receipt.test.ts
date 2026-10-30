/**
 * The billing receipt renders for every kind of invoice (buildBillingReceiptPdf), including
 * a once-off service invoice (20261029110000), whose lines replace the plan row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBillingReceiptPdf, type BillingReceiptData } from "./billing-receipt";

const base: BillingReceiptData = {
  kind: "invoice",
  invoiceRef: "RR-TEST-0001",
  paidAt: null,
  dueOn: "2026-11-12",
  amountPaidCents: 0,
  periodStart: "2026-10-29",
  periodEnd: "2026-10-29",
  planLabel: "Complete",
  assetCount: 0,
  unitPriceInclCents: 0,
  monthsCharged: 1,
  subtotalExVatCents: 186000,
  vatCents: 0,
  totalInclCents: 186000,
  vatRateBps: 0,
  aiOnly: false,
  serviceLines: null,
  discount: null,
  aiUsage: null,
  seller: { legalName: "Rapid Rise AI (Pty) Ltd", tradingName: "Fleet Wise", regNumber: null, vatRegistered: false, vatNumber: null, address: null, email: null },
  billTo: { name: "Test Farm", address: null, email: null },
  payment: null,
  locale: "en",
};

const isPdf = (bytes: Uint8Array) => Buffer.from(bytes.slice(0, 5)).toString("latin1") === "%PDF-";

test("a service invoice renders with its own lines", async () => {
  const bytes = await buildBillingReceiptPdf({
    ...base,
    serviceLines: [
      { description: "Onboarding and setup", qty: 1, totalInclCents: 150000 },
      { description: "QR stickers", qty: 3, totalInclCents: 36000 },
    ],
  });
  assert.ok(isPdf(bytes));
});

test("a plan invoice and an AI-only invoice still render", async () => {
  assert.ok(isPdf(await buildBillingReceiptPdf({ ...base, assetCount: 3, unitPriceInclCents: 62000, totalInclCents: 186000 })));
  assert.ok(isPdf(await buildBillingReceiptPdf({ ...base, aiOnly: true })));
});

test("an Afrikaans service receipt renders", async () => {
  assert.ok(isPdf(await buildBillingReceiptPdf({
    ...base,
    kind: "receipt",
    locale: "af",
    paidAt: "2026-10-29T10:00:00Z",
    amountPaidCents: 186000,
    serviceLines: [{ description: "Opleiding", qty: 2, totalInclCents: 186000 }],
  })));
});
