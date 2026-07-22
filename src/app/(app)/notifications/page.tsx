import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { markRead, markAllRead } from "./actions";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { BellIcon } from "@/components/ui/icons";

type Note = {
  id: string; template: string; payload: Record<string, unknown>;
  read_at: string | null; created_at: string;
};

export default async function NotificationsPage() {
  const profile = await requireProfile();
  const locale = profile.language;
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const { data } = await supabase
    .from("notifications")
    .select("id, template, payload, read_at, created_at")
    .eq("user_id", profile.id)
    .or(`deliver_after.is.null,deliver_after.lte.${nowIso}`)
    .order("created_at", { ascending: false })
    .limit(60);
  const notes = (data as Note[] | null) ?? [];

  const mIds = [...new Set(notes.map((n) => n.payload?.machine_id).filter(Boolean) as string[])];
  const { data: ms } = mIds.length ? await supabase.from("machines").select("id, name").in("id", mIds) : { data: [] };
  const nameById = Object.fromEntries(((ms as { id: string; name: string }[] | null) ?? []).map((m) => [m.id, m.name]));

  const message = (n: Note): string => {
    const p = n.payload ?? {};
    const m = nameById[p.machine_id as string] ?? (p.machine_name as string) ?? "";
    const fill = (key: string, vars: Record<string, string>) => {
      let s = t(key, locale);
      for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
      return s;
    };
    switch (n.template) {
      case "service_due_soon": return fill("notifications.tplServiceDueSoon", { machine: m, task: String(p.task ?? "") });
      case "service_overdue": return fill("notifications.tplServiceOverdue", { machine: m, task: String(p.task ?? "") });
      case "stale_meter": return fill("notifications.tplStaleMeter", { count: String(p.count ?? 0) });
      case "weekly_digest": return fill("notifications.tplWeeklyDigest", { overdue: String(p.overdue_count ?? 0), dueSoon: String(p.due_soon_count ?? 0), faults: String(p.open_faults_count ?? 0) });
      case "fault_reported": return fill("notifications.tplFaultReported", { machine: m, description: String(p.description ?? ""), urgency: String(p.urgency ?? "") });
      case "job_completed": return fill("notifications.tplJobCompleted", { machine: m, total: rands(p.total_cents as number) });
      default: return n.template;
    }
  };

  const hasUnread = notes.some((n) => n.read_at == null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("notifications.title", locale)}</h1>
        {hasUnread ? (
          <form action={markAllRead}>
            <Button type="submit" variant="ghost" size="sm">{t("notifications.markAllRead", locale)}</Button>
          </form>
        ) : null}
      </div>

      {notes.length === 0 ? (
        <EmptyState icon={<BellIcon />} title={t("notifications.empty", locale)} hint={t("notifications.emptyHint", locale)} />
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((n) => {
            const unread = n.read_at == null;
            return (
              <li key={n.id}>
                <Card className={unread ? "border-brand-200" : "opacity-75"}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className={`text-sm ${unread ? "font-medium text-sand-900" : "text-sand-600"}`}>{message(n)}</p>
                      <p className="mt-0.5 text-xs text-sand-400">{new Date(n.created_at).toLocaleDateString("en-ZA")}</p>
                    </div>
                    <span className="flex shrink-0 items-center gap-2">
                      {unread ? <Badge tone="brand">{t("notifications.unread", locale)}</Badge> : null}
                      {unread ? (
                        <form action={markRead}>
                          <input type="hidden" name="id" value={n.id} />
                          <button className="focus-ring rounded border border-sand-300 px-2 py-0.5 text-xs hover:bg-sand-50">{t("notifications.read", locale)}</button>
                        </form>
                      ) : null}
                    </span>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
