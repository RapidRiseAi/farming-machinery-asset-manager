export const DRIVING_KINDS = [
  "start",
  "arrive",
  "depart",
  "end",
  "engine_on",
  "engine_off",
  "location",
] as const;
export type DrivingKind = (typeof DRIVING_KINDS)[number];
export type DrivingEvent = {
  sequence?: number;
  id: string;
  session_id: string;
  kind: DrivingKind;
  occurred_at: string;
  recorded_at: string;
  location: string | null;
  notes: string | null;
  source: string;
  recorded_by: string | null;
  lat: number | null;
  lng: number | null;
};
export function stopVisits(
  events: DrivingEvent[],
  now = new Date().toISOString(),
) {
  const visits: {
    location: string;
    arrived: string;
    departed: string | null;
    minutes: number;
  }[] = [];
  let open: DrivingEvent | null = null;
  for (const event of [...events].sort(
    (a, b) =>
      Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
      (a.sequence??0)-(b.sequence??0) ||
      Date.parse(a.recorded_at) - Date.parse(b.recorded_at),
  )) {
    if (event.kind === "arrive") open = event;
    if ((event.kind === "depart" || event.kind === "end") && open) {
      visits.push({
        location: open.location ?? "",
        arrived: open.occurred_at,
        departed: event.occurred_at,
        minutes: Math.max(
          0,
          Math.floor(
            (Date.parse(event.occurred_at) - Date.parse(open.occurred_at)) /
              60000,
          ),
        ),
      });
      open = null;
    }
  }
  if (open)
    visits.push({
      location: open.location ?? "",
      arrived: open.occurred_at,
      departed: null,
      minutes: Math.max(
        0,
        Math.floor((Date.parse(now) - Date.parse(open.occurred_at)) / 60000),
      ),
    });
  return visits;
}
