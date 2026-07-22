import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { EmptyState } from "@/components/ui/empty-state";
import { JobCardsIcon, PlusIcon } from "@/components/ui/icons";
import { createJobCard } from "./actions";

const STATUSES = ["reported", "open", "in_progress", "waiting_parts", "completed", "approved"];

type JobCard = {
  id: string; type: string; status: string; date_in: string | null; total_cents: number; machine_id: string;
};

const statusTone = (s: string): BadgeTone =>
  s === "approved" || s === "completed" ? "ok" : s === "waiting_parts" ? "warning" : "info";

export default async function JobCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; machine?: string }>;
}) {
  const profile = await requireProfile();
  const sp = await searchParams;
  const locale = profile.language;
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

  const { data: ms } = await supabase.from("machines").select("id, name").is("deleted_at", null).order("name");
  const machines = (ms as { id: string; name: string }[] | null) ?? [];
  const nameById = Object.fromEntries(machines.map((m) => [m.id, m.name]));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("jobcards.title", locale)}</h1>
        {canJob && machines.length > 0 ? (
          <form action={createJobCard} className="flex items-center gap-2">
            <input type="hidden" name="type" value="repair" />
            <Select name="machine_id" defaultValue="" required aria-label={t("jobcards.pickMachine", locale)}>
              <option value="" disabled>{t("jobcards.pickMachine", locale)}</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
            <SubmitButton variant="primary" size="sm" leftIcon={<PlusIcon className="text-[1.1rem]" />}>
              {t("jobcards.new", locale)}
            </SubmitButton>
          </form>
        ) : null}
      </div>

      <Card>
        <form className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-sand-800">{t("machines.status", locale)}</span>
            <Select name="status" defaultValue={sp.status ?? ""}>
              <option value="">{t("jobcards.allStatuses", locale)}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{t(`jobStatus.${s}`, locale)}</option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-sand-800">{t("jobcards.machine", locale)}</span>
            <Select name="machine" defaultValue={sp.machine ?? ""}>
              <option value="">{t("jobcards.allMachines", locale)}</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </label>
          <Button type="submit" variant="secondary">{t("common.search", locale)}</Button>
        </form>
      </Card>

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
                      <Badge tone={statusTone(c.status)}>{t(`jobStatus.${c.status}`, locale)}</Badge>
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
                    <Td><Badge tone={statusTone(c.status)}>{t(`jobStatus.${c.status}`, locale)}</Badge></Td>
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
