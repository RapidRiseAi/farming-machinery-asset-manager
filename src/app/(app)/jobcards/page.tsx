import Link from "next/link";
import { requireProfile, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { Card } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { EmptyState } from "@/components/ui/empty-state";
import { JobCardsIcon, PlusIcon } from "@/components/ui/icons";
import { createJobCard } from "./actions";
import { JOB_TYPES } from "@/lib/job-options";
import { JobStatus } from "@/components/ui/status";
import { FilterBar } from "@/components/ui/filter-bar";
import { Field } from "@/components/ui/field";
import { buttonVariants } from "@/components/ui/button";


const STATUSES = ["reported", "open", "in_progress", "waiting_parts", "completed", "approved"];

type JobCard = {
  id: string; type: string; status: string; date_in: string | null; total_cents: number; machine_id: string;
};

export default async function JobCardsPage({
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
  const canJob = ["owner", "manager", "mechanic", "workshop"].includes(profile.role);

  const supabase = await createClient();
  let q = supabase
    .from("job_cards")
    .select("id, type, status, date_in, total_cents, machine_id")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (sp.status) q = q.eq("status", sp.status);
  if (sp.machine) q = q.eq("machine_id", sp.machine);
  const { data } = await q;
  const cards = (data as JobCard[] | null) ?? [];

  const { data: ms } = await supabase.from("machines").select("id, name, farm_id").is("deleted_at", null).order("name");
  const machines = (ms as { id: string; name: string; farm_id: string }[] | null) ?? [];
  // `createJobCard` requires farm_id and the old form never posted one.
  const farmIdForCreate = (await currentFarmId(profile)) ?? profile.farm_id ?? machines[0]?.farm_id ?? "";
  const nameById = Object.fromEntries(machines.map((m) => [m.id, m.name]));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("jobcards.title", locale)}</h1>
          <PageInfoButton infoKey="jobcards" locale={locale} />
        </div>
        {/*
          Pick a machine, press New, and a record existed — with `type` hardcoded to
          "repair", so every job was a repair and a mis-tap created a card you then had
          to delete. It also never posted `farm_id`, which `createJobCard` requires, so
          the button failed with "Missing machine". Now: a deliberate form with the type
          chosen, behind a disclosure so it is not the loudest thing on the page.
        */}
        {canJob && machines.length > 0 ? (
          <details className="w-full sm:w-auto">
            <summary className={buttonVariants({ variant: "primary", className: "cursor-pointer list-none" })}>
              <PlusIcon className="text-[1.1rem]" />
              {t("jobcards.startNew", locale)}
            </summary>
            <form
              action={createJobCard}
              className="mt-3 flex flex-col gap-3 rounded-xl border border-sand-200 bg-white p-4 shadow-card sm:w-80"
            >
              <input type="hidden" name="farm_id" value={farmIdForCreate} />
              <Field label={t("jobcards.whichMachineLabel", locale)} htmlFor="new_machine" required>
                <Select id="new_machine" name="machine_id" defaultValue="" required>
                  <option value="" disabled>{t("jobcards.pickMachine", locale)}</option>
                  {machines.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t("jobcards.whatKindLabel", locale)} htmlFor="new_type">
                <Select id="new_type" name="type" defaultValue="repair">
                  {JOB_TYPES.map((jt) => (
                    <option key={jt} value={jt}>{t(`jobType.${jt}`, locale)}</option>
                  ))}
                </Select>
              </Field>
              <SubmitButton variant="primary">{t("jobcards.createIt", locale)}</SubmitButton>
            </form>
          </details>
        ) : null}
      </div>

      {/* Chips apply on tap and write the same `status` / `machine` params the form
          did — the card of dropdowns plus a Search button ate the first screen on a
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
                        <p className="truncate font-semibold text-sand-900">{nameById[c.machine_id] ?? "—"}</p>
                        <p className="text-sm text-sand-500">{t(`jobType.${c.type}`, locale)}{c.date_in ? ` · ${c.date_in}` : ""}</p>
                      </div>
                      <JobStatus value={c.status} locale={locale} />
                    </div>
                    <p className="mt-2 text-right text-sm font-medium text-sand-900">{rands(c.total_cents)}</p>
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
                </Tr>
              </Thead>
              <Tbody>
                {cards.map((c) => (
                  <Tr key={c.id}>
                    <Td className="font-medium">
                      <Link href={`/jobcards/${c.id}`} className="focus-ring rounded text-brand-700 hover:underline">
                        {nameById[c.machine_id] ?? "—"}
                      </Link>
                    </Td>
                    <Td className="text-sand-600">{t(`jobType.${c.type}`, locale)}</Td>
                    <Td className="text-sand-600">{c.date_in ?? "—"}</Td>
                    <Td><JobStatus value={c.status} locale={locale} /></Td>
                    <Td className="text-right font-medium">{rands(c.total_cents)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
