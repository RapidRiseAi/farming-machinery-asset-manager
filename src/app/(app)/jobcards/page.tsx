import Link from "next/link";
import { requireProfile, effectiveFarmRole, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { Card } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { JobCardsIcon } from "@/components/ui/icons";
import { JobStatus } from "@/components/ui/status";
import { FilterBar } from "@/components/ui/filter-bar";
import { NewJobCard, type JobMachine, type JobContractor } from "./new-job-card";
import { JobCardRow } from "./job-card-row";
import { Flash } from "@/components/ui/flash";
import { errorMessage } from "@/lib/errors";


const STATUSES = ["reported", "open", "in_progress", "waiting_parts", "completed", "approved"];

type JobCard = {
  id: string; type: string; status: string; date_in: string | null; total_cents: number | null; machine_id: string;
  work_mode: string; workshop_id: string | null;
};

export default async function JobCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; machine?: string; error?: string }>;
}) {
  const profile = await requireProfile();
  const sp = await searchParams;
  // Current query string, so a chip preserves whatever else is filtered.
  const search = new URLSearchParams(
    Object.entries(sp).filter(([, v]) => !!v) as [string, string][],
  ).toString();
  const locale = profile.lang;

  const supabase = await createClient();
  const farmId = await currentFarmId(profile);
  let q = supabase
    .from("job_cards_visible")
    .select("id, type, status, date_in, total_cents, machine_id, work_mode, workshop_id")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (sp.status) q = q.eq("status", sp.status);
  if (farmId) q = q.eq("farm_id", farmId);
  if (sp.machine) q = q.eq("machine_id", sp.machine);
  const { data, error } = await q;
  const cards = (data as JobCard[] | null) ?? [];

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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-bold tracking-tight text-ink">{t("jobcards.title", locale)}</h1>
          <PageInfoButton infoKey="jobcards" locale={locale} />
        </div>
        {creationMachines.length > 0 ? (
          <NewJobCard actorId={profile.id} machines={creationMachines} contractors={contractors} isContractor={profile.role === "workshop"} locale={locale} />
        ) : null}
      </div>

      <Flash tone="error" message={errorMessage(sp.error ?? error?.message, locale)} />
      <Flash tone="error" message={machineError || linkError || workshopError ? t("jobcards.workflow.loadError", locale) : undefined} />

      {/* Chips apply on tap and write the same `status` / `machine` params the form
          did, the card of dropdowns plus a Search button ate the first screen on a
          phone and did nothing at all until submitted. */}
      <FilterBar
        path="/jobcards"
        search={search}
        filtersLabel={t("filters.filters", locale)}
        clearLabel={t("filters.clearAll", locale)}
        groups={[
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
        ]}
      />

      {cards.length === 0 ? (
        <EmptyState icon={<JobCardsIcon />} title={t("jobcards.empty", locale)} hint={t("jobcards.emptyHint", locale)} />
      ) : (
        <>
          {/* Mobile cards */}
          <ul className="flex flex-col gap-2 lg:hidden">
            {cards.map((c) => (
              <li key={c.id}>
                <Link href={`/jobcards/${c.id}`} className="focus-ring block rounded-xl">
                  <Card className="transition-shadow hover:shadow-soft">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-sand-900">{nameById[c.machine_id] ?? "-"}</p>
                        <p className="mt-1 text-xs font-medium text-brand-ink">{t("jobcards.workflow.openJob", locale)} #{c.id.slice(0, 8)}</p>
                        <p className="text-sm text-sand-500">{t(`jobType.${c.type}`, locale)}{c.date_in ? ` · ${c.date_in}` : ""}</p>
                      </div>
                      <JobStatus value={c.status} locale={locale} />
                    </div>
                    {c.total_cents != null ? <p className="mt-2 text-right text-sm font-medium text-sand-900">{rands(c.total_cents)}</p> : null}
                  </Card>
                </Link>
              </li>
            ))}
          </ul>

          {/* Desktop table */}
          <Card flush className="hidden lg:block">
            <Table>
              <Thead>
                <Tr>
                  <Th>{t("jobcards.machine", locale)}</Th>
                  <Th>{t("machines.type", locale)}</Th>
                  <Th>{t("jobcards.dateIn", locale)}</Th>
                  <Th>{t("machines.status", locale)}</Th>
                  <Th className="text-right">{t("jobcards.total", locale)}</Th>
                  <Th><span className="sr-only">{t("jobcards.workflow.openJob", locale)}</span></Th>
                </Tr>
              </Thead>
              <Tbody>
                {cards.map((c) => (
                  <JobCardRow key={c.id} href={`/jobcards/${c.id}`}>
                    <Td className="font-medium">
                      <span className="block">{nameById[c.machine_id] ?? "-"}</span>
                      <Badge tone="neutral" className="mt-1">{t(c.work_mode === "external" || c.workshop_id ? "jobcards.workflow.external" : "jobcards.workflow.internal", locale)}</Badge>
                    </Td>
                    <Td className="text-sand-600">{t(`jobType.${c.type}`, locale)}</Td>
                    <Td className="text-sand-600">{c.date_in ?? "-"}</Td>
                    <Td><JobStatus value={c.status} locale={locale} /></Td>
                    <Td className="text-right font-medium">{c.total_cents != null ? rands(c.total_cents) : "-"}</Td>
                    <Td><Link href={`/jobcards/${c.id}`} className="focus-ring inline-flex min-h-[44px] items-center rounded text-sm font-medium text-brand-ink hover:underline" aria-label={`${t("jobcards.workflow.openJob", locale)}: ${nameById[c.machine_id] ?? ""} #${c.id.slice(0, 8)}`}>{t("jobcards.workflow.openJob", locale)} <span aria-hidden className="ml-1">→</span></Link></Td>
                  </JobCardRow>
                ))}
              </Tbody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
