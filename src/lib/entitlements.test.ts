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

import { t } from "@/lib/i18n";
import { FEATURE_MIN_PLAN, PLANS, planAllows, type Feature } from "./entitlements";

const FEATURES = Object.keys(FEATURE_MIN_PLAN) as Feature[];

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
