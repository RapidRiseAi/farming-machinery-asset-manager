import { test } from "node:test";
import assert from "node:assert/strict";

import { boundsOf, cleanPoints, lastSeen, routeKm, routeLine, routeSegments, segmentsKm, positionFreshness } from "./map-data";
import { offRouteSegments } from "./routing/geometry";

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

test("a position is recent only within the window; older is the last known position, never current", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const tenMinutes = 10 * 60 * 1000;
  assert.deepEqual(positionFreshness("2026-11-18T11:55:00Z", now, tenMinutes), { recent: true, ageMs: 5 * 60 * 1000 });
  assert.equal(positionFreshness("2026-11-18T11:50:00Z", now, tenMinutes).recent, true);
  assert.equal(positionFreshness("2026-11-18T11:49:59Z", now, tenMinutes).recent, false);
  assert.equal(positionFreshness("2026-11-17T12:00:00Z", now, tenMinutes).ageMs, 24 * 60 * 60 * 1000);
  // A wrong clock in the future is "just now", not a negative age; garbage is never recent.
  assert.deepEqual(positionFreshness("2026-11-18T12:30:00Z", now, tenMinutes), { recent: true, ageMs: 0 });
  assert.equal(positionFreshness("not a date", now, tenMinutes).recent, false);
});

// == Gaps (B6): nothing is drawn or counted across a gap in the recording ==================
const at = (minute: number) => new Date(Date.UTC(2026, 10, 19, 8, 0) + minute * 60_000).toISOString();
// About 1 km apart going north (0.009 degrees of latitude), one a minute: 60 km/h.
const drive = (from: number, n: number, startMinute: number, lng = 28.2) =>
  Array.from({ length: n }, (_, i) => ({ lat: -25.7 + (from + i) * 0.009, lng, at: at(startMinute + i) }));

test("a continuous drive is one piece", () => {
  const pieces = routeSegments(drive(0, 5, 0));
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].length, 5);
});

test("a long silence splits the route, and the distance across it is not counted", () => {
  // Four minutes driven, 30 minutes of nothing (screen locked, no signal), four more minutes 50 km on.
  const points = [...drive(0, 5, 0), ...drive(55, 5, 34)];
  const pieces = routeSegments(points);
  assert.equal(pieces.length, 2);
  const joinedKm = routeKm(routeLine(points));
  const counted = segmentsKm(pieces);
  assert.ok(counted < 10 && joinedKm > 50, `counted ${counted}, joined ${joinedKm}`);
});

test("an impossible jump is a gap even when the clock says only a minute passed", () => {
  const points = [...drive(0, 3, 0), { lat: -25.7 + 100 * 0.009, lng: 28.2, at: at(3) }, ...drive(101, 3, 4)];
  const pieces = routeSegments(points);
  assert.equal(pieces.length, 2, "the 88 km step in a minute is not driven");
  assert.ok(segmentsKm(pieces) < 6);
});

test("a single stray position is not a piece, and points arrive in any order", () => {
  const points = [...drive(0, 3, 0), { lat: -24, lng: 29, at: at(60) }, ...drive(0, 3, 120)].reverse();
  const pieces = routeSegments(points);
  assert.equal(pieces.length, 2);
  assert.ok(pieces.every((p) => p.length === 3));
  assert.deepEqual(routeSegments([]), []);
  assert.deepEqual(routeSegments([{ lat: 0, lng: 0, at: at(0) }, { lat: 0, lng: 0, at: at(1) }]), []);
});

test("off the plan is measured piece by piece, never along the line across a gap", () => {
  const planned: [number, number][] = [[28.2, -25.7], [28.2, -25.0]];
  // Two pieces on the planned road with a gap between them: nothing off route.
  const pieces = routeSegments([...drive(0, 4, 0), ...drive(40, 4, 40)]);
  const result = offRouteSegments(planned, pieces);
  assert.ok(result && result.offKm === 0 && result.share === 0);
  // A piece 10 km east of the road is all off.
  const away = offRouteSegments(planned, routeSegments(drive(0, 4, 0, 28.3)));
  assert.ok(away && away.share > 0.9);
  assert.equal(offRouteSegments(planned, []), null);
});
