/**
 * Every server action that acts on a farm passes the stop gate, checked across the tree.
 *
 * A server action is an endpoint: a tab opened before a farm was paused, or a direct POST,
 * reaches it without the (app) layout's billing gate ever running. The role helpers
 * (requireRole, requireFarmRole, requireApiRole, requireFarmPermission) ask the gate
 * themselves; an action with a guard of its own must call requireUsableFarm (or
 * farmIsUsable). This keeps the next action file from quietly going back to requireProfile
 * alone, which is how a paused farm could still invite people and record finance.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";

const SRC = join(process.cwd(), "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

/**
 * Action files a stopped farm, or nobody's farm, must still reach. Each says why; a new
 * entry needs the same.
 */
const OPEN_ON_PURPOSE: Record<string, string> = {
  "app/(auth)/activate/actions.ts": "the pay screen of a farm that has not paid yet",
  "app/(auth)/suspended/actions.ts": "the pay screen of a paused farm",
  "app/(auth)/closed/actions.ts": "reopening a closed farm",
  "app/(app)/billing/actions.ts": "billing itself: paying, the card, and the cancel rules in setCancellation",
  "app/(app)/help/actions.ts": "a paused farm can still ask Rapid Rise for help",
  "app/(app)/account/actions.ts": "the person's own account (language, password), not farm data",
  "app/(app)/notifications/actions.ts": "the person's own notifications",
  "app/(app)/admin/ai/actions.ts": "Rapid Rise only (requireRrAdmin)",
  "app/(app)/admin/billing/actions.ts": "Rapid Rise only (requireRrAdmin)",
};

const GATED = /\b(requireRole|requireFarmRole|requireCurrentFarmRole|requireApiRole|requireFarmPermission|requireUsableFarm|farmIsUsable)\(/;

test("every server action that authorises with requireProfile also passes the stop gate", () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!/^\s*["']use server["'];?/m.test(text)) continue;
    if (!/\brequireProfile\(/.test(text)) continue;
    const key = relative(SRC, file).split(sep).join("/");
    if (key in OPEN_ON_PURPOSE) continue;
    if (!GATED.test(text)) offenders.push(key);
  }
  assert.deepEqual(
    offenders,
    [],
    `server actions with requireProfile and no stop gate (add requireUsableFarm, or list them in OPEN_ON_PURPOSE with a reason): ${offenders.join(", ")}`,
  );
});

test("every file listed as open on purpose still exists and is still a server action", () => {
  for (const key of Object.keys(OPEN_ON_PURPOSE)) {
    const text = readFileSync(join(SRC, ...key.split("/")), "utf8");
    assert.match(text, /^\s*["']use server["'];?/m, `${key} is no longer a server action file`);
  }
});
