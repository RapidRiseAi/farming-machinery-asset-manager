import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { formatNotification } from "@/lib/notifications/format";
import { markRead, markAllRead, setNotificationPrefs } from "./actions";
import { PushToggle } from "@/components/push/push-toggle";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { EmptyState } from "@/components/ui/empty-state";
import { BellIcon } from "@/components/ui/icons";

type Note = {
  id: string; template: string; payload: Record<string, unknown>;
  read_at: string | null; created_at: string;
};
type Prefs = {
  notify_inapp: boolean; notify_push: boolean;
  quiet_hours_start: number | null; quiet_hours_end: number | null;
};

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.language;
  const sp = await searchParams;
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const [noteRes, prefRes] = await Promise.all([
    supabase
      .from("notifications")
      .select("id, template, payload, read_at, created_at")
      .eq("user_id", profile.id)
      .or(`deliver_after.is.null,deliver_after.lte.${nowIso}`)
      .order("created_at", { ascending: false })
      .limit(60),
    supabase
      .from("users")
      .select("notify_inapp, notify_push, quiet_hours_start, quiet_hours_end")
      .eq("id", profile.id)
      .maybeSingle(),
  ]);
  const notes = (noteRes.data as Note[] | null) ?? [];
  const prefs = (prefRes.data as Prefs | null) ?? {
    notify_inapp: true, notify_push: true, quiet_hours_start: null, quiet_hours_end: null,
  };

  const mIds = [...new Set(notes.map((n) => n.payload?.machine_id).filter(Boolean) as string[])];
  const { data: ms } = mIds.length ? await supabase.from("machines").select("id, name").in("id", mIds) : { data: [] };
  const nameById = Object.fromEntries(((ms as { id: string; name: string }[] | null) ?? []).map((m) => [m.id, m.name]));

  const message = (n: Note): string =>
    formatNotification(n.template, n.payload ?? {}, locale, nameById[n.payload?.machine_id as string]);

  const hasUnread = notes.some((n) => n.read_at == null);
  const check = "h-5 w-5 rounded border-sand-300 text-brand-600";

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

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      {/* Per-user preferences (FR-14.3) */}
      <Card>
        <CardHeader><CardTitle>{t("prefs.title", locale)}</CardTitle></CardHeader>
        <form action={setNotificationPrefs} className="flex flex-col gap-3">
          <label className="flex items-center gap-2.5 text-sm text-sand-800">
            <input type="checkbox" name="notify_inapp" defaultChecked={prefs.notify_inapp} className={check} />
            {t("prefs.inapp", locale)}
          </label>
          <label className="flex items-center gap-2.5 text-sm text-sand-800">
            <input type="checkbox" name="notify_push" defaultChecked={prefs.notify_push} className={check} />
            {t("prefs.push", locale)}
          </label>
          <div>
            <p className="mb-1 text-sm font-medium text-sand-700">{t("prefs.quietHours", locale)}</p>
            <p className="mb-2 text-xs text-sand-500">{t("prefs.quietHoursHint", locale)}</p>
            <div className="grid grid-cols-2 gap-3 sm:max-w-xs">
              <Field label={t("prefs.quietStart", locale)} htmlFor="quiet_hours_start">
                <Input id="quiet_hours_start" name="quiet_hours_start" type="number" min={0} max={23}
                  defaultValue={prefs.quiet_hours_start ?? ""} placeholder={t("prefs.inherit", locale)} />
              </Field>
              <Field label={t("prefs.quietEnd", locale)} htmlFor="quiet_hours_end">
                <Input id="quiet_hours_end" name="quiet_hours_end" type="number" min={0} max={23}
                  defaultValue={prefs.quiet_hours_end ?? ""} placeholder={t("prefs.inherit", locale)} />
              </Field>
            </div>
          </div>
          <SubmitButton variant="primary" className="self-start">{t("prefs.save", locale)}</SubmitButton>
        </form>
        <div className="mt-4 border-t border-sand-100 pt-3">
          <p className="mb-2 text-sm font-medium text-sand-700">{t("push.title", locale)}</p>
          <PushToggle locale={locale} />
        </div>
      </Card>

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
