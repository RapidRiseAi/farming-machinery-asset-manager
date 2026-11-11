import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { effectiveFarmRole, homePathFor, requireProfile } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { featureOn } from "@/lib/features";
import { localeOf, t } from "@/lib/i18n";
import { attributionFor, routingConfig } from "@/lib/routing";
import { must } from "@/lib/supabase/must";
import { createClient } from "@/lib/supabase/server";
import { Flash } from "@/components/ui/flash";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { RoutePlanner, type PlannerLabels, type PlannerStop } from "@/components/map/route-planner";
import { saveTripRoute } from "../../actions";

/**
 * Planning a trip's route: pins, stops, and a choice of routes. An owner or manager, while the
 * trip is still to happen or underway, and only where the map is on.
 */
export const dynamic = "force-dynamic";

const ERRORS = ["not_configured", "no_route", "limit", "unavailable", "invalid", "off", "forbidden", "stopped", "auth"] as const;

export default async function TripRoutePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const profile = await requireProfile();
  if (profile.role === "workshop" || profile.role === "rr_admin") redirect(`${homePathFor(profile.role)}?denied=1`);
  const locale = profile.lang;

  const supabase = await createClient();
  const trip = must(
    await supabase.from("trips").select("id, farm_id, number, status, origin, destination").eq("id", id).is("deleted_at", null).maybeSingle(),
    "trip-route:row",
  ) as { id: string; farm_id: string; number: number; status: string; origin: string | null; destination: string | null } | null;
  if (!trip) notFound();

  const role = await effectiveFarmRole(trip.farm_id, profile);
  if (role !== "owner" && role !== "manager") redirect(`/trips/${id}`);
  if (!(await featureOn("map", trip.farm_id))) notFound();
  if (trip.status === "completed" || trip.status === "cancelled") redirect(`/trips/${id}?error=route-closed`);

  const saved = must(
    await supabase.from("trip_routes").select("waypoints, distance_m").eq("trip_id", id).maybeSingle(),
    "trip-route:saved",
  ) as { waypoints: PlannerStop[]; distance_m: number } | null;

  const { config } = routingConfig();
  const labels: PlannerLabels = {
    start: t("routes.start", locale),
    stop: t("routes.stop", locale),
    end: t("routes.end", locale),
    searchPlaceholder: t("routes.searchPlaceholder", locale),
    search: t("routes.search", locale),
    finding: t("routes.finding", locale),
    noResults: t("routes.noResults", locale),
    otherMatches: t("routes.otherMatches", locale),
    pin: t("routes.pin", locale),
    pinning: t("routes.pinning", locale),
    addStop: t("routes.addStop", locale),
    remove: t("routes.removeStop", locale),
    up: t("routes.up", locale),
    down: t("routes.down", locale),
    routes: t("routes.options", locale),
    routeOption: t("routes.option", locale),
    onlyOne: t("routes.onlyOne", locale),
    loading: t("routes.loading", locale),
    needEnds: t("routes.needEnds", locale),
    save: t("routes.save", locale),
    cancel: t("common.cancel", locale),
    pinned: t("routes.pinned", locale),
    dragHint: t("routes.dragHint", locale),
    hoursMinutes: t("routes.hoursMinutes", locale),
    minutes: t("routes.minutes", locale),
    attribution: attributionFor(config?.provider ?? null),
    errors: Object.fromEntries(ERRORS.map((code) => [code, t(`routes.errors.${code}`, locale)])),
  };

  return (
    <PageContainer size="wide">
      <p><Link href={`/trips/${id}`} className="text-sm underline">{t("routes.backToTrip", locale)}</Link></p>
      <PageHeader
        title={t("routes.planTitle", locale)}
        lead={t("routes.planLead", locale).replace("{n}", String(trip.number))}
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      {!config ? <Flash tone="error" message={t("routes.errors.not_configured", locale)} /> : null}
      <RoutePlanner
        tripId={trip.id}
        initialStops={saved?.waypoints ?? []}
        origin={trip.origin ?? ""}
        destination={trip.destination ?? ""}
        savedDistanceM={saved?.distance_m ?? null}
        labels={labels}
        numberLocale={`${localeOf(locale)}-ZA`}
        saveAction={saveTripRoute}
        cancelHref={`/trips/${id}`}
      />
    </PageContainer>
  );
}
