import { test } from "node:test";
import assert from "node:assert/strict";
import { asError, createSingleFlight, isNavigationSignal } from "./single-flight";
import { createReportGate, shouldReport } from "./client-error-filter";

test("taps while the work is running are ignored, and it runs once", async () => {
  let runs = 0;
  let release!: () => void;
  const flight = createSingleFlight(async () => {
    runs += 1;
    await new Promise<void>((resolve) => (release = resolve));
  });
  const first = flight.run();
  // Five more taps before the first answer comes back.
  const repeats = await Promise.all([flight.run(), flight.run(), flight.run(), flight.run(), flight.run()]);
  assert.deepEqual(repeats, [false, false, false, false, false]);
  assert.equal(flight.running, true);
  release();
  assert.equal(await first, true);
  assert.equal(runs, 1);
  assert.equal(flight.running, false);
});

test("after a run finishes, the next tap runs again", async () => {
  let runs = 0;
  const flight = createSingleFlight(async () => {
    runs += 1;
  });
  await flight.run();
  await flight.run();
  assert.equal(runs, 2);
});

test("a failed run releases the lock, so the person can try again", async () => {
  let attempts = 0;
  const flight = createSingleFlight(async () => {
    attempts += 1;
    throw new Error("no signal");
  });
  await assert.rejects(flight.run(), /no signal/);
  assert.equal(flight.running, false);
  await assert.rejects(flight.run(), /no signal/);
  assert.equal(attempts, 2);
});

test("Next's redirect and not-found signals are navigation, not failure", () => {
  assert.equal(isNavigationSignal({ digest: "NEXT_REDIRECT;replace;/jobcards;307;" }), true);
  assert.equal(isNavigationSignal({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" }), true);
  assert.equal(isNavigationSignal(new Error("boom")), false);
  assert.equal(isNavigationSignal(null), false);
  assert.equal(isNavigationSignal({ digest: 42 }), false);
});

test("anything thrown becomes an Error with a message", () => {
  assert.equal(asError(new TypeError("x")).message, "x");
  assert.equal(asError("plain").message, "plain");
  assert.equal(asError({ code: "42501" }).message, '{"code":"42501"}');
  assert.equal(asError(undefined).message, "undefined");
});

test("our errors are reported; browser and extension noise is not", () => {
  assert.equal(shouldReport({ message: "Cannot read properties of undefined (reading 'id')", stack: "at x (https://app/_next/static/chunks/1.js:1:2)" }), true);
  assert.equal(shouldReport({ message: "ChunkLoadError: Loading chunk 77 failed." }), true);
  assert.equal(shouldReport({ message: "ResizeObserver loop completed with undelivered notifications." }), false);
  assert.equal(shouldReport({ message: "Script error." }), false);
  assert.equal(shouldReport({ message: "", stack: "" }), false);
  assert.equal(shouldReport({ message: "x", name: "AbortError" }), false);
  assert.equal(shouldReport({ message: "x", digest: "NEXT_REDIRECT;push;/login;307;" }), false);
  assert.equal(shouldReport({ message: "x", source: "chrome-extension://abc/content.js" }), false);
  assert.equal(shouldReport({ message: "x", stack: "at y (chrome-extension://abc/inject.js:1:1)" }), false);
  // An extension frame inside our own stack is still our error.
  assert.equal(shouldReport({ message: "x", stack: "at a (https://app/_next/static/c.js:1:1)\nat b (chrome-extension://abc/i.js:1:1)" }), true);
});

test("each distinct error is reported once, and a page sends at most the limit", () => {
  const gate = createReportGate(3);
  const e = (message: string) => ({ message, stack: `Error: ${message}\n    at f (https://app/_next/a.js:1:1)` });
  assert.equal(gate(e("a")), true);
  assert.equal(gate(e("a")), false);
  assert.equal(gate(e("b")), true);
  assert.equal(gate(e("c")), true);
  assert.equal(gate(e("d")), false);
});

test("a dropped connection is told apart from a refusal", async () => {
  const { isConnectionFailure } = await import("./single-flight");
  assert.equal(isConnectionFailure(new TypeError("Failed to fetch")), true);
  assert.equal(isConnectionFailure(new TypeError("NetworkError when attempting to fetch resource.")), true);
  assert.equal(isConnectionFailure(new TypeError("Load failed")), true);
  assert.equal(isConnectionFailure(new Error("fetch failed")), true);
  assert.equal(isConnectionFailure(new Error("Cannot read properties of undefined")), false);
  assert.equal(isConnectionFailure("Failed to fetch"), false);
  // The browser saying it is offline settles it whatever the message.
  assert.equal(isConnectionFailure(new Error("anything"), false), true);
});
