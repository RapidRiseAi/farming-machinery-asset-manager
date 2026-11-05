"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { currentFarmId, effectiveFarmRole, farmIsUsable, requireProfile, requireRole } from "@/lib/auth";
import { FleetCommandError, recordMeterReading } from "@/lib/domain/fleet-commands";
import { todayLocal } from "@/lib/format";
import { normalizeLayout, storedLayout } from "@/lib/dashboard/schema";
import type { LayoutItem } from "@/lib/dashboard/layout";
import { runOnce } from "@/lib/request-claim";
import { errorCode, reportUnlessRefused } from "@/lib/action-errors";

/** Who may write a reading down. Same list as the machine page's `addReading`. */
const READERS = ["rr_admin", "owner", "manager", "mechanic", "operator"];

/**
 * Save this person's board for the farm they are acting in: every drag, resize, added or
 * removed widget and settings change sends the whole board here.
 *
 * Called from the browser with whatever it sends, so the board is cleaned exactly as a
 * read one is (lib/dashboard/schema.ts) and written through RLS, which allows only the
 * person's own row for a farm they can reach. A result, never a redirect: the grid shows
 * "could not save" and keeps the board on screen.
 */
export async function saveDashboardLayout(items: LayoutItem[]): Promise<{ ok: boolean }> {
  const profile = await requireProfile();
  const farmId = await currentFarmId(profile);
  if (!farmId || profile.role === "workshop") return { ok: false };
  // The stop gate: a tab left open on a paused farm saves nothing.
  if (!(await farmIsUsable(farmId, profile))) return { ok: false };
  const clean = normalizeLayout(storedLayout(Array.isArray(items) ? items : []));
  if (!clean) return { ok: false };
  const supabase = await createClient();
  const { error } = await supabase
    .from("dashboard_layouts")
    .upsert({ user_id: profile.id, farm_id: farmId, layout: storedLayout(clean), updated_at: new Date().toISOString() });
  if (error) {
    reportUnlessRefused(error, "app/dashboard/actions:saveDashboardLayout");
    return { ok: false };
  }
  return { ok: true };
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
  const { data, error } = await supabase
    .from("machines")
    .select("farm_id")
    .eq("id", machineId)
    .is("deleted_at", null)
    .maybeSingle();
  // A failed read is not "not found". errorCode reports it; the caller encodes the code
  // for the URL itself, so it is decoded here to avoid encoding it twice.
  if (error) throw new Error(decodeURIComponent(errorCode(error, "app/dashboard/actions:recordOne")));
  const farmId = (data as { farm_id: string } | null)?.farm_id;
  if (!farmId) throw new Error("not-found");
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !READERS.includes(role)) throw new Error("forbidden");
  // The stop gate on the machine's own farm (review round 5, finding gate-1). A boolean and
  // a code, not requireUsableFarm: its redirect would be caught by the callers' catch and
  // swallowed. The redirect back to the dashboard meets the layout's gate, which sends a
  // paused farm to its stopped page.
  if (!(await farmIsUsable(farmId, profile))) throw new Error("farm-not-active");
  await recordMeterReading(supabase, {
    farmId,
    machineId,
    reading,
    readingDate,
    driverUserId: null,
  });
}

function codeOf(error: unknown): string {
  // The meter command carries the database's code and words. Our own refusals (a reading
  // below the last one) keep their words; anything else is reported and said as "try
  // again", never the database's message in the address bar.
  if (error instanceof FleetCommandError) {
    // The error itself, not a copy of its fields: a report then keeps the stack.
    return decodeURIComponent(errorCode(error, "app/dashboard/actions:record-reading"));
  }
  return error instanceof Error && error.message ? error.message : "enter-a-valid-reading";
}

/**
 * "Record meter reading" from the dashboard: pick a machine, type one number.
 *
 * The machine page's `addReading` always lands back on that machine, which is right there
 * and wrong here, so this one returns to the dashboard.
 */
export async function recordDashboardReading(formData: FormData) {
  return runOnce(
    formData,
    "readings:dashboard",
    async () => {
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
      return "/dashboard?saved=reading";
    },
    { whileRunning: "/dashboard?error=still-saving" },
  );
}

/**
 * The stale-meters card's "Record readings": one number per machine, blanks skipped.
 *
 * Each reading goes through the same checks as a single one. The first failure stops the
 * batch and says why; the readings before it are kept, which is what a person expects
 * after typing six numbers and getting the seventh wrong.
 */
export async function recordDashboardReadings(formData: FormData) {
  return runOnce(
    formData,
    "readings:dashboard-batch",
    async () => {
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
          const failedAt = `/dashboard?error=${encodeURIComponent(codeOf(error))}`;
          // Readings before this one are saved: returned, so the claim holds and a retry of
          // this request does not record them a second time (a redirect releases it).
          if (saved > 0) return failedAt;
          redirect(failedAt);
        }
      }
      revalidatePath("/dashboard");
      return "/dashboard?saved=readings";
    },
    { whileRunning: "/dashboard?error=still-saving" },
  );
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
  if (error) redirect(`/dashboard?error=${errorCode(error, "app/dashboard/actions:dismissSetupCard")}`);
  revalidatePath("/dashboard");
  redirect("/dashboard");
}
