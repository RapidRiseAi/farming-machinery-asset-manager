/**
 * Every SQL test file runs in CI.
 *
 * supabase/tests/run.sh names each file it runs. A file written but never named there runs
 * nowhere and fails nothing: trip_routes.sql (route planning, tracker positions and route
 * counting) sat outside the suite from the day it was written until 11 November 2026.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const DIR = join(process.cwd(), "supabase", "tests");

export function filesNotRun(runner: string, files: string[]): string[] {
  return files.filter((f) => f.endsWith(".sql") && !runner.includes(`supabase/tests/${f}`));
}

test("the check finds a file the runner does not name", () => {
  const runner = 'pg "$DB" < "$ROOT/supabase/tests/trips.sql"\n';
  assert.deepEqual(filesNotRun(runner, ["trips.sql", "trip_routes.sql", "run.sh"]), ["trip_routes.sql"]);
});

test("supabase/tests/run.sh runs every SQL test file", () => {
  const runner = readFileSync(join(DIR, "run.sh"), "utf8");
  assert.deepEqual(filesNotRun(runner, readdirSync(DIR)), [], "add each file to supabase/tests/run.sh");
});
