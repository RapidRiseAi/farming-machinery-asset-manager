import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { t, type Lang } from "@/lib/i18n";
import { formatNotification, notificationUrl } from "@/lib/notifications/format";
import { countLabel, daysAgo, quietHoursRange } from "@/lib/format";
import { markAllRead, openNotification } from "./actions";
import { Card } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { AllClear } from "@/components/ui/empty-state";
import { BellIcon, ChevronRightIcon, SettingsIcon } from "@/components/ui/icons";
import { DateText } from "@/components/ui/date-text";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { cn } from "@/components/ui/cn";

type Note = {
  id: string; template: string; payload: Record<string, unknown>;
  read_at: string | null; created_at: string;
};
type Prefs = {
  notify_inapp: boolean; notify_push: boolean; notify_email: boolean;
  quiet_hours_start: number | null; quiet_hours_end: number | null;
};

/** One screenful and a bit. Older alerts page with `?before=<created_at>`. */
const PAGE_SIZE = 40;

/**
 * The alert feed.
 *
 * == It is a feed, not a settings page =========================================
 * This screen used to open with the preferences form: three checkboxes, two 0-23 number
 * boxes, a green Save and the push box, then the AI permission card, and only after all
 * that (about 1,100px down on a phone) the first alert. The preferences now live in the
 * Alerts card of /account, the one preferences hub, and this screen states them in one
 * muted line with a link there.
 *
 * == Every row goes somewhere ==================================================
 * Each alert with a destination is a button that posts `openNotification`, which marks
 * it read and redirects to what it is about. The destination is worked out on the
 * server from the stored row, never posted. Rows with nowhere to go are plain text.
 * Unread is one signal (a dot plus weight, with the word for screen readers), not a
 * badge plus a button plus a border.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; before?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const sp = await searchParams;
  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  // Only a real timestamp pages; anything else is the newest page.
  const before = sp.before && !Number.isNaN(Date.parse(sp.before)) ? sp.before : null;

  let noteQuery = supabase
    .from("notifications")
    .select("id, template, payload, read_at, created_at")
    .eq("user_id", profile.id)
    // The same visible set as the inbox and the unread badge (lib/inbox.ts).
    .is("deleted_at", null)
    .or(`deliver_after.is.null,deliver_after.lte.${nowIso}`)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE + 1);
  if (before) noteQuery = noteQuery.lt("created_at", before);

  const [noteRes, prefRes, farmRes, unreadRes] = await Promise.all([
    noteQuery,
    supabase
      .from("users")
      .select("notify_inapp, notify_push, notify_email, quiet_hours_start, quiet_hours_end")
      .eq("id", profile.id)
      .maybeSingle(),
    profile.farm_id
      ? supabase.from("farms").select("settings").eq("id", profile.farm_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", profile.id)
      .is("deleted_at", null)
      .is("read_at", null)
      .or(`deliver_after.is.null,deliver_after.lte.${nowIso}`),
  ]);
  const rows = (noteRes.data as Note[] | null) ?? [];
  const hasOlder = rows.length > PAGE_SIZE;
  const notes = rows.slice(0, PAGE_SIZE);
  const unreadCount = unreadRes.count ?? 0;
  const prefs = (prefRes.data as Prefs | null) ?? {
    notify_inapp: true, notify_push: true, notify_email: false, quiet_hours_start: null, quiet_hours_end: null,
  };
  const farmSettings = ((farmRes.data as { settings: Record<string, unknown> | null } | null)?.settings ?? {}) as Record<
    string,
    unknown
  >;

  const mIds = [...new Set(notes.map((n) => n.payload?.machine_id).filter(Boolean) as string[])];
  const { data: ms } = mIds.length ? await supabase.from("machines").select("id, name").in("id", mIds) : { data: [] };
  const nameById = Object.fromEntries(((ms as { id: string; name: string }[] | null) ?? []).map((m) => [m.id, m.name]));

  const message = (n: Note): string =>
    formatNotification(n.template, n.payload ?? {}, locale, nameById[n.payload?.machine_id as string]);

  // Today / Yesterday / Earlier, by the farm's calendar day.
  const groups: { key: string; label: string; notes: Note[] }[] = [
    { key: "today", label: t("format.today", locale), notes: [] },
    { key: "yesterday", label: t("format.yesterday", locale), notes: [] },
    { key: "earlier", label: t("notifications.earlier", locale), notes: [] },
  ];
  for (const n of notes) {
    const d = daysAgo(n.created_at) ?? 99;
    groups[d <= 0 ? 0 : d === 1 ? 1 : 2].notes.push(n);
  }

  const lastCreated = notes.length ? notes[notes.length - 1].created_at : null;

  return (
    <PageContainer size="narrow">
      <PageHeader
        title={t("notifications.title", locale)}
        lead={prefsSummary(prefs, farmSettings, locale)}
        meta={
          unreadCount > 0
            ? countLabel(unreadCount, "notifications.unreadOne", "notifications.unreadMany", locale)
            : undefined
        }
        infoKey="notifications"
        locale={locale}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {unreadCount > 0 ? (
              <form action={markAllRead}>
                <SubmitButton variant="secondary" size="sm">
                  {t("notifications.markAllRead", locale)}
                </SubmitButton>
              </form>
            ) : null}
            <Link href="/account#alerts" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              <SettingsIcon aria-hidden />
              {t("notifications.alertSettings", locale)}
            </Link>
          </div>
        }
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      {notes.length === 0 ? (
        <AllClear icon={<BellIcon />} title={t("notifications.empty", locale)} hint={t("notifications.emptyHint", locale)} />
      ) : (
        groups
          .filter((g) => g.notes.length > 0)
          .map((g) => (
            <section key={g.key} aria-labelledby={`alerts-${g.key}`} className="flex flex-col gap-2">
              <h2 id={`alerts-${g.key}`} className="text-sm font-semibold text-sand-600">
                {g.label}
              </h2>
              <Card flush>
                <ul className="divide-y divide-sand-100">
                  {g.notes.map((n) => {
                    const unread = n.read_at == null;
                    const href = notificationUrl(n.template, n.payload ?? {});
                    const body = (
                      <>
                        <span
                          aria-hidden
                          className={cn(
                            "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full",
                            unread ? "bg-brand-ink" : "bg-transparent",
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          {unread ? <span className="sr-only">{t("notifications.unread", locale)}: </span> : null}
                          <span
                            className={cn(
                              "block break-words text-sm",
                              unread ? "font-semibold text-ink" : "text-sand-600",
                            )}
                          >
                            {message(n)}
                          </span>
                          <DateText
                            value={n.created_at}
                            locale={locale}
                            format={g.key === "earlier" ? "auto" : "dayTime"}
                            className="mt-0.5 block text-xs text-sand-500"
                          />
                        </span>
                      </>
                    );
                    const row = "flex w-full min-h-[48px] items-start gap-3 px-4 py-3 text-left";
                    return (
                      <li key={n.id}>
                        {href !== "/notifications" ? (
                          <form action={openNotification}>
                            <input type="hidden" name="id" value={n.id} />
                            <button
                              type="submit"
                              className={cn(row, "focus-ring transition-colors hover:bg-surface-sunken")}
                            >
                              {body}
                              <ChevronRightIcon aria-hidden className="mt-0.5 shrink-0 text-lg text-sand-400" />
                            </button>
                          </form>
                        ) : (
                          <div className={row}>{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </section>
          ))
      )}

      {hasOlder || before ? (
        <div className="flex flex-wrap gap-2">
          {hasOlder && lastCreated ? (
            <Link
              href={`/notifications?before=${encodeURIComponent(lastCreated)}`}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              {t("notifications.showOlder", locale)}
            </Link>
          ) : null}
          {before ? (
            <Link href="/notifications" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              {t("notifications.backToNewest", locale)}
            </Link>
          ) : null}
        </div>
      ) : null}
    </PageContainer>
  );
}

/**
 * The person's alert settings in one sentence: which channels reach them and their
 * quiet hours, the farm's window when they have not set their own.
 */
function prefsSummary(prefs: Prefs, farm: Record<string, unknown>, locale: Lang): string {
  const channels = [
    prefs.notify_inapp ? t("account.inApp", locale) : null,
    prefs.notify_push ? t("account.push", locale) : null,
    prefs.notify_email ? t("account.email", locale) : null,
  ].filter(Boolean) as string[];
  const lead = channels.length
    ? t("notifications.summaryChannels", locale).replace("{channels}", channels.join(", "))
    : t("notifications.summaryNone", locale);
  const own = prefs.quiet_hours_start != null && prefs.quiet_hours_end != null;
  const farmHour = (k: string, d: number) => (typeof farm[k] === "number" ? (farm[k] as number) : d);
  const range = own
    ? quietHoursRange(prefs.quiet_hours_start, prefs.quiet_hours_end, locale)
    : quietHoursRange(farmHour("quiet_hours_start", 20), farmHour("quiet_hours_end", 5), locale);
  return `${lead} ${t("notifications.summaryQuiet", locale).replace("{range}", range)}`;
}
