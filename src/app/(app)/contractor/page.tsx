import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, workshopPlan } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { telHref, waHref, mailtoHref } from "@/lib/contact";
import {
  WORK_STATUSES, WORK_KINDS, WORK_PRIORITIES,
  workStatusLabel, workKindLabel, workStatusTone, workPriorityLabel, workPriorityTone,
  isWorkKind, isWorkStatus,
} from "@/lib/work";
import { contractorView, contractorKindLabel } from "@/lib/contractor";
import { workshopPlanAllows } from "@/lib/contractor-plan";
// Direct module imports keep this Server Component free of the kit's client chunk.
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  WorkIcon, MachinesIcon, PartsIcon, InfoIcon, ChevronRightIcon,
  PhoneIcon, ChatIcon, MailIcon,
} from "@/components/ui/icons";

type WorkRequest = {
  id: string; farm_id: string; machine_id: string; kind: string; status: string;
  priority: string; title: string | null; quote_amount_cents: number | null;
  invoice_amount_cents: number | null; updated_at: string; created_at: string;
};
type Machine = { id: string; name: string; type: string };
type Farm = { id: string; name: string };
type FarmUser = { id: string; name: string; farm_id: string; role: string; phone: string | null; email: string | null };

/** urgent → 3 … low → 0 (for descending priority sort). */
const prioRank = (p: string) => Math.max(0, WORK_PRIORITIES.indexOf(p as (typeof WORK_PRIORITIES)[number]));

