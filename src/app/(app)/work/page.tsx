import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import {
  WORK_STATUSES, workStatusLabel, workKindLabel, workStatusTone, workPriorityLabel, workPriorityTone,
} from "@/lib/work";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PartnersIcon } from "@/components/ui/icons";

type WorkRequest = {
  id: string; machine_id: string; workshop_id: string | null; kind: string; status: string;
  priority: string; title: string | null; quote_amount_cents: number | null;
  invoice_amount_cents: number | null; updated_at: string; created_at: string;
};

export default async function WorkListPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; machine?: string }>;
}) {
  const profile = await requireProfile();
  const sp = await searchParams;
  const locale = profile.language;
  const isContractor = profile.role === "workshop";

  const supabase = await createClient();
  let q = supabase
    .from("work_requests")
    .select("id, machine_id, workshop_id, kind, status, priority, title, quote_amount_cents, invoice_amount_cents, updated_at, created_at")
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  if (sp.status) q = q.eq("status", sp.status);
  if (sp.machine) q = q.eq("machine_id", sp.machine);
  const { data } = await q;
  const rows = (data as WorkRequest[] | null) ?? [];

  const [{ data: ms }, { data: ws }] = await Promise.all([
    supabase.from("machines").select("id, name").is("deleted_at", null).order("name"),
    supabase.from("workshops").select("id, name"),
  ]);
  const machines = (ms as { id: string; name: string }[] | null) ?? [];
  const nameById = Object.fromEntries(machines.map((m) => [m.id, m.name]));
  const wsById = Object.fromEntries(((ws as { id: string; name: string }[] | null) ?? []).map((w) => [w.id, w.name]));

  // Group by status in lifecycle order (only statuses that have rows).
  const byStatus = new Map<string, WorkRequest[]>();
  for (const r of rows) {
    const list = byStatus.get(r.status) ?? [];
    list.push(r);
    byStatus.set(r.status, list);
  }
  const orderedStatuses = WORK_STATUSES.filter((s) => byStatus.has(s));

  const openCount = rows.filter((r) => r.status !== "closed").length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">
          {isContractor ? t("work.contractorTitle", locale) : t("work.title", locale)}
        </h1>
        <p className="mt-0.5 text-sm text-sand-500">
          {isContractor ? t("work.contractorSubtitle", locale) : t("work.subtitle", locale)}
        </p>
      </div>

      <Card>
        <form className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-sand-800">{t("work.status", locale)}</span>
            <Select name="status" defaultValue={sp.status ?? ""}>
              <option value="">{t("work.allStatuses", locale)}</option>
              {WORK_STATUSES.map((s) => (
                <option key={s} value={s}>{workStatusLabel(s, locale)}</option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-sand-800">{t("work.machine", locale)}</span>
            <Select name="machine" defaultValue={sp.machine ?? ""}>
              <option value="">{t("work.allMachines", locale)}</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </label>
          <Button type="submit" variant="secondary">{t("common.search", locale)}</Button>
        </form>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          icon={<PartnersIcon />}
          title={t("work.empty", locale)}
          hint={isContractor ? t("work.emptyHintContractor", locale) : t("work.emptyHint", locale)}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <p className="text-sm text-sand-500">{t("work.openCount", locale).replace("{n}", String(openCount))}</p>
          {orderedStatuses.map((status) => {
            const list = byStatus.get(status)!;
            return (
              <section key={status} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Badge tone={workStatusTone(status)}>{workStatusLabel(status, locale)}</Badge>
                  <span className="text-sm text-sand-400">{list.length}</span>
                </div>
                <ul className="flex flex-col gap-2">
                  {list.map((r) => {
                    const amount = r.invoice_amount_cents ?? r.quote_amount_cents;
                    const amountLabel = r.invoice_amount_cents != null ? t("work.invoice", locale) : r.quote_amount_cents != null ? t("work.quote", locale) : null;
                    return (
                      <li key={r.id}>
                        <Link href={`/work/${r.id}`} className="focus-ring block rounded-xl">
                          <Card className="transition-shadow hover:shadow-soft">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate font-semibold text-sand-900">{nameById[r.machine_id] ?? "—"}</p>
                                <p className="mt-0.5 text-sm text-sand-500">
                                  {workKindLabel(r.kind, locale)}
                                  {r.title ? ` · ${r.title}` : ""}
                                </p>
                                <p className="mt-0.5 text-xs text-sand-400">
                                  {r.workshop_id ? (wsById[r.workshop_id] ?? t("work.unassigned", locale)) : t("work.unassigned", locale)}
                                </p>
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-1">
                                {r.priority !== "normal" ? (
                                  <Badge tone={workPriorityTone(r.priority)}>{workPriorityLabel(r.priority, locale)}</Badge>
                                ) : null}
                                {amount != null ? (
                                  <span className="text-sm font-medium tabular-nums text-sand-900">
                                    {rands(amount)}
                                    {amountLabel ? <span className="ml-1 text-xs font-normal text-sand-400">{amountLabel}</span> : null}
                                  </span>
                                ) : null}
                                <span className="text-xs tabular-nums text-sand-400">{r.updated_at.slice(0, 10)}</span>
                              </div>
                            </div>
                          </Card>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
