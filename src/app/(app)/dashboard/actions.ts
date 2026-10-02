"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { currentFarmId, effectiveFarmRole, requireProfile, requireRole } from "@/lib/auth";
import { recordMeterReading } from "@/lib/domain/fleet-commands";
import { todayLocal } from "@/lib/format";
import { DASH_COOKIE, DASH_SECTIONS, serializeDashPrefs, type DashPrefs } from "@/lib/dashboard-prefs";

/** Who may write a reading down. Same list as the machine page's `addReading`. */
const READERS = ["rr_admin", "owner", "manager", "mechanic", "operator"];

/**
 * Save which dashboard sections show on this device.
 *
 * A cookie, not a column: see `dashboard-prefs.ts`. Unticked checkboxes post nothing, so
 * every known section is written explicitly, on or off.
 */
export async function saveDashboardPrefs(formData: FormData) {
  await requireProfile();
  const prefs = Object.fromEntries(
    DASH_SECTIONS.map((k) => [k, formData.get(`show_${k}`) === "on"]),
  ) as DashPrefs;
  const jar = await cookies();
  jar.set(DASH_COOKIE, serializeDashPrefs(prefs), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    httpOnly: true,
  });
  redirect("/dashboard?saved=prefs");
}

/** One validated reading. Throws a short code or the command's own message. */
async function recordOne(
  supabase: Awaited<ReturnType<typeof createClient>>,
  profile: Awaited<ReturnType<typeof requireProfile>>,
  machineId: string,
  raw: string,
  readingDate: string,
) {
  const reading = Number(raw);
  if (!machineId || raw === "" || !Number.isFinite(reading) || reading < 0) {
    throw new Error("enter-a-valid-reading");
  }
  // The farm comes from the machine row under RLS, never from the form.
  const { data } = await supabase
    .from("machines")
    .select("farm_id")
    .eq("id", machineId)
    .is("deleted_at", null)
    .maybeSingle();
  const farmId = (data as { farm_id: string } | null)?.farm_id;
  if (!farmId) throw new Error("not-found");
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !READERS.includes(role)) throw new Error("forbidden");
  await recordMeterReading(supabase, {
    farmId,
    machineId,
    reading,
    readingDate,
    driverUserId: null,
  });
}

function codeOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "enter-a-valid-reading";
}

/**
 * "Record meter reading" from the dashboard: pick a machine, type one number.
 *
 * The machine page's `addReading` always lands back on that machine, which is right there
 * and wrong here, so this one returns to the dashboard.
 */
export async function recordDashboardReading(formData: FormData) {
  const profile = await requireProfile();
  const machineId = String(formData.get("machine_id") ?? "");
  const raw = String(formData.get("reading") ?? "").trim();
  const date = String(formData.get("reading_date") ?? "").trim() || todayLocal();
  const supabase = await createClient();
  try {
    await recordOne(supabase, profile, machineId, raw, date);
  } catch (error) {
    redirect(`/dashboard?error=${encodeURIComponent(codeOf(error))}`);
  }
  revalidatePath("/dashboard");
  revalidatePath(`/machines/${machineId}`);
  redirect("/dashboard?saved=reading");
}

/**
 * The stale-meters card's "Record readings": one number per machine, blanks skipped.
 *
 * Each reading goes through the same checks as a single one. The first failure stops the
 * batch and says why; the readings before it are kept, which is what a person expects
 * after typing six numbers and getting the seventh wrong.
 */
export async function recordDashboardReadings(formData: FormData) {
  const profile = await requireProfile();
  const date = todayLocal();
  const supabase = await createClient();
  const entries: [string, string][] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("reading:")) continue;
    const raw = String(value).trim();
    if (raw !== "") entries.push([key.slice("reading:".length), raw]);
  }
  if (entries.length === 0) redirect("/dashboard?error=enter-a-valid-reading");
  let saved = 0;
  for (const [machineId, raw] of entries) {
    try {
      await recordOne(supabase, profile, machineId, raw, date);
      saved += 1;
    } catch (error) {
      if (saved > 0) revalidatePath("/dashboard");
      redirect(`/dashboard?error=${encodeURIComponent(codeOf(error))}`);
    }
  }
  revalidatePath("/dashboard");
  redirect("/dashboard?saved=readings");
}

/**
 * Hide the "Finish setting up" card. Rides on `farms.settings` through the existing
 * owner/manager-guarded `update_farm_settings` RPC, like `acknowledgeQrLabels`.
 */
export async function dismissSetupCard() {
  const profile = await requireRole(["owner", "manager"]);
  const farmId = (await currentFarmId(profile)) ?? profile.farm_id;
  if (!farmId) redirect("/dashboard?error=farm-not-found");
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_farm_settings", {
    p_farm: farmId,
    p_settings: { setup_card_dismissed_at: new Date().toISOString() },
  });
  if (error) redirect(`/dashboard?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/dashboard");
  redirect("/dashboard");
}
