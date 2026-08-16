import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop, checkWorkshopEntitlement } from "@/lib/auth";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import {
  isDue,
  isLive,
  scheduleTotalCents,
  annualisedExCents,
  SCHEDULE_ERROR_KEYS,
  type ExpenseSchedule,
} from "@/lib/recurring-expenses";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { GetStarted } from "@/components/ui/empty-state";
import { ExpenseScheduleForm } from "@/components/recurring-expenses/schedule-form";

export const dynamic = "force-dynamic";

/**
 * Standing costs (G19) — the cost-side mirror of `/recurring`.
 *
 * The failure this screen exists to prevent is not paying the wrong amount, it is not
 * RECORDING the payment. Rent that goes off by debit order and is never captured leaves a
 * partner reading a profit figure that is too high, an input-VAT claim that is too small
 * and a creditors list that is too short — and nothing anywhere says so, because the row
 * that would have said it was never written. So the list leads with what is about to go
 * out, not with what exists.
 */
export default async function RecurringExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect("/expenses");
  const locale = profile.lang;
  const sp = await searchParams;

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  // Running the books here is the `books` product (0492). Denied BEFORE any query runs,
  // so a partner without it never causes the data to be read, let alone rendered.
  const gate = await checkWorkshopEntitlement("financials", profile);
  if (!gate.allowed) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <UpgradeNotice
          feature="financials"
          requiredPlan={gate.requiredPlan}
          currentPlan={gate.plan}
          locale={locale}
        />
      </div>
    );
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("recurring_expenses")
    .select("*")
    .is("deleted_at", null)
    .order("next_due_date");

  const schedules = (data ?? []) as ExpenseSchedule[];
  const due = schedules.filter((s) => isDue(s));
  const live = schedules.filter((s) => isLive(s));

  // What the partner has committed to over a year, across everything still running. The
  // number that makes somebody open a schedule they have not looked at since they set it
  // up — a monthly figure never does.
  const committedExCents = live.reduce((sum, s) => sum + annualisedExCents(s), 0);
  const dueTotalCents = due.reduce((sum, s) => sum + scheduleTotalCents(s), 0);

  const errorKey = sp.error ? SCHEDULE_ERROR_KEYS[sp.error] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-sand-900">{t("recexp.title", locale)}</h1>
        <p className="text-sm text-sand-600">{t("recexp.lead", locale)}</p>
      </div>

      <Flash tone="error" message={errorKey ? t(errorKey, locale) : sp.error} />
      <Flash tone="success" message={sp.deleted ? t("recexp.deletedFlash", locale) : undefined} />

      {due.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("recexp.dueTitle", locale)}</CardTitle>
          </CardHeader>
          <p className="mb-3 text-sm text-sand-600">
            {t("recexp.dueBody", locale)}{" "}
            <span className="font-semibold tabular-nums text-sand-900">{rands(dueTotalCents)}</span>
          </p>
          <ul className="flex flex-col gap-2">
            {due.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/recurring-expenses/${s.id}`}
                  className="focus-ring flex flex-wrap items-center gap-2 rounded-lg border border-sand-200 px-3 py-2.5 hover:bg-sand-50"
                >
                  <span className="font-medium text-sand-900">{s.name}</span>
                  <Badge tone="warning">{t("recexp.dueBadge", locale)}</Badge>
                  <span className="text-sm text-sand-600">{s.supplier_name}</span>
                  <span className="ml-auto tabular-nums text-sm text-sand-800">{rands(scheduleTotalCents(s))}</span>
                  {/* A span, not a link: the whole row is already an anchor, and nesting
                      one inside another is invalid HTML the browser silently un-nests —
                      which is what threw React #418 on the machines list. */}
                  <span className="text-sm font-medium text-brand-700">{t("recexp.dueOpen", locale)} →</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <ExpenseScheduleForm locale={locale} vatRegistered={workshop.vat_registered !== false} />

      <Card>
        <CardHeader>
          <CardTitle>{t("recexp.listTitle", locale)}</CardTitle>
        </CardHeader>
        {schedules.length === 0 ? (
          <GetStarted title={t("recexp.emptyTitle", locale)} hint={t("recexp.emptyBody", locale)} />
        ) : (
          <>
            <p className="mb-3 text-sm text-sand-600">
              {t("recexp.committed", locale)}{" "}
              <span className="font-semibold tabular-nums text-sand-900">{rands(committedExCents)}</span>{" "}
              {t("recexp.committedSuffix", locale)}
            </p>
            <ul className="flex flex-col divide-y divide-sand-100">
              {schedules.map((s) => (
                <li key={s.id} className="py-2.5">
                  <Link href={`/recurring-expenses/${s.id}`} className="focus-ring flex flex-wrap items-center gap-2 rounded">
                    <span className="font-medium text-sand-900">{s.name}</span>
                    <Badge tone="neutral">{t(`cadence.${s.cadence}`, locale)}</Badge>
                    <Badge tone="neutral">{t(`expenseCategory.${s.category}`, locale)}</Badge>
                    {s.auto_paid ? <Badge tone="info">{t("recexp.autoPaidBadge", locale)}</Badge> : null}
                    {!isLive(s) ? <Badge tone="neutral">{t("recexp.pausedBadge", locale)}</Badge> : null}
                    <span className="ml-auto tabular-nums text-sm text-sand-800">{rands(scheduleTotalCents(s))}</span>
                  </Link>
                  <p className="mt-0.5 text-xs text-sand-500">
                    {s.supplier_name}
                    {" · "}
                    {isLive(s)
                      ? `${t("recexp.nextOn", locale)} ${shortDate(s.next_due_date, locale)}`
                      : t("recexp.stopped", locale)}
                    {s.last_period_start ? ` · ${t("recexp.lastCaptured", locale)} ${shortDate(s.last_period_start, locale)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <p className="text-sm text-sand-500">{t("recexp.footnote", locale)}</p>
    </div>
  );
}
