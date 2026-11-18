/**
 * The pooled storage allowance (decision 14) and the automatic-block ceiling (decision 34), in
 * TypeScript and in the database: the screen's figures must be the reserve's figures.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ceilingAllows, gigabytes, includedBytes, minimumCeilingCents, percentUsed, storageLevel, totalBytes,
} from "./storage-allowance";
import { STORAGE_BLOCK_BYTES, STORAGE_MIN_BYTES, STORAGE_PER_EQUIPMENT_SPACE_BYTES, STORAGE_PER_FULL_SPACE_BYTES } from "./limits";

const MIGRATION = readFileSync(
  join(import.meta.dirname, "../../supabase/migrations/20261118120000_pooled_storage.sql"), "utf8");

test("the founder's examples: 5 + 15 and 10 + 15 get the 2 GB minimum, 20 + 15 gets 2.375 GB", () => {
  assert.equal(includedBytes(5, 15), 2_000_000_000);
  assert.equal(includedBytes(10, 15), 2_000_000_000);
  assert.equal(includedBytes(20, 15), 2_375_000_000);
  assert.equal(gigabytes(includedBytes(20, 15)), 2.38);
});

test("included equipment spaces count, and blocks add 10 GB each", () => {
  // Essential: 2 included + 10 extra = 12 equipment spaces with 30 full spaces.
  assert.equal(includedBytes(30, 12), 3_300_000_000);
  assert.equal(includedBytes(30, 10), 3_250_000_000);
  assert.equal(totalBytes(5, 15, 2), 22_000_000_000);
  assert.equal(includedBytes(-3, Number.NaN), 2_000_000_000);
});

test("the same constants as the database", () => {
  assert.match(MIGRATION, new RegExp(`select greatest\\(${STORAGE_MIN_BYTES}::bigint,`));
  assert.match(MIGRATION, new RegExp(`::bigint \\* ${STORAGE_PER_FULL_SPACE_BYTES}\\n`));
  assert.match(MIGRATION, new RegExp(`::bigint \\* ${STORAGE_PER_EQUIPMENT_SPACE_BYTES}\\);`));
  assert.match(MIGRATION, new RegExp(`select ${STORAGE_BLOCK_BYTES}::bigint`));
  assert.match(MIGRATION, /when v_used \* 100 >= v_total \* 95 then '95'/);
  assert.match(MIGRATION, /when v_used \* 100 >= v_total \* 80 then '80'/);
  assert.match(MIGRATION, /if \(s\.storage_blocks \+ v_n\)::bigint \* v_price > st\.auto_ceiling_cents then/);
});

test("warning levels at 80% and 95%, full at the allowance", () => {
  assert.equal(storageLevel(1_599_999_999, 2_000_000_000), "ok");
  assert.equal(storageLevel(1_600_000_000, 2_000_000_000), "80");
  assert.equal(storageLevel(1_900_000_000, 2_000_000_000), "95");
  assert.equal(storageLevel(2_000_000_000, 2_000_000_000), "full");
  assert.equal(percentUsed(3_000_000_000, 2_000_000_000), 100);
  assert.equal(percentUsed(500_000_000, 2_000_000_000), 25);
});

test("a R98 ceiling allows two R49 blocks in total, held ones included", () => {
  assert.equal(ceilingAllows(0, 1, 4900, 9800), true);
  assert.equal(ceilingAllows(1, 1, 4900, 9800), true);
  assert.equal(ceilingAllows(2, 1, 4900, 9800), false);
  // A block bought by hand counts: with one held, R98 leaves room for exactly one more.
  assert.equal(ceilingAllows(1, 2, 4900, 9800), false);
  assert.equal(minimumCeilingCents(1, 4900), 9800);
  assert.equal(minimumCeilingCents(0, 4900), 4900);
});
