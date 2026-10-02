import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { relativeDate } from "@/lib/format";
import { t, type Lang } from "@/lib/i18n";
import { WORK_STATUSES, workStatusLabel, workKindLabel, workPriorityLabel, workPriorityTone } from "@/lib/work";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState, FilteredEmpty } from "@/components/ui/empty-state";
import { PartnersIcon, ChevronRightIcon } from "@/components/ui/icons";
import { WorkStatus } from "@/components/ui/status";
import { FilterBar } from "@/components/ui/filter-bar";
import { filterState } from "@/components/ui/filter-state";
import { Disclosure } from "@/components/ui/disclosure";

type WorkRequest = {
  id: string; farm_id: string; machine_id: string; workshop_id: string | null; kind: string; status: string;
  priority: string; title: string | null; quote_amount_cents: number | null;
  invoice_amount_cents: number | null; updated_at: string; created_at: string;
};

/**
 * Work sent to contractors, or, for a contractor, work from the farms they serve.
 *
 * It grouped rows under a status badge for every one of eight statuses, printed the date
 * as an ISO string, and showed a contractor their own business name on every card. Now
 * open work is one list, newest first, closed work folds away, and each row names the
 * other party: the farm for a contractor, the contractor for a farm.
 */
export default async function WorkListPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; machine?: string }>;
}) {
  const profile = await requireProfile();
  const sp = await searchParams;
  // Current query string, so a chip preserves whatever else is filtered.
  const search = new URLSearchParams(
    Object.entries(sp).filter(([, v]) => !!v) as [string, string][],
  ).toString();
  const locale = profile.lang;
  const isContractor = profile.role === "workshop";

  const supabase = await createClient();
  let q = supabase
    .from("work_requests_visible")
    .select("id, farm_id, machine_id, workshop_id, kind, status, priority, title, quote_amount_cents, invoice_amount_cents, updated_at, created_at")
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  if (sp.status) q = q.eq("status", sp.status);
  if (sp.machine) q = q.eq("machine_id", sp.machine);
  const { data } = await q;
  const rows = (data as WorkRequest[] | null) ?? [];

  const [{ data: ms }, { data: ws }, { data: fs }] = await Promise.all([
    supabase.from("machines").select("id, name").is("deleted_at", null).order("name"),
    supabase.from("workshops").select("id, name"),
    isContractor ? supabase.from("farms").select("id, name") : Promise.resolve({ data: [] }),
  ]);
  const machines = (ms as { id: string; name: string }[] | null) ?? [];
  const nameById = Object.fromEntries(machines.map((m) => [m.id, m.name]));
  const wsById = Object.fromEntries(((ws as { id: string; name: string }[] | null) ?? []).map((w) => [w.id, w.name]));
  const farmById = Object.fromEntries(((fs as { id: string; name: string }[] | null) ?? []).map((f) => [f.id, f.name]));

  const groups = [
    {
      paramName: "status",
      label: t("work.status", locale),
      current: sp.status,
      options: [
        { value: "", label: t("work.allStatuses", locale) },
        ...WORK_STATUSES.map((s) => ({ value: s, label: workStatusLabel(s, locale) })),
      ],
    },
    {
      paramName: "machine",
      label: t("work.machine", locale),
      current: sp.machine,
      options: [
        { value: "", label: t("work.allMachines", locale) },
        ...machines.map((m) => ({ value: m.id, label: m.name })),
      ],
    },
  ];
  const filters = filterState("/work", search, groups);
  const counterpart = (r: WorkRequest) => isContractor
    ? farmById[r.farm_id] ?? null
    : r.workshop_id ? wsById[r.workshop_id] ?? t("work.unassigned", locale) : t("work.unassigned", locale);

  const open = rows.filter((r) => r.status !== "closed");
  const closed = rows.filter((r) => r.status === "closed");
  const list = (items: WorkRequest[]) => (
    <ul className="divide-y divide-sand-100">
      {items.map((r) => <WorkRow key={r.id} r={r} machine={nameById[r.machine_id] ?? "-"} counterpart={counterpart(r)} locale={locale} />)}
    </ul>
  );

  return (
    <PageContainer>
      <PageHeader
        title={t(isContractor ? "work.contractorTitle" : "work.title", locale)}
        lead={t(isContractor ? "work.contractorSubtitle" : "work.subtitle", locale)}
        infoKey="work" locale={locale}
      />

      <FilterBar path="/work" search={search} filtersLabel={t("filters.filters", locale)} clearLabel={t("filters.clearAll", locale)} rememberKey="work" groups={groups} />

      {rows.length === 0 ? (
        <FilteredEmpty filtered={filters.active} clearHref={filters.clearHref} title={t("empty.noMatchTitle", locale)} hint={t("empty.noMatchHint", locale)} clearLabel={t("empty.clearFilters", locale)}>
          <EmptyState icon={<PartnersIcon />} title={t("work.empty", locale)} hint={isContractor ? t("work.emptyHintContractor", locale) : t("work.emptyHint", locale)} />
        </FilteredEmpty>
      ) : sp.status ? (
        <Card flush>{list(rows)}</Card>
      ) : (
        <div className="flex flex-col gap-6">
          {open.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold text-sand-700">{t("workview.groups.active", locale)} <span className="font-normal text-sand-500">{open.length}</span></h2>
              <Card flush>{list(open)}</Card>
            </section>
          ) : null}
          {closed.length > 0 ? (
            <Disclosure summary={t("workview.groups.closed", locale)} meta={String(closed.length)}>
              <div className="-mx-1">{list(closed)}</div>
            </Disclosure>
          ) : null}
        </div>
      )}
    </PageContainer>
  );
}

function WorkRow({ r, machine, counterpart, locale }: { r: WorkRequest; machine: string; counterpart: string | null; locale: Lang }) {
  const amount = r.invoice_amount_cents ?? r.quote_amount_cents;
  const amountLabel = r.invoice_amount_cents != null ? t("work.invoice", locale) : r.quote_amount_cents != null ? t("work.quote", locale) : null;
  return (
    <li>
      <Link href={`/work/${r.id}`} className="focus-ring flex items-center gap-3 rounded-xl px-4 py-3 hover:bg-sand-50">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sand-900">{machine}</span>
          <span className="block truncate text-sm text-sand-500">{workKindLabel(r.kind, locale)}{r.title ? ` · ${r.title}` : ""}</span>
          <span className="block truncate text-xs text-sand-500">
            {counterpart ? `${counterpart} · ` : ""}{t("workview.updated", locale).replace("{date}", relativeDate(r.updated_at, locale))}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <WorkStatus value={r.status} locale={locale} />
          {r.priority !== "normal" ? <Badge tone={workPriorityTone(r.priority)}>{workPriorityLabel(r.priority, locale)}</Badge> : null}
          {amount != null ? (
            <span className="text-sm font-medium tabular-nums text-sand-900">{rands(amount)}{amountLabel ? <span className="ml-1 text-xs font-normal text-sand-500">{amountLabel}</span> : null}</span>
          ) : null}
        </span>
        <ChevronRightIcon aria-hidden className="shrink-0 text-sand-400" />
      </Link>
    </li>
  );
}
