import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { limitsCatalogueMarkdown } from "./limits-catalogue";

test("the limits catalogue document is the limits table, regenerated (pnpm exec tsx scripts/limits_catalogue.ts)", () => {
  const doc = readFileSync("docs/final-dev/LIMITS-CATALOGUE.md", "utf8").replace(/\r\n/g, "\n");
  assert.equal(doc, limitsCatalogueMarkdown());
});
