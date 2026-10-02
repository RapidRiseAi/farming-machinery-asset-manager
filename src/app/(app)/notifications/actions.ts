"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { notificationUrl } from "@/lib/notifications/format";

/** Mark one in-app alert read (read_at is the read marker; 0205). */
export async function markRead(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id).eq("user_id", profile.id).is("read_at", null);
  revalidatePath("/notifications");
  redirect("/notifications");
}

/**
 * Open an alert: mark it read and go to what it is about.
 *
 * The destination is computed HERE from the stored row, never taken from the form, so
 * a posted value cannot turn this into an open redirect. The row is read under RLS and
 * filtered to the caller, so an id belonging to somebody else simply finds nothing and
 * lands back on the list. A POST rather than a link that marks read on GET, because
 * Next prefetches links and would mark every visible alert read on sight.
 */
export async function openNotification(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/notifications");
  const supabase = await createClient();
  const { data } = await supabase
    .from("notifications")
    .select("id, template, payload, read_at")
    .eq("id", id)
    .eq("user_id", profile.id)
    .is("deleted_at", null)
    .maybeSingle();
  const note = data as { id: string; template: string; payload: Record<string, unknown> | null; read_at: string | null } | null;
  if (!note) redirect("/notifications");
  if (note.read_at == null) {
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", note.id)
      .eq("user_id", profile.id)
      .is("read_at", null);
    revalidatePath("/notifications");
  }
  redirect(notificationUrl(note.template, note.payload ?? {}));
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
 * Per-user notification preferences (FR-14.3): in-app / push / email channel toggles and
 * optional per-user quiet hours (blank = inherit the farm window). Applies only to the
 * caller via the SECURITY DEFINER RPC (0261), never touches role/farm.
 *
 * The form lives in the Alerts card of /account (the one preferences hub), so that is
 * where it lands, with the card in view.
 */
export async function setNotificationPrefs(formData: FormData) {
  await requireProfile();
  const inapp = formData.get("notify_inapp") === "on";
  const push = formData.get("notify_push") === "on";
  const email = formData.get("notify_email") === "on";
  const quietStart = hourOrNull(formData, "quiet_hours_start");
  const quietEnd = hourOrNull(formData, "quiet_hours_end");
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_notification_prefs", {
    p_inapp: inapp,
    p_push: push,
    p_email: email,
    p_quiet_start: quietStart,
    p_quiet_end: quietEnd,
  });
  if (error) redirect("/account?error=save-failed#alerts");
  revalidatePath("/account");
  revalidatePath("/notifications");
  redirect("/account?saved=alerts#alerts");
}
