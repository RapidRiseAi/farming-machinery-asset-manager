import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { EXTRA_EQUIPMENT_CENTS, MIN_FULL_SPACES, SELF_SERVICE_MAX_FULL_SPACES } from "@/lib/billing/calculator";
import { FEATURE_MIN_PLAN, NOT_YET_ADVERTISED, PLAN_PRICING } from "@/lib/entitlements";
import {
  PDF_MAX_BYTES, PHOTO_MAX_BYTES, STORAGE_BLOCK_BYTES, STORAGE_MIN_BYTES, STORAGE_PER_EQUIPMENT_SPACE_BYTES,
  STORAGE_PER_FULL_SPACE_BYTES, VOICE_NOTE_MAX_BYTES, VOICE_NOTE_MAX_MS, WHATSAPP_IMAGE_MAX_BYTES,
  WHATSAPP_VOICE_MAX_BYTES, WHATSAPP_VOICE_MAX_MS,
} from "@/lib/limits";
import { SERVICE_CATALOGUE, dfyMinimumFloorCents, dfySpaceFloorCents } from "@/lib/service-orders";

/**
 * docs/commercial-source.json is the one dated statement of what FLEETWISE costs and limits
 * (task A5): the website, the plan review PDF and the help pages are written from it. This
 * test fails the moment it and the code that charges or enforces disagree.
 */
const source = JSON.parse(readFileSync("docs/commercial-source.json", "utf8"));
const migrations = readdirSync("supabase/migrations").sort().map((f) => readFileSync(join("supabase/migrations", f), "utf8")).join("\n");
const rand = (cents: number | null) => (cents === null ? null : cents / 100);

test("the source is dated and names the price list it describes", () => {
  assert.match(source.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(migrations.includes(`'${source.priceList}'`), "the price list exists in the migrations");
});

test("plan prices, the minimum, the online limit and extra equipment match the calculator", () => {
  for (const [plan, row] of Object.entries(source.plans) as [keyof typeof PLAN_PRICING, Record<string, number>][]) {
    assert.equal(row.monthlyPerFullSpace, rand(PLAN_PRICING[plan].perVehicleMonthlyCents), plan);
    assert.equal(row.annualPerFullSpace, rand(PLAN_PRICING[plan].perVehicleAnnualCents), plan);
    assert.equal(row.includedEquipment, PLAN_PRICING[plan].includedEquipment, plan);
  }
  assert.equal(source.minFullSpaces, MIN_FULL_SPACES);
  assert.equal(source.selfServiceMaxFullSpaces, SELF_SERVICE_MAX_FULL_SPACES);
  assert.equal(source.extraEquipment.monthly, rand(EXTRA_EQUIPMENT_CENTS.monthly));
  assert.equal(source.extraEquipment.annual, rand(EXTRA_EQUIPMENT_CENTS.annual));
});

test("storage and media limits match the limits catalogue and the storage block price", () => {
  assert.equal(source.storage.minBytes, STORAGE_MIN_BYTES);
  assert.equal(source.storage.perFullSpaceBytes, STORAGE_PER_FULL_SPACE_BYTES);
  assert.equal(source.storage.perEquipmentSpaceBytes, STORAGE_PER_EQUIPMENT_SPACE_BYTES);
  assert.equal(source.storage.blockBytes, STORAGE_BLOCK_BYTES);
  assert.match(migrations, new RegExp(`storage_block_monthly_incl_cents bigint not null default ${source.storage.blockMonthly * 100}\\b`));
  assert.equal(source.media.photoMaxBytes, PHOTO_MAX_BYTES);
  assert.equal(source.media.pdfMaxBytes, PDF_MAX_BYTES);
  assert.equal(source.media.voiceNoteMaxMinutes * 60_000, VOICE_NOTE_MAX_MS);
  assert.equal(source.media.voiceNoteMaxBytes, VOICE_NOTE_MAX_BYTES);
  assert.equal(source.media.whatsappImageMaxBytes, WHATSAPP_IMAGE_MAX_BYTES);
  assert.equal(source.media.whatsappVoiceMaxBytes, WHATSAPP_VOICE_MAX_BYTES);
  assert.equal(source.media.whatsappVoiceMaxMinutes * 60_000, WHATSAPP_VOICE_MAX_MS);
});

test("the usage margin matches the rates table's default", () => {
  assert.match(migrations, new RegExp(`markup_bps\\s+integer not null default ${source.usageMarkupPercent * 100}\\b`));
});

test("what each plan includes matches the gates, and nothing gated is advertised as ready", () => {
  assert.deepEqual(source.featureMinPlan, FEATURE_MIN_PLAN);
  for (const feature of NOT_YET_ADVERTISED) assert.ok(source.notYetAvailable.includes(feature), feature);
  // Every readiness flag the migrations create unreleased is listed as not yet available.
  for (const flag of ["general_chat", "whatsapp_photos", "whatsapp_voice"]) {
    assert.ok(source.notYetAvailable.includes(flag), flag);
    const released = new RegExp(`\\('${flag}',[^)]*,\\s*true\\)`);
    assert.ok(!released.test(migrations), `${flag} is created released, so it should not be listed as not yet available`);
  }
});

test("Done-For-You floors and the optional services match the service rules", () => {
  assert.equal(source.doneForYou.fromPerAssetMonthly, rand(dfySpaceFloorCents("monthly")));
  assert.equal(source.doneForYou.minimumCustomerMonthly, rand(dfyMinimumFloorCents("monthly")));
  const rule = (code: string) => SERVICE_CATALOGUE.find((r) => r.code === code)!;
  assert.equal(source.optionalServices.clean_setup.perAsset, rand(rule("clean_setup").unitCents));
  assert.equal(source.optionalServices.clean_setup.minimum, rand(rule("clean_setup").minimumCents));
  assert.equal(source.optionalServices.document_capture.perAsset, rand(rule("document_capture").unitCents));
  assert.equal(source.optionalServices.document_capture.minimum, rand(rule("document_capture").minimumCents));
  assert.equal(source.optionalServices.historical_work.perHour, rand(rule("historical_work").unitCents));
  assert.equal(source.optionalServices.remote_training.perHour, rand(rule("remote_training").unitCents));
  assert.equal(source.optionalServices.onsite_training.from, rand(rule("onsite_training").unitCents));
  assert.equal(source.optionalServices.qr_kits.perAsset, rand(rule("qr_kits").unitCents));
  assert.equal(source.optionalServices.qr_kits.minQuantity, rule("qr_kits").minQuantity);
  assert.equal(source.optionalServices.qr_kits.needsSupplierQuote, rule("qr_kits").requiresSupplierQuote);
});
