import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, effectiveFarmRole, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { readAll } from "@/lib/supabase/read-all";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import { t, type Lang } from "@/lib/i18n";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState, FilteredEmpty } from "@/components/ui/empty-state";
import { JobCardsIcon, ChevronRightIcon } from "@/components/ui/icons";
import { JobStatus } from "@/components/ui/status";
import { FilterBar } from "@/components/ui/filter-bar";
import { filterState } from "@/components/ui/filter-state";
import { Disclosure } from "@/components/ui/disclosure";
import { Pager, PAGE_SIZE, pageNumber, pageRange } from "@/components/ui/pager";
import { NewJobCard, type JobMachine, type JobContractor } from "./new-job-card";
import { Flash } from "@/components/ui/flash";
import { errorMessage } from "@/lib/errors";

const STATUSES = ["reported", "open", "in_progress", "waiting_parts", "completed", "approved"];
const ACTIVE = new Set(["reported", "open", "in_progress", "waiting_parts"]);

type JobCard = {
  id: string; type: string; status: string; date_in: string | null; total_cents: number | null; machine_id: string;
  work_mode: string; workshop_id: string | null; external_provider_name: string | null;
};

/**
 * Every job card on the farm, active work first.
 *
 * One list for every width: the phone cards and the desktop table said the same thing
 * in two layouts, and the table spent a whole column repeating "Open job card ->" on
 * every row. A row is the link. What is waiting for approval comes first because it is a
 * decision; approved history folds away under its count, because it is a record.
 */
