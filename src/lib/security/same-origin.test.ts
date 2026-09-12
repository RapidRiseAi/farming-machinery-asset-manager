import assert from "node:assert/strict";
import test from "node:test";
import { sameOrigin } from "./same-origin";

const request = (headers: HeadersInit = {}, url = "https://fleetwise.test/api/faults") =>
  new Request(url, { method: "POST", headers });

test("accepts an exact browser origin", () => {
  assert.equal(
    sameOrigin(request({ origin: "https://fleetwise.test", "sec-fetch-site": "same-origin" })),
    true,
  );
});

test("rejects cross-origin and same-site sibling requests", () => {
  assert.equal(
    sameOrigin(request({ origin: "https://evil.test", "sec-fetch-site": "cross-site" })),
    false,
  );
  assert.equal(
    sameOrigin(request({ origin: "https://admin.fleetwise.test", "sec-fetch-site": "same-site" })),
    false,
  );
});

test("an Origin mismatch cannot be overridden by forged fetch metadata", () => {
  assert.equal(
    sameOrigin(request({ origin: "https://evil.test", "sec-fetch-site": "same-origin" })),
    false,
  );
});

test("fails closed without browser provenance and allows explicit same-origin metadata", () => {
  assert.equal(sameOrigin(request()), false);
  assert.equal(sameOrigin(request({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(sameOrigin(request({ origin: "null" })), false);
});

test("normalizes default ports but rejects malformed Origin values", () => {
  assert.equal(sameOrigin(request({ origin: "https://fleetwise.test:443" })), true);
  assert.equal(sameOrigin(request({ origin: "https://fleetwise.test/path" })), false);
});
