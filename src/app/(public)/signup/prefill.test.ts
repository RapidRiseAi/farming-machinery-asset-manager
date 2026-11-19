import assert from "node:assert/strict";
import { test } from "node:test";

import { signupPrefill } from "./prefill";

const SELLABLE = ["essential", "professional", "complete"] as const;

test("the website's choice carries into sign-up as a starting point", () => {
  assert.deepEqual(
    signupPrefill({ plan: "professional", period: "annual", vehicles: "10", equipment: "7" }, SELLABLE),
    { plan: "professional", period: "annual", vehicles: 10, equipment: 7 },
  );
  // Older website links carry no equipment: nothing is assumed.
  assert.deepEqual(signupPrefill({ plan: "complete", period: "monthly", vehicles: "12" }, SELLABLE),
    { plan: "complete", period: "monthly", vehicles: 12 });
  assert.deepEqual(signupPrefill({ equipment: "0" }, SELLABLE), { equipment: 0 });
});

test("anything unusable is dropped, never guessed or activated", () => {
  assert.deepEqual(signupPrefill({}, SELLABLE), {});
  assert.deepEqual(
    signupPrefill({ plan: "done_for_you", period: "weekly", vehicles: "0", equipment: "-1" }, SELLABLE),
    {},
    "a quote-only plan, an unknown period and out-of-range counts start from the defaults",
  );
  for (const bad of ["1.5", "1e3", " 5", "5 ", "abc", "", "0x10", "100000", "999999999999"]) {
    assert.equal(signupPrefill({ vehicles: bad }, SELLABLE).vehicles, undefined, `vehicles ${JSON.stringify(bad)}`);
    assert.equal(signupPrefill({ equipment: bad }, SELLABLE).equipment, undefined, `equipment ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(signupPrefill({ plan: ["complete", "essential"], vehicles: ["5", "6"] }, SELLABLE), {},
    "a repeated parameter is ambiguous, so it is dropped");
  assert.equal(signupPrefill({ vehicles: "10000" }, SELLABLE).vehicles, 10000);
  assert.equal(signupPrefill({ vehicles: "10001" }, SELLABLE).vehicles, undefined);
});
