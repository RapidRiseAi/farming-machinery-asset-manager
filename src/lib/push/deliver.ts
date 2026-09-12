/**
 * Leased, retryable Web Push. Only successful or terminal deliveries are marked sent.
 * Device acknowledgements survive partial failures; expired leases recover crashed runs.
 * A crash between provider acceptance and the database acknowledgement can still repeat
 * a push (Web Push has no transactional acknowledgement); the stable tag collapses it.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getVapidConfig, sendWebPush } from "./webpush";
import { validateWebPushSubscription } from "./subscription-validation";
import { formatNotification, notificationTitle, notificationUrl } from "@/lib/notifications/format";
import type { Locale, Lang } from "@/lib/i18n";

type NotifRow = {
  id: string;
  user_id: string | null;
  farm_id: string;
  template: string;
  payload: Record<string, unknown> | null;
  delivered_subscription_ids: string[];
};
type UserRow = { id: string; notify_push: boolean; language: Locale };
type SubRow = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };

export type DeliverResult = {
  ok: boolean;
  skipped?: string;
  error?: string;
  scanned: number;
  pushed: number;
  failed: number;
  pruned: number;
  deferred: number;
};

// SQL leases last five minutes. Bound this pass below that, including provider timeout.
const BATCH = 25;
const RUN_BUDGET_MS = 25_000;
const FINANCIAL_TEMPLATES = new Set([
  "job_completed", "work_request_quoted", "work_request_invoiced",
  "partner_quote_received", "partner_invoice_received", "quote_awaiting", "invoice_awaiting",
  "invoice_due_soon", "invoice_overdue", "invoice_overdue_partner",
  "quote_accepted_partner", "payment_claimed_partner",
]);

// Push can appear on a shared lock screen, and its recipient may have lost cost
// access since enqueue. Keep amounts/card details in the authenticated alert centre,
// where the current resource-farm permission is checked again by RLS.
function pushBody(n: NotifRow, locale: Lang, machineName?: string): string {
  const payload = n.payload ?? {};
  const financial = FINANCIAL_TEMPLATES.has(n.template) || n.template.startsWith("billing_") ||
    Object.keys(payload).some((key) => key.endsWith("_cents") || ["amount", "cost", "total"].includes(key));
  return financial
    ? notificationTitle(n.template, locale)
    : formatNotification(n.template, payload, locale, machineName);
}

type Dependencies = {
  config: typeof getVapidConfig;
  send: typeof sendWebPush;
  now: () => number;
};

export async function deliverPush(
  supabase: SupabaseClient,
  deps: Dependencies = { config: getVapidConfig, send: sendWebPush, now: Date.now },
): Promise<DeliverResult> {
  const result: DeliverResult = { ok: true, scanned: 0, pushed: 0, failed: 0, pruned: 0, deferred: 0 };
  const config = deps.config();
  if (!config) return { ...result, skipped: "vapid-not-configured" };
  const deadline = deps.now() + RUN_BUDGET_MS;
  const claimId = randomUUID();
  const fail = (reason: string) => {
    result.ok = false;
    result.failed++;
    result.error ??= reason;
  };

  let notifs: NotifRow[];
  try {
    const claimed = await supabase.rpc("claim_notification_push", { p_claim_id: claimId, p_limit: BATCH });
    if (claimed.error) throw new Error("claim-failed");
    notifs = (claimed.data as NotifRow[] | null) ?? [];
  } catch {
    fail("claim-failed");
    return result;
  }
  result.scanned = notifs.length;
  if (!notifs.length) return result;

  const finish = async (n: NotifRow, terminal: boolean) => {
    if (!terminal) result.deferred++;
    try {
      const completed = await supabase.rpc("finish_notification_push", {
        p_notification_id: n.id, p_claim_id: claimId, p_terminal: terminal,
      });
      if (completed.error || completed.data !== true) throw new Error("finish-failed");
    } catch {
      // Never claim success if persistence failed. The lease expires and preserves retry.
      fail("finish-failed");
      if (terminal) result.deferred++;
    }
  };
  const userIds = [...new Set(notifs.flatMap((n) => n.user_id ? [n.user_id] : []))];
  const machineIds = [...new Set(notifs.flatMap((n) =>
    typeof n.payload?.machine_id === "string" ? [n.payload.machine_id] : []))];
  let users: Map<string, UserRow>;
  let subsByUser: Map<string, SubRow[]>;
  let machineNames: Map<string, string>;
  try {
    const [usersRes, subsRes, machinesRes] = await Promise.all([
      supabase.from("users").select("id, notify_push, language").is("deleted_at", null).eq("active", true).in("id", userIds),
      supabase.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").is("deleted_at", null).in("user_id", userIds),
      machineIds.length
        ? supabase.from("machines").select("id, name").in("id", machineIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
    ]);
    // A failed lookup is not the same as no users/subscriptions: retain the whole batch.
    if (usersRes.error || subsRes.error || machinesRes.error) throw new Error("lookup-failed");
    users = new Map(((usersRes.data as UserRow[] | null) ?? []).map((u) => [u.id, u]));
    subsByUser = new Map();
    for (const sub of (subsRes.data as SubRow[] | null) ?? []) {
      const list = subsByUser.get(sub.user_id) ?? [];
      list.push(sub);
      subsByUser.set(sub.user_id, list);
    }
    machineNames = new Map(((machinesRes.data as { id: string; name: string }[] | null) ?? []).map((m) => [m.id, m.name]));
  } catch {
    fail("lookup-failed");
    await Promise.all(notifs.map((n) => finish(n, false)));
    return result;
  }

  const pruned = new Set<string>();
  for (const n of notifs) {
    if (deps.now() >= deadline) {
      await finish(n, false);
      continue;
    }
    const user = n.user_id ? users.get(n.user_id) : undefined;
    const subs = user?.notify_push ? subsByUser.get(user.id) ?? [] : [];
    let terminal = true;
    const acknowledged = new Set(n.delivered_subscription_ids ?? []);
    for (const sub of subs) {
      if (acknowledged.has(sub.id) || pruned.has(sub.id)) continue;
      if (deps.now() >= deadline) { terminal = false; break; }
      try {
        const payload = n.payload ?? {};
        const locale: Lang = user?.language ?? "en";
        const statusCode = validateWebPushSubscription(sub)
          ? (await deps.send(sub, {
            title: notificationTitle(n.template, locale),
            body: pushBody(n, locale, machineNames.get(payload.machine_id as string)),
            url: notificationUrl(n.template, payload),
            tag: n.id,
          }, config)).statusCode
          : 410; // Invalid legacy endpoints are terminal and must never reach fetch.
        if (statusCode === 404 || statusCode === 410) {
          const removed = await supabase.from("push_subscriptions")
            .update({ deleted_at: new Date(deps.now()).toISOString() }).eq("id", sub.id).eq("user_id", sub.user_id);
          if (removed.error) throw new Error("prune-failed");
          pruned.add(sub.id);
          result.pruned++;
        } else if (statusCode >= 200 && statusCode < 300) {
          result.pushed++;
          const ack = await supabase.rpc("ack_notification_push", {
            p_notification_id: n.id, p_claim_id: claimId, p_subscription_id: sub.id,
          });
          if (ack.error || ack.data !== true) throw new Error("ack-failed");
        } else {
          terminal = false;
          fail("provider-rejected"); // Includes 401/403: fixing VAPID must permit a retry.
        }
      } catch {
        terminal = false;
        fail("delivery-failed");
      }
    }
    // Opted-out/deleted users, no devices, and expired devices are terminal only after
    // successful lookups/pruning. Failed providers remain queued.
    await finish(n, terminal);
  }
  return result;
}
