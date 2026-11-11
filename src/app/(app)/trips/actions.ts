"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireRole } from "@/lib/auth";
import { recordMeterReading } from "@/lib/domain/fleet-commands";
import { todayLocal } from "@/lib/format";
import { isUuid } from "@/lib/ids";
import { captureError } from "@/lib/observability";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { featureOn } from "@/lib/features";
import { planRoutes, RouteError, validPoints } from "@/lib/routing";
import { EXPENSE_KINDS, randsToCents } from "@/lib/trips";

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const text = (fd: FormData, key: string, max = 200): string | null => {
  const v = String(fd.get(key) ?? "").trim().slice(0, max);
  return v === "" ? null : v;
};
const number = (fd: FormData, key: string): number | null => {
  const raw = String(fd.get(key) ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const uuid = (fd: FormData, key: string): string | null => {
  const v = String(fd.get(key) ?? "");
  return isUuid(v) ? v : null;
};

export async function createTrip(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const farmId = profile.farm_id;
  const machineId = uuid(formData, "machine_id");
  if (!farmId || !machineId) redirect("/trips?error=trip-vehicle");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("trips")
    .insert({
      farm_id: farmId,
      number: 0,
      machine_id: machineId,
      trailer_id: uuid(formData, "trailer_id"),
      second_trailer_id: uuid(formData, "second_trailer_id"),
      driver_id: uuid(formData, "driver_id"),
      origin: text(formData, "origin"),
      destination: text(formData, "destination"),
      planned_start: text(formData, "planned_start"),
      notes: text(formData, "notes", 2000),
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error || !data) redirect(`/trips?error=${errorCode(error, "app/trips/actions:createTrip", "trip-failed")}`);
  revalidatePath("/trips");
  redirect(`/trips/${data.id}`);
}

export async function cancelTrip(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const id = uuid(formData, "id");
  if (!id || !profile.farm_id) redirect("/trips?error=trip-failed");
  const supabase = await createClient();
  const { error } = await supabase
    .from("trips")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("farm_id", profile.farm_id)
    .eq("status", "planned");
  if (error) redirect(`/trips/${id}?error=${errorCode(error, "app/trips/actions:cancelTrip", "trip-failed")}`);
  revalidatePath("/trips");
  redirect(`/trips/${id}`);
}

export async function startTrip(formData: FormData) {
  await requireRole(["owner", "manager", "mechanic", "operator"]);
  const id = uuid(formData, "id");
  if (!id) redirect("/trips?error=trip-failed");
  const supabase = await createClient();
  const { error } = await supabase.rpc("trip_start", { p_trip: id, p_reading: number(formData, "reading") });
  if (error) redirect(`/trips/${id}?error=${errorCode(error, "app/trips/actions:startTrip", "trip-failed")}`);
  revalidatePath(`/trips/${id}`);
  redirect(`/trips/${id}`);
}

export async function finishTrip(formData: FormData) {
  const profile = await requireRole(["owner", "manager", "mechanic", "operator"]);
  const id = uuid(formData, "id");
  if (!id) redirect("/trips?error=trip-failed");
  const reading = number(formData, "reading");

  const supabase = await createClient();
  const { error } = await supabase.rpc("trip_finish", { p_trip: id, p_reading: reading });
  if (error) redirect(`/trips/${id}?error=${errorCode(error, "app/trips/actions:finishTrip", "trip-reading")}`);

  // The odometer in one place: the service plan runs off the vehicle's reading.
  if (reading != null) {
    const { data: trip, error: tripError } = await supabase.from("trips").select("farm_id, machine_id").eq("id", id).maybeSingle();
    if (tripError) captureError(tripError, { where: "trips:finish-read" });
    if (trip) {
      await recordMeterReading(supabase, {
        farmId: trip.farm_id as string,
        machineId: trip.machine_id as string,
        reading,
        readingDate: todayLocal(),
        driverUserId: profile.id,
      }).catch((failure) => captureError(failure, { where: "trips:finish-reading" }));
    }
  }
  revalidatePath(`/trips/${id}`);
  redirect(`/trips/${id}`);
}

export async function addTripJob(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const tripId = uuid(formData, "trip_id");
  const customer = text(formData, "customer");
  if (!tripId || !profile.farm_id) redirect("/trips?error=trip-failed");
  if (!customer) redirect(`/trips/${tripId}?error=trip-customer`);

  const supabase = await createClient();
  const { error } = await supabase.from("trip_jobs").insert({
    farm_id: profile.farm_id,
    trip_id: tripId,
    customer,
    reference: text(formData, "reference", 100),
    description: text(formData, "description", 1000),
    weight_kg: number(formData, "weight_kg"),
    passengers: number(formData, "passengers"),
    seal_no: text(formData, "seal_no", 100),
    pickup: text(formData, "pickup"),
    dropoff: text(formData, "dropoff"),
  });
  if (error) redirect(`/trips/${tripId}?error=${errorCode(error, "app/trips/actions:addTripJob", "trip-failed")}`);
  revalidatePath(`/trips/${tripId}`);
  redirect(`/trips/${tripId}`);
}

function imageFrom(dataUrl: string): Buffer | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  return match ? Buffer.from(match[1], "base64") : null;
}

/** Sign a job off. The files go up first; the database then records it, or refuses. */
export async function deliverTripJob(formData: FormData) {
  await requireRole(["owner", "manager", "mechanic", "operator"]);
  const jobId = uuid(formData, "job_id");
  const tripId = uuid(formData, "trip_id");
  const farmId = uuid(formData, "farm_id");
  if (!jobId || !tripId || !farmId) redirect("/trips?error=trip-failed");
  const outcome = String(formData.get("outcome") ?? "delivered") === "failed" ? "failed" : "delivered";
  const receivedBy = text(formData, "received_by");
  if (outcome === "delivered" && !receivedBy) redirect(`/trips/${tripId}?error=trip-received-by`);

  const svc = createServiceClient();
  const base = `${farmId}/trips/${jobId}`;
  let photoPath: string | null = null;
  const photo = formData.get("photo");
  if (photo instanceof File && photo.size > 0) {
    if (photo.size > MAX_PHOTO_BYTES || !photo.type.startsWith("image/")) redirect(`/trips/${tripId}?error=trip-photo`);
    photoPath = `${base}/pod-${crypto.randomUUID()}.jpg`;
    const { error } = await svc.storage
      .from("jobcard-photos")
      .upload(photoPath, new Uint8Array(await photo.arrayBuffer()), { contentType: photo.type });
    if (error) {
      captureError(error, { where: "trips:pod-photo" });
      redirect(`/trips/${tripId}?error=trip-photo`);
    }
  }
  let signaturePath: string | null = null;
  const signature = imageFrom(String(formData.get("signature") ?? ""));
  if (signature) {
    signaturePath = `${base}/signature-${crypto.randomUUID()}.png`;
    const { error } = await svc.storage
      .from("jobcard-photos")
      .upload(signaturePath, signature, { contentType: "image/png" });
    if (error) {
      captureError(error, { where: "trips:pod-signature" });
      signaturePath = null;
    }
  }

  const supabase = await createClient();
  const lat = number(formData, "lat_abs");
  const { error } = await supabase.rpc("trip_job_deliver", {
    p_job: jobId,
    p_status: outcome,
    p_received_by: receivedBy ?? "",
    p_note: text(formData, "note", 1000) ?? "",
    p_photo: photoPath,
    p_signature: signaturePath,
    p_lat: lat == null ? null : Number(formData.get("lat")),
    p_lng: lat == null ? null : Number(formData.get("lng")),
  });
  if (error) redirect(`/trips/${tripId}?error=${errorCode(error, "app/trips/actions:deliverTripJob", "trip-failed")}`);
  revalidatePath(`/trips/${tripId}`);
  redirect(`/trips/${tripId}`);
}

export async function saveTripIncome(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const tripId = uuid(formData, "trip_id");
  if (!tripId || !profile.farm_id) redirect("/trips?error=trip-failed");
  const cents = randsToCents(String(formData.get("amount") ?? ""));
  if (cents == null) redirect(`/trips/${tripId}?error=trip-amount`);

  const supabase = await createClient();
  const { error } = await supabase.from("trip_income").upsert({
    trip_id: tripId,
    farm_id: profile.farm_id,
    amount_cents: cents,
    invoice_ref: text(formData, "invoice_ref", 100),
    created_by: profile.id,
    updated_at: new Date().toISOString(),
  });
  if (error) redirect(`/trips/${tripId}?error=${errorCode(error, "app/trips/actions:saveTripIncome", "trip-failed")}`);
  revalidatePath(`/trips/${tripId}`);
  redirect(`/trips/${tripId}`);
}

export async function addTripExpense(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const tripId = uuid(formData, "trip_id");
  if (!tripId || !profile.farm_id) redirect("/trips?error=trip-failed");
  const cents = randsToCents(String(formData.get("amount") ?? ""));
  const kind = String(formData.get("kind") ?? "");
  if (cents == null || !(EXPENSE_KINDS as readonly string[]).includes(kind)) redirect(`/trips/${tripId}?error=trip-amount`);

  const supabase = await createClient();
  const { error } = await supabase.from("trip_expenses").insert({
    trip_id: tripId,
    farm_id: profile.farm_id,
    kind,
    amount_cents: cents,
    note: text(formData, "note", 500),
    created_by: profile.id,
  });
  if (error) redirect(`/trips/${tripId}?error=${errorCode(error, "app/trips/actions:addTripExpense", "trip-failed")}`);
  revalidatePath(`/trips/${tripId}`);
  redirect(`/trips/${tripId}`);
}

/** A route service's refusal, as a code the planner page explains. */
function routeFailureCode(failure: unknown): string {
  if (failure instanceof RouteError) {
    if (failure.code === "not_configured") return "route-not-configured";
    if (failure.code === "no_route") return "route-none";
    if (failure.code === "limit") return "route-limit";
    if (failure.code === "invalid") return "route-stops";
  }
  return "route-unavailable";
}

/** The stops the planner sent: real places with a short name each, 2 to MAX_STOPS of them. */
function parseStops(raw: string): { lat: number; lng: number; label: string }[] | null {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  const points = validPoints(input);
  if (!points) return null;
  return points.map((p, i) => {
    const label = (input as { label?: unknown }[])[i]?.label;
    return { lat: p.lat, lng: p.lng, label: typeof label === "string" ? label.trim().slice(0, 160) : "" };
  });
}

/**
 * Keep the route a manager chose. The routes are asked for again here and the chosen one taken
 * from the service's answer, so the planned distance a driver is measured against always came
 * from the route service, never from what a browser sent.
 */
export async function saveTripRoute(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const tripId = uuid(formData, "trip_id");
  if (!tripId) redirect("/trips?error=trip-failed");
  const back = `/trips/${tripId}/route`;
  const stops = parseStops(String(formData.get("waypoints") ?? ""));
  if (!stops) redirect(`${back}?error=route-stops`);
  const choice = Math.max(0, Math.min(5, Number.parseInt(String(formData.get("choice") ?? "0"), 10) || 0));

  const supabase = await createClient();
  const { data: trip, error } = await supabase
    .from("trips")
    .select("id, farm_id, status")
    .eq("id", tripId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) redirect(`${back}?error=${errorCode(error, "app/trips/actions:saveTripRoute", "trip-failed")}`);
  if (!trip) redirect("/trips?error=trip-failed");
  if (trip.status === "completed" || trip.status === "cancelled") redirect(`/trips/${tripId}?error=route-closed`);
  if (!(await featureOn("map", trip.farm_id as string))) redirect(`/trips/${tripId}`);

  let planned: Awaited<ReturnType<typeof planRoutes>> | null = null;
  let failed: string | null = null;
  try {
    planned = await planRoutes(trip.farm_id as string, stops);
  } catch (failure) {
    failed = routeFailureCode(failure);
  }
  if (!planned) redirect(`${back}?error=${failed ?? "route-unavailable"}`);
  const option = planned.options[choice] ?? planned.options[0];

  const { error: saveError } = await supabase.from("trip_routes").upsert(
    {
      trip_id: tripId,
      farm_id: trip.farm_id,
      waypoints: stops,
      geometry: option.line,
      distance_m: option.distanceM,
      duration_s: option.durationS,
      provider: planned.provider,
      planned_by: profile.id,
      planned_at: new Date().toISOString(),
    },
    { onConflict: "trip_id" },
  );
  if (saveError) redirect(`${back}?error=${errorCode(saveError, "app/trips/actions:saveTripRoute", "trip-failed")}`);
  revalidatePath(`/trips/${tripId}`);
  redirect(`/trips/${tripId}?saved=route`);
}

export async function clearTripRoute(formData: FormData) {
  await requireRole(["owner", "manager"]);
  const tripId = uuid(formData, "trip_id");
  if (!tripId) redirect("/trips?error=trip-failed");
  const supabase = await createClient();
  const { error } = await supabase.from("trip_routes").delete().eq("trip_id", tripId);
  if (error) redirect(`/trips/${tripId}?error=${errorCode(error, "app/trips/actions:clearTripRoute", "trip-failed")}`);
  revalidatePath(`/trips/${tripId}`);
  redirect(`/trips/${tripId}`);
}
