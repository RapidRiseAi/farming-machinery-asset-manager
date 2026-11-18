import { test } from "node:test";
import assert from "node:assert/strict";

import { monthStart, usageCost, withMarkup } from "./usage-billing";

test("the markup is on top of cost", () => {
  assert.equal(withMarkup(1000, 3000), 1300);
  assert.equal(withMarkup(0, 3000), 0);
});

test("the meter is Rapid Rise's cost, with no markup: it is never a customer's bill", () => {
  const cost = usageCost(
    { whatsapp_sent: 200, storage_bytes: 2_000_000_000 },
    { whatsapp_message_cents: 50, storage_gb_month_cents: 300, markup_bps: 3000 },
  );
  assert.equal(cost.whatsappCents, 10000);
  assert.equal(cost.storageCents, 600);
  assert.equal(cost.totalCents, 10600);
  // Decimal gigabytes, as the allowance counts (decision 14).
  assert.equal(cost.gigabytes, 2);
});

test("an unset rate costs nothing rather than guessing", () => {
  const cost = usageCost({ whatsapp_sent: 500, storage_bytes: 10_000_000_000 }, { whatsapp_message_cents: null, storage_gb_month_cents: null, markup_bps: 3000 });
  assert.equal(cost.totalCents, 0);
});

test("a month is read from what the page sends", () => {
  assert.equal(monthStart("2026-10"), "2026-10-01");
  assert.equal(monthStart("2026-13"), monthStart(null));
  assert.equal(monthStart("nonsense", new Date("2026-11-07T12:00:00Z")), "2026-11-01");
});
