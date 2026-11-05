import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src/app/api/farm/export/route.ts"), "utf8");

test("the farm export includes the finance and lease records (permanent closure depends on it)", () => {
  for (const table of ["finance_agreements", "finance_instalments", "asset_contracts", "incidents", "tyres", "fines", "attachments"]) {
    assert.ok(source.includes(`name: "${table}"`), `${table} is missing from the export`);
  }
});

test("the farm export streams instead of building one string, and fails loudly rather than truncating", () => {
  assert.ok(source.includes("new ReadableStream"), "the export must stream");
  assert.ok(!source.includes("JSON.stringify(body, null, 2)"), "the whole bundle must not be built in memory");
  assert.ok(source.includes("controller.error(failure)"), "a failure must error the stream, not end it cleanly");
});
