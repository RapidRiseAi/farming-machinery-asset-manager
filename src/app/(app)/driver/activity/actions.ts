"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function recordActivity(form: FormData) {
  const profile = await requireProfile();
  const db = await createClient();
  const farm = String(form.get("farm") ?? "");
  const raw = String(form.get("at") ?? "");
  // Explicit SAST for manager-entered times; server/device timezone never changes the date.
  const at = raw ? new Date(`${raw}:00+02:00`) : new Date();
  if (!Number.isFinite(at.getTime()))
    redirect("/driver/activity?error=driving_invalid");
  const coordinate = (key: string) =>
    form.get(key) ? Number(form.get(key)) : null;
  const { error } = await db.rpc("record_driving_event", {
    p_farm: farm,
    p_machine: String(form.get("machine") ?? ""),
    p_driver: String(form.get("driver") || profile.id),
    p_kind: String(form.get("kind") ?? ""),
    p_at: at.toISOString(),
    p_location: String(form.get("location") ?? ""),
    p_notes: String(form.get("notes") ?? ""),
    p_lat: coordinate("lat"),
    p_lng: coordinate("lng"),
    p_session: String(form.get("session") ?? "") || null,
  });
  revalidatePath("/driver/activity");
  redirect(
    `/driver/activity?farm=${encodeURIComponent(farm)}&${error ? "error=driving_invalid" : "saved=1"}`,
  );
}
