import { getProfile } from "@/lib/auth";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";
import { readAll } from "@/lib/supabase/read-all";
import { csvResponse, toCsv } from "../../../reports/data";

/**
 * The positions recorded during one trip, as a spreadsheet: the retained tracking of a trip,
 * readable on any plan (decision 37) and limited to that trip's own records. No map, no
 * route service, nothing recorded: a download of what exists.
 *
 * Read through the person's own session, so the tables' policies decide: an owner or manager
 * gets the business's positions for the trip, its driver what their own driving recorded,
 * anybody else nothing. Answered with statuses, never a page of HTML saved as a CSV.
 */
export const dynamic = "force-dynamic";

/** One trip's positions: a long day at a point every few seconds, with room to spare. */
const MAX_POINTS = 50_000;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return new Response("Not found", { status: 404 });

  const supabase = await createClient();
  const { data: trip, error } = await supabase
    .from("trips")
    .select("id, number, machine_id, started_at, ended_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return new Response("Could not read the trip", { status: 500 });
  if (!trip) return new Response("Not found", { status: 404 });
  if (!trip.started_at) return new Response("This trip has not started", { status: 404 });

  const until = (trip.ended_at as string | null) ?? new Date().toISOString();
  const read = await readAll<{ id: number; recorded_at: string; lat: number; lng: number; speed_kmh: number | null; accuracy_m: number | null; source: string }>(
    () =>
      supabase
        .from("asset_positions")
        .select("id, recorded_at, lat, lng, speed_kmh, accuracy_m, source")
        .eq("machine_id", trip.machine_id as string)
        .gte("recorded_at", trip.started_at as string)
        .lte("recorded_at", until)
        .order("recorded_at", { ascending: true }),
    { maxRows: MAX_POINTS },
  );
  if (read.error) return new Response("Could not read the positions", { status: 500 });
  if (read.truncated) return new Response(`More than ${MAX_POINTS} positions: ask us for the full set.`, { status: 413 });

  const rows: (string | number)[][] = [
    ["recorded_at", "lat", "lng", "speed_kmh", "accuracy_m", "source"],
    ...(read.data ?? []).map((p) => [p.recorded_at, p.lat, p.lng, p.speed_kmh ?? "", p.accuracy_m ?? "", p.source]),
  ];
  return csvResponse(`trip-${trip.number}-positions.csv`, toCsv(rows));
}
