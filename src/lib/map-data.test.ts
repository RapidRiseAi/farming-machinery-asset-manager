import { test } from "node:test";
import assert from "node:assert/strict";

import { boundsOf, cleanPoints, lastSeen, routeKm, routeLine } from "./map-data";

test("each vehicle shows where it was last", () => {
  const seen = lastSeen([
    { machineId: "a", lat: 1, lng: 1, at: "2026-11-01T08:00:00Z" },
    { machineId: "a", lat: 2, lng: 2, at: "2026-11-01T09:00:00Z" },
    { machineId: "b", lat: 3, lng: 3, at: "2026-11-01T07:00:00Z" },
  ]);
  assert.equal(seen.length, 2);
  assert.equal(seen.find((p) => p.machineId === "a")?.lat, 2);
});

test("a route runs in time order, and leaves out points with no real position", () => {
  assert.deepEqual(
    routeLine([
      { lat: 2, lng: 20, at: "2026-11-01T09:00:00Z" },
      { lat: 0, lng: 0, at: "2026-11-01T08:30:00Z" },
      { lat: 1, lng: 10, at: "2026-11-01T08:00:00Z" },
    ]),
    [[10, 1], [20, 2]],
  );
});

test("nothing to show has no box around it", () => {
  assert.equal(boundsOf([]), null);
  assert.deepEqual(boundsOf([{ lat: -25, lng: 28 }, { lat: -26, lng: 29 }]), [[28, -26], [29, -25]]);
});

test("a route's length is about right", () => {
  const pretoriaToJoburg: [number, number][] = [[28.19, -25.75], [28.05, -26.2]];
  const km = routeKm(pretoriaToJoburg);
  assert.ok(km > 48 && km < 56, String(km));
  assert.equal(routeKm([]), 0);
});

test("a phone can only send real positions at believable times", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  const good = { lat: -25.7, lng: 28.2, at: "2026-11-07T11:59:00Z", speed: 60, accuracy: 8 };
  assert.deepEqual(cleanPoints([good], now), [{ ...good, at: "2026-11-07T11:59:00.000Z" }]);
  assert.deepEqual(cleanPoints([{ ...good, lat: 91 }], now), []);
  assert.deepEqual(cleanPoints([{ ...good, at: "2026-11-09T00:00:00Z" }], now), []);
  assert.deepEqual(cleanPoints([{ ...good, at: "2026-10-01T00:00:00Z" }], now), []);
  assert.deepEqual(cleanPoints([{ ...good, at: "not a date" }], now), []);
  assert.deepEqual(cleanPoints("nonsense", now), []);
  assert.equal(cleanPoints([{ ...good, speed: -1 }], now)[0].speed, null);
});

test("one request cannot carry an endless list", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  const many = Array.from({ length: 500 }, () => ({ lat: 1, lng: 1, at: "2026-11-07T11:00:00Z" }));
  assert.equal(cleanPoints(many, now).length, 200);
});
