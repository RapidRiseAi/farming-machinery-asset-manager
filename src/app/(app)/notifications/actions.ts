"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";

/** Mark one in-app alert read (read_at is the read marker; 0205). */
export async function markRead(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id).eq("user_id", profile.id).is("read_at", null);
  revalidatePath("/notifications");
  redirect("/notifications");
}

export async function markAllRead() {
  const profile = await requireProfile();
  const supabase = await createClient();
  await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", profile.id).is("read_at", null);
  revalidatePath("/notifications");
  redirect("/notifications");
}

function hourOrNull(fd: FormData, k: string): number | null {
  const v = String(fd.get(k) ?? "").trim();
  if (v === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : null;
}

/**
 * Per-user notification preferences (FR-14.3): in-app / push channel toggles and optional
 * per-user quiet hours (blank = inherit the farm window). Applies only to the caller via
 * the SECURITY DEFINER RPC (0261) — never touches role/farm.
 */
export async function setNotificationPrefs(formData: FormData) {
  await requireProfile();
  const inapp = formData.get("notify_inapp") === "on";
  const push = formData.get("notify_push") === "on";
  const quietStart = hourOrNull(formData, "quiet_hours_start");
  const quietEnd = hourOrNull(formData, "quiet_hours_end");
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_notification_prefs", {
    p_inapp: inapp,
    p_push: push,
    p_quiet_start: quietStart,
    p_quiet_end: quietEnd,
  });
  if (error) redirect(`/notifications?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/notifications");
  redirect("/notifications?saved=1");
}
