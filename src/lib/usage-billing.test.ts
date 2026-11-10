import { test } from "node:test";
import assert from "node:assert/strict";

import { monthStart, usageCharge, withMarkup } from "./usage-billing";

test("the markup is on top of cost", () => {
  assert.equal(withMarkup(1000, 3000), 1300);
  assert.equal(withMarkup(0, 3000), 0);
});

test("usage at cost plus the markup", () => {
  const charge = usageCharge(
    { whatsapp_sent: 200, storage_bytes: 2 * 1024 ** 3 },
    { whatsapp_message_cents: 50, storage_gb_month_cents: 300, markup_bps: 3000 },
  );
  assert.equal(charge.whatsappCents, 13000);
  assert.equal(charge.storageCents, 780);
  assert.equal(charge.totalCents, 13780);
  assert.equal(charge.gigabytes, 2);
});

test("an unset rate charges nothing rather than guessing", () => {
  const charge = usageCharge({ whatsapp_sent: 500, storage_bytes: 10 * 1024 ** 3 }, { whatsapp_message_cents: null, storage_gb_month_cents: null, markup_bps: 3000 });
  assert.equal(charge.totalCents, 0);
});

test("a month is read from what the page sends", () => {
  assert.equal(monthStart("2026-10"), "2026-10-01");
  assert.equal(monthStart("2026-13"), monthStart(null));
  assert.equal(monthStart("nonsense", new Date("2026-11-07T12:00:00Z")), "2026-11-01");
});
