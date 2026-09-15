import assert from "node:assert/strict";
import test from "node:test";
import { dateTime, shortDate } from "./format";

// Run as a server would: Vercel formats in UTC. Without this the test passes on
// any machine that already sits in South Africa — which is the machine a
// developer here uses — so it would prove nothing. Node reads TZ when it
// formats, not when a module is imported, so setting it here still applies to
// the functions imported above. `node --test` runs each file in its own
// process, so this does not leak into other suites.
process.env.TZ = "UTC";

// 23:30 UTC on the 14th is 01:30 on the 15th in Johannesburg.
const INSTANT = "2026-09-14T23:30:00.000Z";

test("control: this process really is formatting in UTC", () => {
  const unpinned = new Date(INSTANT).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false });
  assert.equal(unpinned, "23:30");
});

test("a date is the South African calendar day, not the server's", () => {
  assert.match(shortDate(INSTANT, "en"), /\b15\b/);
  assert.doesNotMatch(shortDate(INSTANT, "en"), /\b14\b/);
});

test("a time is South African time, so server and browser render the same text", () => {
  const text = dateTime(INSTANT, "en");
  assert.match(text, /01:30/);
  assert.match(text, /\b15\b/);
});
