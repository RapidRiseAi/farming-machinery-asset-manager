/**
 * Web-Push delivery pass (service-role, Node runtime). Finds queued notifications that are
 * deliverable now (past their quiet-hours `deliver_after`) and not yet pushed, and delivers
 * them to each recipient's subscribed devices — honouring the per-user `notify_push` toggle
 * (FR-14.3). Each row is marked `push_sent_at` so it pushes at most once; dead endpoints
 * (404/410) are pruned. No-ops gracefully when VAPID keys are unset.
 *
 * Called by the nightly cron route after the enqueue steps, and exposed at
 * /api/push/send for external triggering.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getVapidConfig, sendWebPush } from "./webpush";
import { formatNotification, notificationTitle, notificationUrl } from "@/lib/notifications/format";
import type { Locale } from "@/lib/i18n";

type NotifRow = {
  id: string;
  user_id: string | null;
  farm_id: string;
  template: string;
  payload: Record<string, unknown> | null;
};
type UserRow = { id: string; notify_push: boolean; language: Locale };
type SubRow = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };

export type DeliverResult = {
  ok: boolean;
  skipped?: string;
  scanned: number;
  pushed: number;
  failed: number;
  pruned: number;
};

const BATCH = 500;

export async function deliverPush(supabase: SupabaseClient): Promise<DeliverResult> {
  const config = getVapidConfig();
  if (!config) return { ok: true, skipped: "vapid-not-configured", scanned: 0, pushed: 0, failed: 0, pruned: 0 };

  const nowIso = new Date().toISOString();
  const { data: notifData } = await supabase
    .from("notifications")
    .select("id, user_id, farm_id, template, payload")
    .is("deleted_at", null)
    .is("push_sent_at", null)
    .not("user_id", "is", null)
    .or(`deliver_after.is.null,deliver_after.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(BATCH);
  const notifs = (notifData as NotifRow[] | null) ?? [];
  if (notifs.length === 0) return { ok: true, scanned: 0, pushed: 0, failed: 0, pruned: 0 };

  const userIds = [...new Set(notifs.map((n) => n.user_id).filter(Boolean) as string[])];
  const machineIds = [
    ...new Set(notifs.map((n) => n.payload?.machine_id).filter(Boolean) as string[]),
  ];

  const [usersRes, subsRes, machinesRes] = await Promise.all([
    supabase.from("users").select("id, notify_push, language").in("id", userIds),
    supabase.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").is("deleted_at", null).in("user_id", userIds),
    machineIds.length
      ? supabase.from("machines").select("id, name").in("id", machineIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);

  const users = new Map<string, UserRow>(((usersRes.data as UserRow[] | null) ?? []).map((u) => [u.id, u]));
  const subsByUser = new Map<string, SubRow[]>();
  for (const s of (subsRes.data as SubRow[] | null) ?? []) {
    const list = subsByUser.get(s.user_id) ?? [];
    list.push(s);
    subsByUser.set(s.user_id, list);
  }
  const machineName = new Map<string, string>(
    ((machinesRes.data as { id: string; name: string }[] | null) ?? []).map((m) => [m.id, m.name])
  );

  let pushed = 0;
  let failed = 0;
  const deadSubIds: string[] = [];

  for (const n of notifs) {
    const user = n.user_id ? users.get(n.user_id) : undefined;
    if (!user || !user.notify_push) continue;
    const subs = subsByUser.get(user.id) ?? [];
    if (subs.length === 0) continue;

    const locale: Locale = user.language ?? "en";
    const payload = n.payload ?? {};
    const mName = machineName.get(payload.machine_id as string);
    const message = {
      title: notificationTitle(n.template, locale),
      body: formatNotification(n.template, payload, locale, mName),
      url: notificationUrl(n.template, payload),
      tag: n.id,
    };

    for (const sub of subs) {
      try {
        const { statusCode } = await sendWebPush(sub, message, config);
        if (statusCode === 404 || statusCode === 410) {
          deadSubIds.push(sub.id);
        } else if (statusCode >= 200 && statusCode < 300) {
          pushed++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
  }

  // Prune dead subscriptions (soft delete).
  if (deadSubIds.length > 0) {
    await supabase
      .from("push_subscriptions")
      .update({ deleted_at: new Date().toISOString() })
      .in("id", deadSubIds);
  }

  // Mark every scanned, deliverable row as pushed so it is never re-pushed.
  const ids = notifs.map((n) => n.id);
  await supabase.from("notifications").update({ push_sent_at: new Date().toISOString() }).in("id", ids);

  return { ok: true, scanned: notifs.length, pushed, failed, pruned: deadSubIds.length };
}