export default async function ContractorDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; status?: string; farm?: string; sort?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.language;
  // This dashboard belongs to the contractor (workshop) role. Everyone else has their own
  // home — send them there rather than render an empty portal.
  if (profile.role !== "workshop" || !profile.workshop_id) redirect("/machines");

  const sp = await searchParams;
  const supabase = await createClient();

  // The workshop itself (kind drives the tailored view; plan drives premium extras).
  const { data: wsData } = await supabase
    .from("workshops")
    .select("id, name, kind")
    .eq("id", profile.workshop_id)
    .maybeSingle();
  const workshop = (wsData as { id: string; name: string; kind: string } | null) ?? { id: profile.workshop_id, name: "", kind: "other" };
  const view = contractorView(workshop.kind);
  const { plan } = await workshopPlan(profile);
  const analyticsAllowed = plan != null && workshopPlanAllows(plan, "client_analytics");

  // ── The aggregated feed: EVERY request assigned to THIS workshop, across ALL its
  // linked farms, in one place. Since F7 (0341) RLS itself workshop-scopes work_requests
  // for a workshop user — so a contractor never sees another workshop's request even on a
  // shared farm. The explicit workshop_id filter is kept (belt-and-suspenders + intent).
  // Together: a contractor sees only its own work, and never an unlinked farm's data.
  const { data: wrData } = await supabase
    .from("work_requests")
    .select("id, farm_id, machine_id, kind, status, priority, title, quote_amount_cents, invoice_amount_cents, updated_at, created_at")
    .eq("workshop_id", profile.workshop_id)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  const all = (wrData as WorkRequest[] | null) ?? [];

  const farmIds = [...new Set(all.map((r) => r.farm_id))];
  const machineIds = [...new Set(all.map((r) => r.machine_id))];

  const [{ data: msData }, { data: fmData }, { data: usData }] = await Promise.all([
    machineIds.length
      ? supabase.from("machines").select("id, name, type").in("id", machineIds)
      : Promise.resolve({ data: [] }),
    farmIds.length
      ? supabase.from("farms").select("id, name").in("id", farmIds)
      : Promise.resolve({ data: [] }),
    farmIds.length
      ? supabase.from("users").select("id, name, farm_id, role, phone, email").in("farm_id", farmIds).in("role", ["owner", "manager"]).is("deleted_at", null)
      : Promise.resolve({ data: [] }),
  ]);
  const machineById = new Map(((msData as Machine[] | null) ?? []).map((m) => [m.id, m]));
  const farmById = new Map(((fmData as Farm[] | null) ?? []).map((f) => [f.id, f]));
  const farmUsers = (usData as FarmUser[] | null) ?? [];
  // One quick-contact per farm (prefer the owner over a manager).
  const contactByFarm = new Map<string, FarmUser>();
  for (const u of farmUsers) {
    const cur = contactByFarm.get(u.farm_id);
    if (!cur || (u.role === "owner" && cur.role !== "owner")) contactByFarm.set(u.farm_id, u);
  }

  // ── KPIs over the whole assigned set (not the filtered view) ──────
  const openReqs = all.filter((r) => r.status !== "closed");
  const kpiNew = all.filter((r) => r.status === "requested").length;
  const kpiInProgress = all.filter((r) => r.status === "accepted" || r.status === "in_progress").length;
  const kpiToInvoice = all.filter((r) => r.status === "completed").length;

  // ── Filters. Default KIND = the contractor's focus kinds (tailored per `kind`);
  // "all" shows every type; a specific value narrows to it. Status / farm / sort too.
  const kindParam = sp.kind; // undefined = focus default, "all" = no kind filter, else a kind
  const statusParam = sp.status && isWorkStatus(sp.status) ? sp.status : "";
  const farmParam = sp.farm && farmById.has(sp.farm) ? sp.farm : "";
  const sortParam = sp.sort === "updated" ? "updated" : "priority";

  const focusSet = new Set<string>(view.focusKinds);
  let rows = all;
  if (kindParam === undefined) rows = rows.filter((r) => focusSet.has(r.kind));
  else if (kindParam !== "all" && isWorkKind(kindParam)) rows = rows.filter((r) => r.kind === kindParam);
  if (statusParam) rows = rows.filter((r) => r.status === statusParam);
  if (farmParam) rows = rows.filter((r) => r.farm_id === farmParam);

  // Group by status in lifecycle order; sort within a group.
  const byStatus = new Map<string, WorkRequest[]>();
  for (const r of rows) {
    const list = byStatus.get(r.status) ?? [];
    list.push(r);
    byStatus.set(r.status, list);
  }
  for (const list of byStatus.values()) {
    list.sort((a, b) =>
      sortParam === "priority"
        ? prioRank(b.priority) - prioRank(a.priority) || b.updated_at.localeCompare(a.updated_at)
        : b.updated_at.localeCompare(a.updated_at)
    );
  }
  const orderedStatuses = WORK_STATUSES.filter((s) => byStatus.has(s));

  // Href builder that preserves the other active params (for the filter chips).
  const hrefWith = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const cur = { kind: kindParam, status: statusParam || undefined, farm: farmParam || undefined, sort: sortParam === "priority" ? undefined : sortParam };
    const merged = { ...cur, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== "") params.set(k, v);
    const qs = params.toString();
    return qs ? `/contractor?${qs}` : "/contractor";
  };

  const chip = (active: boolean) =>
    `focus-ring rounded-full px-3 py-1.5 text-sm font-medium ${active ? "bg-brand-600 text-white" : "bg-sand-100 text-sand-700 hover:bg-sand-200"}`;

  // Per-farm rollup for the (gated) analytics panel.
  const farmStats = farmIds
    .map((fid) => {
      const reqs = all.filter((r) => r.farm_id === fid);
      const open = reqs.filter((r) => r.status !== "closed").length;
      const invoiced = reqs.reduce((s, r) => s + (r.invoice_amount_cents ?? 0), 0);
      return { fid, name: farmById.get(fid)?.name ?? "—", total: reqs.length, open, invoiced };
    })
    .sort((a, b) => b.open - a.open || b.invoiced - a.invoiced);
  const totalInvoiced = all.reduce((s, r) => s + (r.invoice_amount_cents ?? 0), 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Header — tailored per contractor kind */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("contractor.title", locale)}</h1>
            <Badge tone="brand">{contractorKindLabel(workshop.kind, locale)}</Badge>
          </div>
          <p className="mt-0.5 text-sm text-sand-500">{t(view.taglineKey, locale)}</p>
        </div>
        <Link href="/work" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <WorkIcon className="text-[1.1rem]" /> {t("contractor.allRequests", locale)}
        </Link>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("contractor.kpiNew", locale)} value={kpiNew} tone={kpiNew > 0 ? "brand" : "default"} icon={<WorkIcon />} href={hrefWith({ kind: "all", status: "requested" })} />
        <Stat label={t("contractor.kpiInProgress", locale)} value={kpiInProgress} icon={<MachinesIcon />} href={hrefWith({ kind: "all", status: "in_progress" })} />
        <Stat label={t("contractor.kpiToInvoice", locale)} value={kpiToInvoice} tone={kpiToInvoice > 0 ? "due" : "default"} href={hrefWith({ kind: "all", status: "completed" })} />
        <Stat label={t("contractor.kpiOpen", locale)} value={openReqs.length} />
      </div>

      {all.length === 0 ? (
        <EmptyState
          icon={<WorkIcon />}
          title={t("contractor.empty", locale)}
          hint={t("contractor.emptyHint", locale)}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Main column: filters + grouped requests */}
          <div className="flex flex-col gap-4 lg:col-span-2">
            <Card>
              {/* Kind chips: tailored focus default + all + each type */}
              <div className="flex flex-wrap items-center gap-1.5">
                <Link href={hrefWith({ kind: undefined })} className={chip(kindParam === undefined)}>{t("contractor.focus", locale)}</Link>
                <Link href={hrefWith({ kind: "all" })} className={chip(kindParam === "all")}>{t("contractor.allTypes", locale)}</Link>
                {WORK_KINDS.map((k) => (
                  <Link key={k} href={hrefWith({ kind: k })} className={chip(kindParam === k)}>
                    {workKindLabel(k, locale)}
                  </Link>
                ))}
              </div>
              {/* Status + farm + sort */}
              <form className="mt-3 flex flex-wrap items-end gap-3 border-t border-sand-100 pt-3">
                {kindParam !== undefined ? <input type="hidden" name="kind" value={kindParam} /> : null}
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-sand-800">{t("work.status", locale)}</span>
                  <Select name="status" defaultValue={statusParam}>
                    <option value="">{t("work.allStatuses", locale)}</option>
                    {WORK_STATUSES.map((s) => (<option key={s} value={s}>{workStatusLabel(s, locale)}</option>))}
                  </Select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-sand-800">{t("contractor.client", locale)}</span>
                  <Select name="farm" defaultValue={farmParam}>
                    <option value="">{t("contractor.allClients", locale)}</option>
                    {farmIds.map((fid) => (<option key={fid} value={fid}>{farmById.get(fid)?.name ?? "—"}</option>))}
                  </Select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-sand-800">{t("contractor.sort", locale)}</span>
                  <Select name="sort" defaultValue={sortParam}>
                    <option value="priority">{t("contractor.sortPriority", locale)}</option>
                    <option value="updated">{t("contractor.sortUpdated", locale)}</option>
                  </Select>
                </label>
                <Button type="submit" variant="secondary">{t("common.search", locale)}</Button>
              </form>
            </Card>

            {rows.length === 0 ? (
              <EmptyState title={t("contractor.noneMatch", locale)} hint={t("contractor.noneMatchHint", locale)} />
            ) : (
              orderedStatuses.map((status) => {
                const list = byStatus.get(status)!;
                return (
                  <section key={status} className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <Badge tone={workStatusTone(status)}>{workStatusLabel(status, locale)}</Badge>
                      <span className="text-sm text-sand-400">{list.length}</span>
                    </div>
                    <ul className="flex flex-col gap-2">
                      {list.map((r) => {
                        const m = machineById.get(r.machine_id);
                        const amount = r.invoice_amount_cents ?? r.quote_amount_cents;
                        const amountLabel = r.invoice_amount_cents != null ? t("work.invoice", locale) : r.quote_amount_cents != null ? t("work.quote", locale) : null;
                        return (
                          <li key={r.id}>
                            <Link href={`/work/${r.id}`} className="focus-ring block rounded-xl">
                              <Card className="transition-shadow hover:shadow-soft">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                      <span className="truncate font-semibold text-sand-900">{m?.name ?? "—"}</span>
                                      <Badge tone="neutral">{farmById.get(r.farm_id)?.name ?? "—"}</Badge>
                                    </div>
                                    <p className="mt-0.5 text-sm text-sand-500">
                                      {workKindLabel(r.kind, locale)}{r.title ? ` · ${r.title}` : ""}
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
              })
            )}
          </div>

          {/* Sidebar: clients + parts shortcut + analytics */}
          <div className="flex flex-col gap-4">
            {/* Your clients — the many-farms value prop + quick-contact the farmer */}
            <Card>
              <CardHeader><CardTitle>{t("contractor.clients", locale)}</CardTitle></CardHeader>
              <ul className="flex flex-col divide-y divide-sand-100">
                {farmStats.map((fs) => {
                  const c = contactByFarm.get(fs.fid);
                  const wa = waHref(c?.phone, t("contact.waPrefill", locale));
                  const tel = telHref(c?.phone);
                  const mail = mailtoHref(c?.email);
                  return (
                    <li key={fs.fid} className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
                      <div className="flex items-center justify-between gap-2">
                        <Link href={hrefWith({ farm: fs.fid, kind: "all" })} className="focus-ring min-w-0 truncate rounded font-medium text-sand-900">
                          {fs.name}
                        </Link>
                        <span className="shrink-0 text-xs text-sand-500">{t("contractor.openN", locale).replace("{n}", String(fs.open))}</span>
                      </div>
                      {(tel || wa || mail) ? (
                        <div className="flex flex-wrap gap-1.5">
                          {tel ? <a href={tel} className={buttonVariants({ variant: "ghost", size: "sm" })}><PhoneIcon className="text-[1rem]" /> {t("contact.call", locale)}</a> : null}
                          {wa ? <a href={wa} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}><ChatIcon className="text-[1rem]" /> {t("contact.whatsapp", locale)}</a> : null}
                          {mail ? <a href={mail} className={buttonVariants({ variant: "ghost", size: "sm" })}><MailIcon className="text-[1rem]" /> {t("contact.email", locale)}</a> : null}
                        </div>
                      ) : (
                        <span className="text-xs text-sand-400">{t("contact.none", locale)}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>

            {/* Parts-catalogue shortcut for supply-oriented trades */}
            {view.showParts ? (
              <Card>
                <CardHeader><CardTitle>{t("contractor.parts", locale)}</CardTitle></CardHeader>
                <p className="mb-2 text-sm text-sand-500">{t("contractor.partsHint", locale)}</p>
                <Link href="/parts" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                  <PartsIcon className="text-[1.1rem]" /> {t("nav.parts", locale)}
                </Link>
              </Card>
            ) : null}

            {/* Cross-client analytics — a Pro contractor extra (gated example, F12c seam) */}
            <Card>
              <CardHeader>
                <CardTitle>
                  {t("contractor.analytics", locale)}
                  {!analyticsAllowed ? <Badge tone="brand" className="ml-2 align-middle">{t("contractorPlan.pro", locale)}</Badge> : null}
                </CardTitle>
              </CardHeader>
              {analyticsAllowed ? (
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Stat label={t("contractor.clientsN", locale)} value={farmIds.length} />
                    <Stat label={t("contractor.invoicedTotal", locale)} value={rands(totalInvoiced)} tone="brand" />
                  </div>
                  <ul className="flex flex-col divide-y divide-sand-100 text-sm">
                    {farmStats.map((fs) => (
                      <li key={fs.fid} className="flex items-center justify-between gap-2 py-1.5">
                        <span className="min-w-0 truncate text-sand-700">{fs.name}</span>
                        <span className="shrink-0 tabular-nums text-sand-500">
                          {fs.total} · <span className="font-medium text-sand-800">{rands(fs.invoiced)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-sand-300 bg-sand-50/60 p-4 text-sm">
                  <p className="flex items-center gap-1.5 font-semibold text-sand-900">
                    <InfoIcon className="text-[1.1rem] text-brand-600" /> {t("contractor.analyticsLocked", locale)}
                  </p>
                  <p className="mt-1 text-sand-500">{t("contractor.analyticsLockedHint", locale)}</p>
                  <p className="mt-2 flex items-center gap-1 text-xs text-sand-400">
                    <ChevronRightIcon className="text-[1rem]" /> {t("contractor.contactRr", locale)}
                  </p>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
