import assert from "node:assert/strict";
import test from "node:test";

import { clientIp } from "./client-ip";

const h = (value?: string) => new Headers(value === undefined ? {} : { "x-forwarded-for": value });

test("the caller's IP is the first forwarded address", () => {
  assert.equal(clientIp(h("203.0.113.9, 10.0.0.1")), "203.0.113.9");
  assert.equal(clientIp(h(" 2001:db8::1 ")), "2001:db8::1");
});

test("no usable address is null, never a shared placeholder", () => {
  for (const value of [undefined, "", " , 10.0.0.1", "unknown", "<script>", "a".repeat(80)]) {
    assert.equal(clientIp(h(value)), null, String(value));
  }
});
