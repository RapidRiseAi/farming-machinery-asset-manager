import test from "node:test";
import assert from "node:assert/strict";
import { stopVisits, type DrivingEvent } from "./driving";
const event = (
  kind: DrivingEvent["kind"],
  time: string,
  location: string | null = null,
): DrivingEvent => ({
  id: time,
  session_id: "session",
  kind,
  occurred_at: `2026-10-03T${time}:00+02:00`,
  recorded_at: `2026-10-03T${time}:00+02:00`,
  location,
  notes: null,
  source: "driver",
  recorded_by: "driver",
  lat: null,
  lng: null,
});
test("stop durations exclude travel and engine events; finishing closes an open stop", () => {
  const visits = stopVisits([
    event("start", "08:00"),
    event("arrive", "08:30", "Mill"),
    event("engine_off", "08:31"),
    event("depart", "09:15"),
    event("arrive", "10:00", "Depot"),
    event("end", "10:20"),
  ]);
  assert.deepEqual(
    visits.map((v) => [v.location, v.minutes]),
    [
      ["Mill", 45],
      ["Depot", 20],
    ],
  );
});
test("open stops count only time since arrival, using the supplied clock", () => {
  const visits = stopVisits(
    [event("start", "08:00"), event("arrive", "08:30", "Mill")],
    "2026-10-03T09:00:00+02:00",
  );
  assert.equal(visits[0].minutes, 30);
  assert.equal(visits[0].departed, null);
  assert.deepEqual(stopVisits([event("start", "08:00")]), []);
});
test("same-second arrival and departure use recorded sequence", () => {
  const visits=stopVisits([
    {...event("depart","08:30"),sequence:3},
    {...event("arrive","08:30","Gate"),sequence:2},
  ]);
  assert.equal(visits.length,1);
  assert.equal(visits[0].minutes,0);
  assert.equal(visits[0].departed,"2026-10-03T08:30:00+02:00");
});
