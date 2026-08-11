import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { shortDate } from "@/lib/format";
import { isDue, isLive, type Schedule } from "@/lib/recurring";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { GetStarted } from "@/components/ui/empty-state";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { ScheduleForm } from "@/components/recurring/schedule-form";

export const dynamic = "force-dynamic";

type Party = { key: string; label: string; farm_id: string | null; client_id: string | null };

/**
 * Standing invoices (G8).
 *
 * The failure this screen exists to prevent is not billing the wrong amount — it is
 * forgetting entirely. A monthly service contract that nobody raises for three months is
 * three months of income that simply never happened, and there was nothing anywhere to
 * notice it. So the list leads with what is due, not with what exists.
 */
export default async function RecurringPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect("/documents");
  const locale = profile.lang;
  const sp = await searchParams;

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const supabase = await createClient();
  const [{ data: scheduleData }, { data: linkData }, { data: clientData }] = await Promise.all([
    supabase.from("recurring_invoices").select("*").is("deleted_at", null).order("next_issue_date"),
    supabase
      .from("workshop_links")
      .select("farm_id, farms(id, name)")
      .eq("workshop_id", workshop.id)
      .eq("status", "active")
      .is("deleted_at", null),
    supabase.from("partner_clients").select("id, name").is("deleted_at", null).order("name"),
  ]);

  const schedules = (scheduleData ?? []) as Schedule[];

  // The same recipient set the document form offers, so a schedule cannot be aimed
  // anywhere a one-off invoice could not.
  const parties: Party[] = [
    // PostgREST types an embedded row as an array; take the first (there is exactly one).
    ...((linkData ?? []) as unknown as { farm_id: string; farms: { name: string }[] | { name: string } | null }[]).map((l) => ({
      key: `farm:${l.farm_id}`,
      label: (Array.isArray(l.farms) ? l.farms[0]?.name : l.farms?.name) ?? l.farm_id,
      farm_id: l.farm_id,
      client_id: null,
    })),
    ...((clientData ?? []) as { id: string; name: string }[]).map((c) => ({
      key: `client:${c.id}`,
      label: c.name,
      farm_id: null,
      client_id: c.id,
    })),
  ];

  const due = schedules.filter((s) => isDue(s));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-sand-900">{t("recurring.title", locale)}</h1>
          <p className="text-sm text-sand-600">{t("recurring.lead", locale)}</p>
        </div>
        <span className="ml-auto">
          <PageInfoButton infoKey="recurring" locale={locale} />
        </span>
      </div>

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.deleted ? t("recurring.deletedFlash", locale) : undefined} />

      {due.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t("recurring.dueTitle", locale)}</CardTitle></CardHeader>
          <p className="mb-3 text-sm text-sand-600">{t("recurring.dueBody", locale)}</p>
          <ul className="flex flex-col gap-2">
            {due.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/recurring/${s.id}`}
                  className="focus-ring flex flex-wrap items-center gap-2 rounded-lg border border-sand-200 px-3 py-2.5 hover:bg-sand-50"
                >
                  <span className="font-medium text-sand-900">{s.name}</span>
                  <Badge tone="warning">{t("recurring.dueBadge", locale)}</Badge>
                  <span className="ml-auto text-sm text-sand-600">{shortDate(s.next_issue_date, locale)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <ScheduleForm locale={locale} parties={parties} defaultVatBps={workshop.vat_registered === false ? 0 : 1500} />

      <Card>
        <CardHeader><CardTitle>{t("recurring.listTitle", locale)}</CardTitle></CardHeader>
        {schedules.length === 0 ? (
          <GetStarted title={t("recurring.emptyTitle", locale)} hint={t("recurring.emptyBody", locale)} />
        ) : (
          <ul className="flex flex-col divide-y divide-sand-100">
            {schedules.map((s) => (
              <li key={s.id} className="py-2.5">
                <Link href={`/recurring/${s.id}`} className="focus-ring flex flex-wrap items-center gap-2 rounded">
                  <span className="font-medium text-sand-900">{s.name}</span>
                  <Badge tone="neutral">{t(`cadence.${s.cadence}`, locale)}</Badge>
                  {s.auto_send ? <Badge tone="info">{t("recurring.autoSendBadge", locale)}</Badge> : null}
                  {!isLive(s) ? <Badge tone="neutral">{t("recurring.pausedBadge", locale)}</Badge> : null}
                  <span className="ml-auto text-sm text-sand-600">
                    {isLive(s)
                      ? `${t("recurring.nextOn", locale)} ${shortDate(s.next_issue_date, locale)}`
                      : t("recurring.stopped", locale)}
                  </span>
                </Link>
                {s.last_document_id ? (
                  <p className="mt-0.5 text-xs text-sand-500">
                    {t("recurring.lastRaised", locale)}{" "}
                    <Link href={`/documents/${s.last_document_id}`} className="focus-ring rounded text-brand-700 underline-offset-2 hover:underline">
                      {s.last_period_start ? shortDate(s.last_period_start, locale) : t("recurring.lastRaisedOnce", locale)}
                    </Link>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-sm text-sand-500">{t("recurring.footnote", locale)}</p>
    </div>
  );
}
