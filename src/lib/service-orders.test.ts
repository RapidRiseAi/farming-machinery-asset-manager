/**
 * The activation catalogue and the Done-For-You floors, in TypeScript and in the database: the
 * amount a screen shows must be the amount `app.service_order_price` and `public.dfy_offer` hold.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  SERVICE_CATALOGUE, dfyMinimumFloorCents, dfyPeriodTotal, dfyPriceRefusal, dfySpaceFloorCents, isServiceCode,
  quantityLabel, servicePrice, type CatalogueRule, type ServiceCode,
} from "./service-orders";

const MIGRATION = readFileSync(
  join(import.meta.dirname, "../../supabase/migrations/20261120100000_service_orders.sql"), "utf8");

const rule = (code: ServiceCode): CatalogueRule => {
  const found = SERVICE_CATALOGUE.find((r) => r.code === code);
  if (!found) throw new Error(code);
  return found;
};

test("per-asset services charge their minimum below it and the rate above it", () => {
  assert.deepEqual(servicePrice(rule("clean_setup"), 3, null, 0), { ok: true, cents: 75000 });
  assert.deepEqual(servicePrice(rule("clean_setup"), 5, null, 0), { ok: true, cents: 75000 });
  assert.deepEqual(servicePrice(rule("clean_setup"), 6, null, 0), { ok: true, cents: 90000 });
  assert.deepEqual(servicePrice(rule("document_capture"), 4, null, 0), { ok: true, cents: 150000 });
  assert.deepEqual(servicePrice(rule("document_capture"), 6, null, 0), { ok: true, cents: 180000 });
  assert.deepEqual(servicePrice(rule("clean_setup"), 2.5, null, 0), { ok: false, code: "service-below-minimum" });
});

test("hourly work is quarter hours; on-site training is at least R3,500 plus the agreed travel", () => {
  assert.deepEqual(servicePrice(rule("historical_work"), 1.5, null, 0), { ok: true, cents: 75000 });
  assert.deepEqual(servicePrice(rule("remote_training"), 0.25, null, 0), { ok: true, cents: 12500 });
  assert.deepEqual(servicePrice(rule("historical_work"), 1.3, null, 0), { ok: false, code: "service-invalid" });
  assert.deepEqual(servicePrice(rule("onsite_training"), 1, 350000, 80000), { ok: true, cents: 430000 });
  assert.deepEqual(servicePrice(rule("onsite_training"), 1, 349999, 0), { ok: false, code: "service-below-minimum" });
  assert.deepEqual(servicePrice(rule("onsite_training"), 2, 700000, 0), { ok: false, code: "service-below-minimum" });
  assert.deepEqual(servicePrice(rule("clean_setup"), 5, null, 100), { ok: false, code: "service-invalid" });
});

test("QR kits need ten and a supplier quote", () => {
  assert.equal(rule("qr_kits").requiresSupplierQuote, true);
  assert.deepEqual(servicePrice(rule("qr_kits"), 9, null, 0), { ok: false, code: "service-below-minimum" });
  assert.deepEqual(servicePrice(rule("qr_kits"), 10, null, 0), { ok: true, cents: 45000 });
});

test("clean setup and document capture share one work group, so they are never stacked", () => {
  assert.equal(rule("clean_setup").workGroup, "setup");
  assert.equal(rule("document_capture").workGroup, "setup");
  assert.equal(SERVICE_CATALOGUE.filter((r) => r.workGroup !== null).length, 2);
  assert.ok(isServiceCode("qr_kits"));
  assert.ok(!isServiceCode("onboarding"));
});

test("every catalogue row here is the migration's seed row", () => {
  for (const r of SERVICE_CATALOGUE) {
    const row = new RegExp(
      `\\('${r.code}',[^;]*?\\n\\s*(\\d+), '(\\w+)', (null|\\d+), (null|\\d+), (null|'\\w+'),[\\s\\S]*?\\n\\s*(true|false), (true|false), \\d+\\)`,
    ).exec(MIGRATION);
    assert.ok(row, `no seed row for ${r.code}`);
    const [, unit, pricing, minimum, minQty, group, supplier] = row;
    assert.equal(Number(unit), r.unitCents, `${r.code} unit`);
    assert.equal(pricing, r.pricing, `${r.code} pricing`);
    assert.equal(minimum === "null" ? null : Number(minimum), r.minimumCents, `${r.code} minimum`);
    assert.equal(minQty === "null" ? null : Number(minQty), r.minQuantity, `${r.code} minimum quantity`);
    assert.equal(group === "null" ? null : group.replace(/'/g, ""), r.workGroup, `${r.code} work group`);
    assert.equal(supplier === "true", r.requiresSupplierQuote, `${r.code} supplier quote`);
  }
  // QR kits are seeded not ready.
  assert.match(MIGRATION, /'qr_kits',[\s\S]*?\n\s*true, false, 100\)/);
});

test("the Done-For-You floors are the migration's", () => {
  assert.equal(dfySpaceFloorCents("monthly"), 17000);
  assert.equal(dfySpaceFloorCents("annual"), 204000);
  assert.equal(dfyMinimumFloorCents("monthly"), 250000);
  assert.equal(dfyMinimumFloorCents("annual"), 3000000);
  assert.match(MIGRATION, /select case when p_period = 'annual' then 12 \* 17000 else 17000 end::bigint;/);
  assert.match(MIGRATION, /select case when p_period = 'annual' then 12 \* 250000 else 250000 end::bigint;/);
});

test("a managed quote: the R2,500 minimum, R170 a space, equipment never at the software rate", () => {
  const base = { period: "monthly" as const, spaceCents: 17000, minSpaces: 15, equipmentIncluded: 5, equipmentCents: 17000 };
  assert.equal(dfyPriceRefusal(base), null);
  assert.equal(dfyPriceRefusal({ ...base, minSpaces: 14 }), "service-below-minimum");
  assert.equal(dfyPriceRefusal({ ...base, spaceCents: 16999, minSpaces: 20 }), "service-below-minimum");
  assert.equal(dfyPriceRefusal({ ...base, equipmentCents: 1500 }), "service-below-minimum");
  assert.equal(dfyPriceRefusal({ ...base, spaceCents: 25000, minSpaces: 10 }), null);
  assert.equal(dfyPriceRefusal({ ...base, period: "annual", spaceCents: 170000, equipmentCents: 204000 }), "service-below-minimum");
  assert.equal(dfyPriceRefusal({ ...base, period: "annual", spaceCents: 204000, equipmentCents: 204000 }), null);
  // 20 full and 8 equipment on R170, 15 minimum, 5 equipment included: R3,910.
  assert.equal(dfyPeriodTotal(base, 20, 8), 391000);
  // Below the minimum, the minimum is billed.
  assert.equal(dfyPeriodTotal(base, 3, 0), 255000);
});

test("quantities read as people write them", () => {
  assert.equal(quantityLabel(12), "12");
  assert.equal(quantityLabel(1.5), "1.5");
  assert.equal(quantityLabel(0.25), "0.25");
});
