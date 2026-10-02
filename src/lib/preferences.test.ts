import test from "node:test";
import assert from "node:assert/strict";

import { MAX_TABS, destinationsFor, parseTabs, resolveStartPath } from "./preferences";

test("an operator is never offered the dashboard or the inbox", () => {
  const hrefs = destinationsFor("operator", "complete").map((d) => d.href);
  assert.ok(hrefs.includes("/driver"));
  assert.ok(!hrefs.includes("/dashboard"));
  assert.ok(!hrefs.includes("/inbox"));
});

test("plan-gated screens drop off a plan that does not unlock them", () => {
  const essential = destinationsFor("owner", "essential").map((d) => d.href);
  assert.ok(!essential.includes("/dashboard"));
  assert.ok(!essential.includes("/fuel"));
  assert.ok(!essential.includes("/reports"));
  const pro = destinationsFor("owner", "professional").map((d) => d.href);
  assert.ok(pro.includes("/dashboard"));
  assert.ok(pro.includes("/fuel"));
});

test("a stored start page is used only while it is still allowed", () => {
  const allowed = destinationsFor("operator", null);
  assert.equal(resolveStartPath("/faults", allowed, "/driver"), "/faults");
  // Promoted away from the page, or a hand-edited cookie: back to the role's home.
  assert.equal(resolveStartPath("/settings", allowed, "/driver"), "/driver");
  assert.equal(resolveStartPath("https://evil.example", allowed, "/driver"), "/driver");
  assert.equal(resolveStartPath(undefined, allowed, "/driver"), "/driver");
});

test("phone shortcuts keep order, drop repeats and strangers, and cap at three", () => {
  const allowed = destinationsFor("owner", null);
  assert.deepEqual(parseTabs("/fuel, /machines,/fuel,/nope,/inbox,/parts", allowed), [
    "/fuel",
    "/machines",
    "/inbox",
  ]);
  assert.equal(parseTabs("/a,/b", allowed).length, 0);
  assert.equal(parseTabs("", allowed).length, 0);
  assert.equal(MAX_TABS, 3);
});