export default async function JobCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; machine?: string; error?: string; page?: string }>;
}) {
  const profile = await requireProfile();
  const sp = await searchParams;
  // Current query string, so a chip preserves whatever else is filtered. Not the page: a
  // different filter starts again at its first page.
  const search = new URLSearchParams(
    Object.entries(sp).filter(([k, v]) => !!v && k !== "page") as [string, string][],
  ).toString();
  const locale = profile.lang;

  const supabase = await createClient();
  const farmId = await currentFarmId(profile);
  // Work still to do or to approve is listed whole, however old. Approved history pages,
  // newest first: a farm with years of job cards used to get the newest thousand and
  // nothing to say the rest existed.
  const page = pageNumber(sp.page);
  const jobCards = (count?: "exact") => {
    let q = supabase
      .from("job_cards_visible")
      .select("id, type, status, date_in, total_cents, machine_id, work_mode, workshop_id, external_provider_name", count ? { count } : undefined)
      .is("deleted_at", null);
    if (farmId) q = q.eq("farm_id", farmId);
    if (sp.machine) q = q.eq("machine_id", sp.machine);
    return q;
  };
  const liveStatuses = sp.status ? (sp.status === "approved" ? [] : [sp.status]) : [...ACTIVE, "completed"];
  const showHistory = !sp.status || sp.status === "approved";
  const [liveRes, historyRes] = await Promise.all([
    liveStatuses.length
      ? readAll<JobCard>(() => jobCards().in("status", liveStatuses).order("created_at", { ascending: false }))
      : Promise.resolve({ data: [] as JobCard[], error: null }),
    showHistory
      ? jobCards("exact").eq("status", "approved").order("created_at", { ascending: false }).order("id").range(...pageRange(page))
      : Promise.resolve({ data: [] as JobCard[], error: null, count: 0 }),
  ]);
  const error = (liveRes.error ?? historyRes.error) as { message?: string } | null;
  const historyRows = (historyRes.data as JobCard[] | null) ?? [];
  const hasOlder = historyRows.length > PAGE_SIZE;
  const approvedCount = historyRes.count ?? historyRows.length;
  // A page number past the end (a bookmark, or history since deleted) goes back to the
  // first page rather than showing an empty list as if there were none.
  if (page > 1 && historyRows.length === 0) redirect(`/jobcards${search ? `?${search}` : ""}`);
  const cards = [...((liveRes.data as JobCard[] | null) ?? []), ...historyRows.slice(0, PAGE_SIZE)];
  const pageHref = (n: number) => {
    const next = new URLSearchParams(search);
    next.set("page", String(n));
    return `/jobcards?${next.toString()}`;
  };
  const pager = (
    <Pager page={page} hasOlder={hasOlder} href={pageHref} label={t("ui.pages", locale)}
      newerLabel={t("ui.pageNewer", locale)} olderLabel={t("ui.pageOlder", locale)} />
  );

  let machineQuery = supabase.from("machines").select("id, name, farm_id").is("deleted_at", null).order("name");
  if (farmId) machineQuery = machineQuery.eq("farm_id", farmId);
  const { data: ms, error: machineError } = await machineQuery;
  const machines = (ms as JobMachine[] | null) ?? [];
  const farmRoles = new Map(await Promise.all([...new Set(machines.map((machine) => machine.farm_id))].map(async (farmId) => [farmId, profile.role === "workshop" ? "workshop" : await effectiveFarmRole(farmId, profile)] as const)));
  const creationMachines = machines.filter((machine) => ["owner", "manager", "mechanic", "workshop", "rr_admin"].includes(farmRoles.get(machine.farm_id) ?? "")).map((machine) => ({ ...machine, allowExternal: ["owner", "manager", "rr_admin"].includes(farmRoles.get(machine.farm_id) ?? "") }));
  const [{ data: links, error: linkError }, { data: workshops, error: workshopError }] = await Promise.all([
    supabase.from("workshop_links").select("workshop_id, farm_id").eq("status", "active").is("deleted_at", null),
    supabase.from("workshops").select("id, name").is("deleted_at", null),
  ]);
  const contractorNames = new Map(((workshops ?? []) as { id: string; name: string }[]).map((w) => [w.id, w.name]));
  const contractors: JobContractor[] = ((links ?? []) as { workshop_id: string; farm_id: string }[])
    .filter((link) => contractorNames.has(link.workshop_id))
    .map((link) => ({ id: link.workshop_id, farm_id: link.farm_id, name: contractorNames.get(link.workshop_id)! }));
  const nameById = Object.fromEntries(machines.map((m) => [m.id, m.name]));

  const groups = [
    {
      paramName: "status",
      label: t("machines.status", locale),
      current: sp.status,
      options: [
        { value: "", label: t("jobcards.allStatuses", locale) },
        ...STATUSES.map((s) => ({ value: s, label: t(`jobStatus.${s}`, locale) })),
      ],
    },
    {
      paramName: "machine",
      label: t("jobcards.machine", locale),
      current: sp.machine,
      options: [
        { value: "", label: t("jobcards.allMachines", locale) },
        ...machines.map((m) => ({ value: m.id, label: m.name })),
      ],
    },
  ];
  const filters = filterState("/jobcards", search, groups);

  const who = (c: JobCard) => c.workshop_id
    ? contractorNames.get(c.workshop_id) ?? t("jobcards.workflow.external", locale)
    : c.work_mode === "external" ? c.external_provider_name ?? t("jobcards.workflow.external", locale) : t("jobview.ours", locale);

  const review = cards.filter((c) => c.status === "completed");
  const active = cards.filter((c) => ACTIVE.has(c.status));
  const done = cards.filter((c) => c.status === "approved");
  const rows = (list: JobCard[]) => (
    <Card flush>
      <ul className="divide-y divide-sand-100">
        {list.map((c) => <JobRow key={c.id} card={c} machine={nameById[c.machine_id] ?? "-"} who={who(c)} locale={locale} />)}
      </ul>
    </Card>
  );

  return (
    <PageContainer>
      <PageHeader title={t("jobcards.title", locale)} infoKey="jobcards" locale={locale}
        actions={creationMachines.length > 0 ? (
          <NewJobCard actorId={profile.id} machines={creationMachines} contractors={contractors} isContractor={profile.role === "workshop"} locale={locale} />
        ) : undefined}
      />

      <Flash tone="error" message={errorMessage(sp.error ?? error?.message, locale)} />
      <Flash tone="error" message={machineError || linkError || workshopError ? t("jobcards.workflow.loadError", locale) : undefined} />

      <FilterBar path="/jobcards" search={search} filtersLabel={t("filters.filters", locale)} clearLabel={t("filters.clearAll", locale)} rememberKey="jobcards" groups={groups} />

      {cards.length === 0 ? (
        <FilteredEmpty filtered={filters.active} clearHref={filters.clearHref} title={t("empty.noMatchTitle", locale)} hint={t("empty.noMatchHint", locale)} clearLabel={t("empty.clearFilters", locale)}>
          <EmptyState icon={<JobCardsIcon />} title={t("jobcards.empty", locale)} hint={t("jobcards.emptyHint", locale)} />
        </FilteredEmpty>
      ) : sp.status ? (
        <div className="flex flex-col gap-3">
          {rows(cards)}
          {sp.status === "approved" ? pager : null}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {review.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold text-sand-700">{t("jobview.list.review", locale)} <span className="font-normal text-sand-500">{review.length}</span></h2>
              {rows(review)}
            </section>
          ) : null}
          {active.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold text-sand-700">{t("jobview.list.active", locale)} <span className="font-normal text-sand-500">{active.length}</span></h2>
              {rows(active)}
            </section>
          ) : null}
          {done.length > 0 ? (
            <Disclosure summary={t("jobview.list.done", locale)} meta={String(approvedCount)} defaultOpen={page > 1}>
              <ul className="-mx-1 divide-y divide-sand-100">
                {done.map((c) => <JobRow key={c.id} card={c} machine={nameById[c.machine_id] ?? "-"} who={who(c)} locale={locale} />)}
              </ul>
              {pager}
            </Disclosure>
          ) : null}
        </div>
      )}
    </PageContainer>
  );
}

function JobRow({ card, machine, who, locale }: { card: JobCard; machine: string; who: string; locale: Lang }) {
  return (
    <li>
      <Link href={`/jobcards/${card.id}`} className="focus-ring flex items-center gap-3 rounded-xl px-4 py-3 hover:bg-sand-50">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sand-900">{machine}</span>
          <span className="block truncate text-sm text-sand-500">
            {t(`jobType.${card.type}`, locale)} · {who}{card.date_in ? ` · ${shortDate(card.date_in, locale)}` : ""}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <JobStatus value={card.status} locale={locale} />
          {card.total_cents ? <span className="text-sm font-medium tabular-nums text-sand-900">{rands(card.total_cents)}</span> : null}
        </span>
        <ChevronRightIcon aria-hidden className="shrink-0 text-sand-400" />
      </Link>
    </li>
  );
}
