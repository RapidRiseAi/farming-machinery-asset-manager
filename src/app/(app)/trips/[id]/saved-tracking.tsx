import { dateTime, num } from "@/lib/format";
import { t, type Lang } from "@/lib/i18n";
import { downloadLabels } from "@/lib/interaction-labels";
import { must } from "@/lib/supabase/must";
import { createClient } from "@/lib/supabase/server";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DownloadLink } from "@/components/ui/download-link";
import { Fact, FactList } from "@/components/ui/facts";

/**
 * A trip's saved route and recorded positions where maps are NOT available to the business
 * (a downgrade from Complete, or the map taken out of testing). Decision 37: retained
 * tracking stays readable, limited to the records that exist. So this is text, not a map:
 * no tile is loaded, no route service is asked, nothing new is recorded. The stops and the
 * planned distance are read back; the positions are counted and can be downloaded.
 *
 * Reads are the person's own, so a driver sees their own trip's records and an owner or
 * manager the business's, by the tables' own policies. Renders nothing when there is none.
 */
export async function TripSavedTracking({
  trip,
  locale,
}: {
  trip: { id: string; machine_id: string; started_at: string | null; ended_at: string | null };
  locale: Lang;
}) {
  const supabase = await createClient();
  const until = trip.ended_at ?? new Date().toISOString();
  const [routeRes, countRes, firstRes, lastRes] = await Promise.all([
    supabase.from("trip_routes").select("waypoints, distance_m").eq("trip_id", trip.id).maybeSingle(),
    trip.started_at
      ? supabase.from("asset_positions").select("id", { count: "exact", head: true })
          .eq("machine_id", trip.machine_id).gte("recorded_at", trip.started_at).lte("recorded_at", until)
      : Promise.resolve({ data: null, error: null, count: 0 }),
    trip.started_at
      ? supabase.from("asset_positions").select("recorded_at").eq("machine_id", trip.machine_id)
          .gte("recorded_at", trip.started_at).lte("recorded_at", until).order("recorded_at").limit(1).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    trip.started_at
      ? supabase.from("asset_positions").select("recorded_at").eq("machine_id", trip.machine_id)
          .gte("recorded_at", trip.started_at).lte("recorded_at", until).order("recorded_at", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const route = must(routeRes, "trip:saved-route") as { waypoints: { label?: string }[]; distance_m: number } | null;
  if (countRes.error) must(countRes, "trip:saved-positions");
  const count = countRes.count ?? 0;
  const first = (must(firstRes, "trip:saved-first") as { recorded_at: string } | null)?.recorded_at ?? null;
  const last = (must(lastRes, "trip:saved-last") as { recorded_at: string } | null)?.recorded_at ?? null;
  if (!route && count === 0) return null;

  const stops = (route?.waypoints ?? []).map((w, i) => w.label?.trim() || String.fromCharCode(65 + i));
  return (
    <Card>
      <CardHeader><CardTitle as="h3">{t("routes.savedTitle", locale)}</CardTitle></CardHeader>
      <p className="mb-3 text-sm text-sand-600">{t("routes.savedHint", locale)}</p>
      <FactList>
        {route ? <Fact label={t("routes.planned", locale)} value={`${num(route.distance_m / 1000)} km`} /> : null}
        {stops.length > 0 ? <Fact label={t("routes.savedStops", locale)} value={stops.join(" > ")} /> : null}
        {count > 0 ? (
          <Fact
            label={t("routes.savedPositions", locale)}
            value={t("routes.savedPositionsValue", locale)
              .replace("{n}", num(count, 0))
              .replace("{first}", first ? dateTime(first, locale) : "-")
              .replace("{last}", last ? dateTime(last, locale) : "-")}
          />
        ) : null}
      </FactList>
      {count > 0 ? (
        <div className="mt-3">
          <DownloadLink
            href={`/trips/${trip.id}/positions.csv`}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
            labels={downloadLabels(locale)}
          >
            {t("routes.savedDownload", locale)}
          </DownloadLink>
        </div>
      ) : null}
    </Card>
  );
}
