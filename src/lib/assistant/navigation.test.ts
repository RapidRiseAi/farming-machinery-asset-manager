import assert from "node:assert/strict";
import test from "node:test";
import { assistantNavigationVisible } from "./navigation";

test("keeps Voice Assistant discoverable for an authorised selected farm", () => {
  assert.equal(
    assistantNavigationVisible({
      isWorkshop: false,
      isAdmin: false,
      currentFarmId: "aa000000-0000-0000-0000-000000000002",
      hasCurrentFarmRole: true,
    }),
    true,
  );
});

test("does not expose the farm assistant in the contractor shell", () => {
  assert.equal(
    assistantNavigationVisible({
      isWorkshop: true,
      isAdmin: false,
      currentFarmId: null,
      hasCurrentFarmRole: false,
    }),
    false,
  );
});

test("lets an RR admin discover the assistant before choosing support context", () => {
  assert.equal(
    assistantNavigationVisible({
      isWorkshop: false,
      isAdmin: true,
      currentFarmId: null,
      hasCurrentFarmRole: false,
    }),
    true,
  );
});

test("hides the assistant when an ordinary account has no valid farm context", () => {
  assert.equal(
    assistantNavigationVisible({
      isWorkshop: false,
      isAdmin: false,
      currentFarmId: null,
      hasCurrentFarmRole: false,
    }),
    false,
  );
});
