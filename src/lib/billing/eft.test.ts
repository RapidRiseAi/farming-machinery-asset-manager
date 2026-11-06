/**
 * Rapid Rise's bank details appear only where money is owed to Rapid Rise. A workshop's
 * invoice to a farm is paid to the workshop: if these details reached it, a customer's money
 * would go to the wrong business. So this is a list, and a new reader must be added to it
 * on purpose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const ALLOWED = new Set([
  "lib/billing/eft.ts",
  // Rapid Rise's console, where they are set.
  "app/(app)/admin/billing/actions.ts",
  "app/(app)/admin/billing/page.tsx",
  // A bill owed to Rapid Rise: the first payment, the billing page, a paused farm, the PDF.
  "app/(auth)/activate/page.tsx",
  "app/(app)/billing/page.tsx",
  "app/(auth)/suspended/page.tsx",
  "app/api/billing/invoice/[id]/invoice.pdf/route.ts",
]);

const readers = () =>
  sources(SRC)
    .filter((path) => /rapidRiseEft|eft_instructions/.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path).split(sep).join("/"));

test("only the pages that collect Rapid Rise's own bills read its bank details", () => {
  assert.deepEqual(readers().filter((path) => !ALLOWED.has(path)), []);
});

test("every allowed reader still exists, so the list cannot go stale", () => {
  assert.deepEqual([...ALLOWED].filter((path) => !readers().includes(path)), []);
});

test("nothing a workshop sends its customers carries them", () => {
  const partner = /partner|statement|document-email|supplier|\(public\)|contractor/;
  assert.deepEqual([...ALLOWED].filter((path) => partner.test(path)), []);
});
