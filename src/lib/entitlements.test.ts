/**
 * What the sign-up comparison may claim.
 *
 * `/signup` ticks every plan × feature from `planAllows`, the same function every gate
 * calls, and labels each row with `signup.feat.<feature>`, a key built at RUNTIME. The
 * `i18n:keys` gate can only confirm that the `signup.feat` group exists, not that it holds
 * a label for every feature, so a feature added to `FEATURE_MIN_PLAN` without one would put
 * a raw key into the pricing table. These tests are the check that gate cannot make.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { t } from "@/lib/i18n";
import {
  CAPABILITY_MIN_PLAN,
  FEATURE_MIN_PLAN,
  NOT_YET_ADVERTISED,
  PLANS,
  PROFILE_REFUSES,
  assetAllows,
  planAllows,
  profileRefuses,
  type Capability,
  type Feature,
} from "./entitlements";

const FEATURES = Object.keys(FEATURE_MIN_PLAN) as Feature[];
const RANK = { essential: 1, professional: 2, complete: 3, done_for_you: 4 } as const;
// Every migration in order: the LATEST definition of a function is the one the database runs
// (the matrix began in 20261114090200; B5 added custom_fields in a later one).
const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const ALL_SQL = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8")).join("\n");

function sqlBody(fn: string): string {
  // The definition, not a later "revoke ... on function" or "comment on function" line.
  const start = Math.max(ALL_SQL.lastIndexOf(`create or replace function ${fn}(`), ALL_SQL.lastIndexOf(`create function ${fn}(`));
  assert.ok(start >= 0, `${fn} is not defined in any migration`);
  return ALL_SQL.slice(start, ALL_SQL.indexOf("$$;", start));
}

test("the plan part of the matrix is the database's app.feature_min_rank, key for key", () => {
  const ranks = new Map<string, number>();
  for (const m of sqlBody("app.feature_min_rank").matchAll(/when '([a-z_]+)'\s+then (\d)/g)) ranks.set(m[1], Number(m[2]));
  for (const [cap, plan] of Object.entries(CAPABILITY_MIN_PLAN)) {
    assert.equal(ranks.get(cap), RANK[plan], `${cap}: TS ${plan} (${RANK[plan]}), SQL ${ranks.get(cap)}`);
  }
  assert.deepEqual([...ranks.keys()].sort(), Object.keys(CAPABILITY_MIN_PLAN).sort(), "a key exists on one side only");
});

test("the profile part of the matrix is the database's app.profile_refuses", () => {
  const listed = [...sqlBody("app.profile_refuses").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((v) => v !== "equipment");
  assert.deepEqual([...listed].sort(), [...PROFILE_REFUSES.equipment].sort());
});

test("support equipment never gets a refused tool, even on Complete or Done-For-You", () => {
  for (const plan of PLANS) {
    for (const cap of PROFILE_REFUSES.equipment) {
      assert.equal(assetAllows(plan, "equipment", cap), false, `${plan} gave equipment ${cap}`);
    }
    // What equipment keeps on every plan.
    for (const cap of ["sale_warranty_packs", "general_chat"] as Capability[]) {
      assert.equal(assetAllows(plan, "equipment", cap), true, `${plan} took ${cap} from equipment`);
    }
  }
});

test("a full asset follows its plan: trips Professional, maps Complete, core records everywhere", () => {
  assert.equal(assetAllows("essential", "full", "trips"), false);
  assert.equal(assetAllows("essential", "full", "driving_log"), true);
  assert.equal(assetAllows("essential", "full", "finance_agreements"), true);
  assert.equal(assetAllows("essential", "full", "tyre_detail"), true);
  assert.equal(assetAllows("essential", "full", "tco"), false);
  assert.equal(assetAllows("professional", "full", "trips"), true);
  assert.equal(assetAllows("professional", "full", "budgets"), true);
  assert.equal(assetAllows("professional", "full", "depreciation"), true);
  assert.equal(assetAllows("professional", "full", "maps"), false);
  assert.equal(assetAllows("complete", "full", "maps"), true);
  // An unknown profile is never treated as equipment's cheaper set nor as a bypass.
  assert.equal(profileRefuses(null, "fuel"), false);
  assert.equal(profileRefuses("equipment", "fuel"), true);
});

test("a feature waiting for verification is gated but not on the comparison", () => {
  for (const f of NOT_YET_ADVERTISED) assert.ok(f in FEATURE_MIN_PLAN, `${f} is not a gated feature`);
  assert.ok(NOT_YET_ADVERTISED.includes("maps"));
});

test("every gated feature has a comparison label, in both languages", () => {
  for (const f of FEATURES) {
    const key = `signup.feat.${f}`;
    assert.notEqual(t(key, "en"), key, `${key} has no English label`);
    assert.notEqual(t(key, "af"), key, `${key} has no Afrikaans label`);
    assert.notEqual(t(key, "af"), t(key, "en"), `${key} is English copied into af.json`);
  }
});

test("the comparison reads as a staircase: what a plan unlocks, every plan above it keeps", () => {
  // The columns render in `PLANS` order, and every blurb says "everything in the plan
  // below, plus…". A plan that lost a feature its cheaper neighbour has would make both the
  // matrix and the blurbs untrue. A feature on no plan at all would be a row of dashes
  // advertising nothing.
  for (const f of FEATURES) {
    let unlocked = false;
    for (const p of PLANS) {
      const has = planAllows(p, f);
      if (unlocked) assert.ok(has, `${p} lacks ${f}, which a cheaper plan has`);
      unlocked ||= has;
    }
    assert.ok(unlocked, `${f} is unlocked by no plan`);
  }
});
