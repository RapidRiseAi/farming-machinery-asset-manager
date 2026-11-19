import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// The restore drill never runs against production and never pretends to pass (A6, scenario 39).
function drill(env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RESTORE_") && k !== "RCLONE_CONFIG"));
  return spawnSync(process.execPath, ["scripts/restore_drill.mjs"], { env: { ...clean, ...env }, encoding: "utf8" });
}

test("aimed at the production project, the drill refuses before reading anything", () => {
  const run = drill({ RESTORE_SUPABASE_URL: "https://nmqtcvdwtyggxjjgtnzm.supabase.co", RESTORE_SERVICE_ROLE_KEY: "not-a-key" });
  assert.equal(run.status, 3);
  assert.match(run.stdout, /REFUSED/);
});

test("without the restored project and the offsite copy it says what is missing and exits as blocked", () => {
  const run = drill({});
  assert.equal(run.status, 2);
  assert.match(run.stdout, /BLOCKED/);
  assert.match(run.stdout, /RESTORE_SUPABASE_URL/);
  assert.match(run.stdout, /RCLONE_CONFIG/);
  assert.doesNotMatch(run.stdout, /PASS/);
});
