import { t, type Lang } from "@/lib/i18n";
import { dateTime } from "@/lib/format";
import { mailtoHref, telHref, waHref } from "@/lib/contact";
import { isWeekdays } from "@/lib/support/sla";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";

/**
 * Pieces the customer's help pages and Rapid Rise's support desk share. Server components:
 * no state, nothing to attach.
 */

export type SupportContact = {
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  timezone: string | null;
  opens_at: string | null;
  closes_at: string | null;
  same_day_cutoff: string | null;
  next_day_due: string | null;
  working_days: number[] | null;
};

const fill = (s: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((out, [k, v]) => out.replace(`{${k}}`, () => v), s);

/** "Weekdays, 09:00 to 17:00, South African time" from the support settings row. */
export function hoursLine(c: SupportContact | null, locale: Lang): string {
  const opens = c?.opens_at ?? "09:00";
  const closes = c?.closes_at ?? "17:00";
  const days = c?.working_days?.length ? c.working_days.map(Number) : [1, 2, 3, 4, 5];
  const dayWords = isWeekdays(days)
    ? t("support.weekdays", locale)
    : days
        .slice()
        .sort((a, b) => a - b)
        .map((d) => t(`support.day.d${d}`, locale))
        .join(", ");
  return fill(t("support.hoursLine", locale), { days: dayWords, opens, closes });
}

/** The same-day promise, in the desk's own numbers. */
export function promiseLine(c: SupportContact | null, locale: Lang): string {
  return fill(t("support.promiseLine", locale), {
    cutoff: c?.same_day_cutoff ?? "16:00",
    closes: c?.closes_at ?? "17:00",
    next: c?.next_day_due ?? "12:00",
  });
}

/**
 * How to reach a person. Phone and WhatsApp appear only once Rapid Rise has confirmed and
 * entered them (support settings); until then email, this app and the hours.
 */
export function ContactCard({ contact, fallbackEmail, locale }: { contact: SupportContact | null; fallbackEmail: string; locale: Lang }) {
  const email = contact?.email || fallbackEmail;
  const mail = mailtoHref(email);
  const tel = telHref(contact?.phone);
  const wa = waHref(contact?.whatsapp);
  const link = "focus-ring rounded font-medium text-brand-ink underline underline-offset-2 break-all";
  return (
    <Card>
      <CardTitle>{t("support.contactTitle", locale)}</CardTitle>
      <div className="mt-2 flex flex-col gap-2 text-sm text-sand-700">
        <p>{hoursLine(contact, locale)}</p>
        <p>{t("support.holidaysClosed", locale)}</p>
        <p>{promiseLine(contact, locale)}</p>
        <ul className="mt-1 flex flex-col gap-2">
          <li>{t("support.channelInApp", locale)}</li>
          {mail ? (
            <li>
              {t("support.channelEmail", locale)}{" "}
              <a href={mail} className={link}>{email}</a>
            </li>
          ) : null}
          {tel ? (
            <li>
              {t("support.channelPhone", locale)}{" "}
              <a href={tel} className={link}>{contact?.phone}</a>
            </li>
          ) : null}
          {wa ? (
            <li>
              {t("support.channelWhatsApp", locale)}{" "}
              <a href={wa} className={link} target="_blank" rel="noopener noreferrer">{contact?.whatsapp}</a>
            </li>
          ) : null}
        </ul>
      </div>
    </Card>
  );
}

/** The customer's words for a case's state. */
const CUSTOMER_STATUS: Record<string, { tone: BadgeTone; key: string }> = {
  open: { tone: "brand", key: "help.statusOpen" },
  waiting: { tone: "warning", key: "help.statusWaiting" },
  resolved: { tone: "ok", key: "help.statusResolved" },
  closed: { tone: "neutral", key: "help.statusClosed" },
};

export function CustomerStatusBadge({ status, locale }: { status: string; locale: Lang }) {
  const look = CUSTOMER_STATUS[status] ?? CUSTOMER_STATUS.open;
  return <Badge tone={look.tone}>{t(look.key, locale)}</Badge>;
}

/** Rapid Rise's words for a case's state. */
const STAFF_STATUS: Record<string, BadgeTone> = { open: "brand", waiting: "warning", resolved: "ok", closed: "neutral" };

export function StaffStatusBadge({ status, locale }: { status: string; locale: Lang }) {
  return <Badge tone={STAFF_STATUS[status] ?? "neutral"}>{t(`support.status.${status in STAFF_STATUS ? status : "open"}`, locale)}</Badge>;
}

export type ThreadMessage = {
  id: string;
  author_kind: "customer" | "staff" | "system";
  author_name?: string | null;
  visibility?: "public" | "internal";
  channel?: string | null;
  mine?: boolean;
  body: string;
  created_at: string;
  emailed_at?: string | null;
  email_error?: string | null;
};

/**
 * One conversation, oldest first. `staffView` shows internal notes (marked), the channel a
 * logged conversation came by, the staff member's name and whether the reply email went.
 * The customer's view names Rapid Rise as Fleet Wise support and never a staff member.
 */
export function MessageThread({ messages, locale, staffView = false }: { messages: ThreadMessage[]; locale: Lang; staffView?: boolean }) {
  return (
    <ol className="flex flex-col gap-3">
      {messages.map((m) => {
        const internal = m.visibility === "internal";
        const staff = m.author_kind !== "customer";
        const who = staff
          ? staffView
            ? m.author_name || t("support.authorStaff", locale)
            : t("support.authorStaff", locale)
          : m.mine
            ? t("support.authorYou", locale)
            : m.author_name || t("support.authorCustomer", locale);
        return (
          <li
            key={m.id}
            className={cn(
              "rounded-xl border p-3 sm:p-4",
              internal
                ? "border-callout-warn-edge bg-callout-warn-bg"
                : staff
                  ? "border-sand-200 bg-surface"
                  : "border-sand-200 bg-surface-hover",
            )}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-sand-600">
              <span className="font-semibold text-ink">{who}</span>
              {internal ? <Badge tone="warning">{t("support.internalNote", locale)}</Badge> : null}
              {staffView && m.channel && m.channel !== "in_app" ? (
                <Badge tone="info">{t(`support.channel.${m.channel}`, locale)}</Badge>
              ) : null}
              <span>{dateTime(m.created_at, locale)}</span>
            </div>
            <p className={cn("mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed", internal ? "text-callout-warn-ink" : "text-ink")}>{m.body}</p>
            {staffView && m.author_kind === "staff" && !internal ? (
              <p className="mt-2 text-xs text-sand-600">
                {m.emailed_at
                  ? fill(t("support.emailedAt", locale), { when: dateTime(m.emailed_at, locale) })
                  : m.email_error
                    ? fill(t("support.emailFailed", locale), { reason: m.email_error })
                    : t("support.emailPending", locale)}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
