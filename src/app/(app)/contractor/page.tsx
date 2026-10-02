import Link from "next/link";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { requireProfile, workshopPlan } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { ledgerSign, isNote } from "@/lib/partner-docs";
import { t } from "@/lib/i18n";
import { telHref, waHref, mailtoHref } from "@/lib/contact";
import {
  WORK_STATUSES, WORK_KINDS, WORK_PRIORITIES,
  workStatusLabel, workKindLabel, workPriorityLabel, workPriorityTone,
  isWorkKind, isWorkStatus,
} from "@/lib/work";
import { contractorView } from "@/lib/contractor";
import { workshopPlanAllows } from "@/lib/contractor-plan";
// Direct module imports keep this Server Component free of the kit's client chunk.
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Flash } from "@/components/ui/flash";
import { errorMessage } from "@/lib/errors";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, NoMatches } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import type { FilterGroup } from "@/components/ui/filter-state";
import { WorkStatus } from "@/components/ui/status";
import { relativeDate, num, todayLocal } from "@/lib/format";
import { cn } from "@/components/ui/cn";
import {
  WorkIcon, PartsIcon, InfoIcon, ChevronRightIcon,
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
type PartnerDoc = {
  id: string; kind: "quote" | "invoice" | "credit_note" | "debit_note"; status: string;
  farm_id: string | null; partner_client_id: string | null; bill_to_name: string | null;
  number: string; total_cents: number; amount_paid_cents: number; due_date: string | null;
};

/** urgent → 3 … low → 0 (for descending priority sort). */
const prioRank = (p: string) => Math.max(0, WORK_PRIORITIES.indexOf(p as (typeof WORK_PRIORITIES)[number]));

const PATH = "/contractor";

/**
 * One labelled figure in the quiet summary line under the tiles. A zero is dimmed so it
 * reads as "nothing here" rather than competing with the figure that needs attention.
 */
function SummaryItem({ label, value, zero, href }: { label: ReactNode; value: ReactNode; zero: boolean; href?: string }) {
  const body = (
    <>
      <span className="text-sand-500">{label}</span>
      <span className={cn("tabular-nums font-semibold", zero ? "text-sand-400" : "text-sand-900")}>{value}</span>
    </>
  );
  return (
    <li>
      {href ? (
        <Link
          href={href}
          className="focus-ring inline-flex min-h-[48px] items-center gap-1.5 rounded-lg hover:text-brand-ink sm:min-h-[36px]"
        >
          {body}
        </Link>
      ) : (
        <span className="inline-flex min-h-[48px] items-center gap-1.5 sm:min-h-[36px]">{body}</span>
      )}
    </li>
  );
}

export default async function ContractorDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  // This dashboard belongs to the contractor (workshop) role. Everyone else has their own
  // home, send them there rather than render an empty portal.
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

  // == The aggregated feed: EVERY request assigned to THIS workshop, across ALL its
  // linked farms, in one place. Since F7 (0341) RLS itself workshop-scopes work_requests
  // for a workshop user, so a contractor never sees another workshop's request even on a
  // shared farm. The explicit workshop_id filter is kept (belt-and-suspenders + intent).
  // Together: a contractor sees only its own work, and never an unlinked farm's data.
  const { data: wrData } = await supabase
    .from("work_requests_visible")
    .select("id, farm_id, machine_id, kind, status, priority, title, quote_amount_cents, invoice_amount_cents, updated_at, created_at")
    .eq("workshop_id", profile.workshop_id)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  const all = (wrData as WorkRequest[] | null) ?? [];

  const farmIds = [...new Set(all.map((r) => r.farm_id))];
  const machineIds = [...new Set(all.map((r) => r.machine_id))];

  const [{ data: msData }, { data: fmData }, { data: usData }, { data: docData }] = await Promise.all([
    machineIds.length
      ? supabase.from("machines").select("id, name, type").in("id", machineIds)
      : Promise.resolve({ data: [] }),
    farmIds.length
      ? supabase.from("farms").select("id, name").in("id", farmIds)
      : Promise.resolve({ data: [] }),
    farmIds.length
      ? supabase.from("users").select("id, name, farm_id, role, phone, email").in("farm_id", farmIds).in("role", ["owner", "manager"]).is("deleted_at", null)
      : Promise.resolve({ data: [] }),
    // Real money, from the documents that carry it. The analytics used to sum
    // `work_requests.invoice_amount_cents`, the field from before documents existed -
    // so a partner billing entirely through FleetWise documents saw R0 in the panel they
    // were paying for.
    supabase
      .from("partner_documents")
      .select("id, kind, status, farm_id, partner_client_id, bill_to_name, number, total_cents, amount_paid_cents, due_date")
      .eq("workshop_id", workshop.id)
      .is("deleted_at", null)
      .not("status", "in", "(draft,void,cancelled,declined,expired)"),
  ]);
  const docs = (docData as PartnerDoc[] | null) ?? [];
  const machineById = new Map(((msData as Machine[] | null) ?? []).map((m) => [m.id, m]));
  const farmById = new Map(((fmData as Farm[] | null) ?? []).map((f) => [f.id, f]));
  const farmUsers = (usData as FarmUser[] | null) ?? [];
  // One quick-contact per farm (prefer the owner over a manager).
  const contactByFarm = new Map<string, FarmUser>();
  for (const u of farmUsers) {
    const cur = contactByFarm.get(u.farm_id);
    if (!cur || (u.role === "owner" && cur.role !== "owner")) contactByFarm.set(u.farm_id, u);
  }

  // == KPIs over the whole assigned set (not the filtered view) ======
  const openReqs = all.filter((r) => r.status !== "closed");
  const kpiNew = all.filter((r) => r.status === "requested").length;
  const kpiInProgress = all.filter((r) => r.status === "accepted" || r.status === "in_progress").length;
  const kpiToInvoice = all.filter((r) => r.status === "completed").length;

  // == Filters. Default KIND = the contractor's focus kinds (tailored per `kind`);
  // "all" shows every type; a specific value narrows to it. Status / farm / sort too.
  // The URL params are the ones the old submit-to-filter form wrote, so every link into
  // this screen (the tiles, the client list) keeps working.
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

  // The query string the FilterBar edits: the four list params only, so a one-off
  // result such as ?error= is not carried into every chip link.
  const listParams = new URLSearchParams();
  for (const k of ["kind", "status", "farm", "sort"]) {
    const v = sp[k];
    if (v) listParams.set(k, v);
  }
  const search = listParams.toString();

  const groups: FilterGroup[] = [
    {
      paramName: "kind",
      label: t("filters.type", locale),
      current: kindParam && (kindParam === "all" || isWorkKind(kindParam)) ? kindParam : "",
      options: [
        { value: "", label: t("contractor.focus", locale) },
        { value: "all", label: t("contractor.allTypes", locale) },
        ...WORK_KINDS.map((k) => ({ value: k, label: workKindLabel(k, locale) })),
      ],
    },
    {
      paramName: "status",
      label: t("work.status", locale),
      current: statusParam,
      options: [
        { value: "", label: t("work.allStatuses", locale) },
        ...WORK_STATUSES.map((s) => ({ value: s, label: workStatusLabel(s, locale) })),
      ],
    },
    // A client filter with one client in it filters nothing.
    ...(farmIds.length > 1
      ? [{
          paramName: "farm",
          label: t("contractor.client", locale),
          current: farmParam,
          options: [
            { value: "", label: t("contractor.allClients", locale) },
            ...farmIds
              .map((fid) => ({ value: fid, label: farmById.get(fid)?.name ?? "-" }))
              .sort((a, b) => a.label.localeCompare(b.label)),
          ],
        }]
      : []),
    {
      paramName: "sort",
      label: t("contractor.sort", locale),
      current: sortParam === "updated" ? "updated" : "",
      options: [
        { value: "", label: t("contractor.sortPriority", locale) },
        { value: "updated", label: t("contractor.sortUpdated", locale) },
      ],
    },
  ];
  const focusLabels = view.focusKinds.map((k) => workKindLabel(k, locale)).join(", ");

  // == The money, from partner_documents =============================
  // An invoice owes what has not been paid; a credit note takes it back off. Anything
  // still owed past its due date is overdue, the number a partner actually needs.
  // Today in South Africa, not on the UTC server: between 00:00 and 02:00 SAST the two
  // are different days, and an invoice due yesterday would not yet read as overdue.
  const today = todayLocal();
  const owedOf = (d: PartnerDoc) =>
    d.kind === "invoice" ? Math.max(0, d.total_cents - (d.amount_paid_cents ?? 0)) : 0;
  // Notes move the balance both ways: a credit takes money off what is owed, a debit adds
  // it on. Summing only credits would have a partner under-chasing an under-billed job.
  const notesTotal = docs
    .filter((d) => d.kind === "credit_note" || d.kind === "debit_note")
    .reduce((s, d) => s + ledgerSign(d.kind) * d.total_cents, 0);
  const outstanding = Math.max(0, docs.reduce((s, d) => s + owedOf(d), 0) + notesTotal);
  const overdue = docs
    .filter((d) => d.kind === "invoice" && d.due_date != null && d.due_date < today)
    .reduce((s, d) => s + owedOf(d), 0);
  const quotedOut = docs.filter((d) => d.kind === "quote" && d.status === "sent")
    .reduce((s, d) => s + d.total_cents, 0);

  // == "Your clients": the farms that send this workshop work, with a quick contact.
  // Keyed by the FARM id. It used to share the analytics rollup's "farm:<id>" keys, so
  // no contact ever matched (every client read "No contact details") and the client
  // link filtered by a value the filter could not recognise.
  const openByFarm = new Map<string, number>();
  for (const r of openReqs) openByFarm.set(r.farm_id, (openByFarm.get(r.farm_id) ?? 0) + 1);
  const clientFarms = farmIds
    .map((fid) => ({ fid, name: farmById.get(fid)?.name ?? "-", open: openByFarm.get(fid) ?? 0 }))
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));

  // Per-customer rollup for the (gated) analytics panel, farms AND client-book
  // customers, because a partner's book is not only the farms that found them.
  const byCustomer = new Map<string, { name: string; owed: number; billed: number; open: number }>();
  for (const d of docs) {
    const key = d.farm_id ? `farm:${d.farm_id}` : d.partner_client_id ? `client:${d.partner_client_id}` : `name:${d.bill_to_name}`;
    const name = (d.farm_id ? farmById.get(d.farm_id)?.name : null) ?? d.bill_to_name ?? "-";
    const cur = byCustomer.get(key) ?? { name, owed: 0, billed: 0, open: 0 };
    cur.owed += owedOf(d) + (isNote(d.kind) ? ledgerSign(d.kind) * d.total_cents : 0);
    if (d.kind === "invoice") cur.billed += d.total_cents;
    byCustomer.set(key, cur);
  }
  for (const r of openReqs) {
    if (!r.farm_id) continue;
    const cur = byCustomer.get(`farm:${r.farm_id}`) ?? { name: farmById.get(r.farm_id)?.name ?? "-", owed: 0, billed: 0, open: 0 };
    cur.open += 1;
    byCustomer.set(`farm:${r.farm_id}`, cur);
  }
  // Each figure is named on screen. This printed `billed` as raw cents ("469488")
  // beside the owed amount, and headed the owed sum "Invoiced total".
  const customerStats = [...byCustomer.entries()]
    .map(([key, v]) => ({ key, name: v.name, billed: v.billed, open: v.open, owed: Math.max(0, v.owed) }))
    .sort((a, b) => b.billed - a.billed || b.owed - a.owed || b.open - a.open);
  const billedTotal = docs.filter((d) => d.kind === "invoice").reduce((s, d) => s + d.total_cents, 0);

  // == The tiles. Seven equal tiles, mostly zero, gave a 0 the same weight as the one
  // number needing action. Now New requests and Owed to you always show (work in,
  // money in); To invoice and Overdue appear only when there is something to do; the
  // rest is one quiet line.
  const tiles: ReactNode[] = [
    <Stat
      key="new"
      label={t("contractor.kpiNew", locale)}
      value={num(kpiNew, 0)}
      tone={kpiNew > 0 ? "brand" : "default"}
      icon={<WorkIcon />}
      href={`${PATH}?kind=all&status=requested`}
    />,
  ];
  if (kpiToInvoice > 0) {
    tiles.push(
      <Stat
        key="invoice"
        label={t("contractor.kpiToInvoice", locale)}
        value={num(kpiToInvoice, 0)}
        tone="due"
        href={`${PATH}?kind=all&status=completed`}
      />,
    );
  }
  tiles.push(
    <Stat
      key="owed"
      label={t("contractor.owed", locale)}
      value={rands(outstanding)}
      tone={outstanding > 0 ? "brand" : "default"}
      size="md"
      href="/statements"
    />,
  );
  if (overdue > 0) {
    tiles.push(
      <Stat key="overdue" label={t("contractor.overdue", locale)} value={rands(overdue)} tone="overdue" size="md" href="/statements" />,
    );
  }
  const tileColumns = tiles.length >= 4 ? 4 : tiles.length === 3 ? 3 : 2;

  return (
    <PageContainer size="wide">
      <PageHeader
        title={t("contractor.title", locale)}
        lead={t(view.taglineKey, locale)}
        infoKey="contractor"
        locale={locale}
        actions={
          <Link href="/work" className={buttonVariants({ variant: "secondary" })}>
            <WorkIcon className="text-lg" /> {t("contractor.allRequests", locale)}
          </Link>
        }
      />

      {/* Other contractor screens send a missing workshop here (?error=no-workshop). */}
      <Flash tone="error" message={errorMessage(sp.error, locale)} />

      <div className="flex flex-col gap-1">
        <StatGrid columns={tileColumns}>{tiles}</StatGrid>
        <ul className="flex flex-wrap items-center gap-x-5 text-sm">
          <SummaryItem
            label={t("contractor.kpiInProgress", locale)}
            value={num(kpiInProgress, 0)}
            zero={kpiInProgress === 0}
            href={kpiInProgress > 0 ? `${PATH}?kind=all&status=in_progress` : undefined}
          />
          {kpiToInvoice === 0 ? (
            <SummaryItem label={t("contractor.kpiToInvoice", locale)} value={num(0, 0)} zero />
          ) : null}
          <SummaryItem label={t("contractor.kpiOpen", locale)} value={num(openReqs.length, 0)} zero={openReqs.length === 0} />
          <SummaryItem
            label={t("contractor.quotedOut", locale)}
            value={rands(quotedOut)}
            zero={quotedOut === 0}
            href="/documents"
          />
        </ul>
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
          <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
            {/* Type, status, client and sort apply on tap. This was three selects and a
                "Search" button with no search box, so every change cost a second tap. */}
            <FilterBar
              path={PATH}
              search={search}
              groups={groups}
              filtersLabel={t("filters.filters", locale)}
              clearLabel={t("filters.clear", locale)}
              extra={
                <>
                  <span>
                    {t("filters.showing", locale)
                      .replace("{n}", num(rows.length, 0))
                      .replace("{total}", num(all.length, 0))}
                  </span>
                  {/* "My work" is the default and so has no pill; say what it is showing,
                      so a request of another type is not mistaken for missing. */}
                  {kindParam === undefined ? (
                    <span>{t("contractor.focusNote", locale).replace("{kinds}", focusLabels)}</span>
                  ) : null}
                </>
              }
            />

            {rows.length === 0 ? (
              <NoMatches
                title={t("contractor.noneMatch", locale)}
                hint={t("contractor.noneMatchHint", locale)}
                clearHref={`${PATH}?kind=all`}
                clearLabel={t("contractor.showEverything", locale)}
              />
            ) : (
              orderedStatuses.map((status) => {
                const list = byStatus.get(status)!;
                return (
                  <section key={status} className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <WorkStatus value={status} locale={locale} />
                      <span className="text-sm tabular-nums text-sand-500">{num(list.length, 0)}</span>
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
                                      <span className="min-w-0 truncate font-semibold text-sand-900">{m?.name ?? "-"}</span>
                                      <Badge tone="neutral">{farmById.get(r.farm_id)?.name ?? "-"}</Badge>
                                    </div>
                                    <p className="mt-0.5 break-words text-sm text-sand-500">
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
                                        {amountLabel ? <span className="ml-1 text-xs font-normal text-sand-500">{amountLabel}</span> : null}
                                      </span>
                                    ) : null}
                                    <span className="text-xs text-sand-500">{relativeDate(r.updated_at, locale)}</span>
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
          <div className="flex min-w-0 flex-col gap-4">
            {/* Your clients, the many-farms value prop + quick-contact the farmer */}
            <Card>
              <CardHeader
                action={
                  <Link href="/contractor/clients" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                    {t("clients.title", locale)}
                  </Link>
                }
              >
                <CardTitle>{t("contractor.clients", locale)}</CardTitle>
              </CardHeader>
              <ul className="flex flex-col divide-y divide-sand-100">
                {clientFarms.map((cf) => {
                  const c = contactByFarm.get(cf.fid);
                  const wa = waHref(c?.phone, t("contact.waPrefill", locale));
                  const tel = telHref(c?.phone);
                  const mail = mailtoHref(c?.email);
                  return (
                    <li key={cf.fid} className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          href={`${PATH}?kind=all&farm=${encodeURIComponent(cf.fid)}`}
                          className="focus-ring inline-flex min-h-[48px] min-w-0 items-center rounded font-medium text-sand-900 hover:text-brand-ink sm:min-h-[36px]"
                        >
                          <span className="truncate">{cf.name}</span>
                        </Link>
                        <span className={cn("shrink-0 text-xs tabular-nums", cf.open > 0 ? "text-sand-600" : "text-sand-400")}>
                          {t("contractor.openN", locale).replace("{n}", num(cf.open, 0))}
                        </span>
                      </div>
                      {(tel || wa || mail) ? (
                        <div className="flex flex-wrap gap-1.5">
                          {tel ? <a href={tel} className={buttonVariants({ variant: "ghost", size: "sm" })}><PhoneIcon className="text-base" /> {t("contact.call", locale)}</a> : null}
                          {wa ? <a href={wa} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}><ChatIcon className="text-base" /> {t("contact.whatsapp", locale)}</a> : null}
                          {mail ? <a href={mail} className={buttonVariants({ variant: "ghost", size: "sm" })}><MailIcon className="text-base" /> {t("contact.email", locale)}</a> : null}
                        </div>
                      ) : (
                        <span className="text-xs text-sand-500">{t("contact.none", locale)}</span>
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
                  <PartsIcon className="text-lg" /> {t("nav.parts", locale)}
                </Link>
              </Card>
            ) : null}

            {/* Cross-client analytics, part of the Managed product (F14e gating seam) */}
            <Card>
              <CardHeader>
                <CardTitle>
                  {t("contractor.analytics", locale)}
                  {!analyticsAllowed ? <Badge tone="brand" className="ml-2 align-middle">{t("contractorPlan.managed", locale)}</Badge> : null}
                </CardTitle>
              </CardHeader>
              {analyticsAllowed ? (
                <div className="flex flex-col gap-3">
                  {/* A two-column tile is about 136px wide inside on a 360px phone, and
                      `rands` is one unbreakable token (U+00A0 thousands); `md` steps it
                      down so a good year still fits. */}
                  <StatGrid columns={2}>
                    <Stat label={t("contractor.clientsN", locale)} value={num(customerStats.length, 0)} size="md" />
                    <Stat label={t("contractor.invoicedTotal", locale)} value={rands(billedTotal)} tone="brand" size="md" />
                  </StatGrid>
                  <ul className="flex flex-col divide-y divide-sand-100 text-sm">
                    {customerStats.map((cs) => (
                      <li key={cs.key} className="flex min-w-0 flex-col gap-0.5 py-2">
                        <span className="min-w-0 truncate font-medium text-sand-800">{cs.name}</span>
                        <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                          <div className="flex gap-1">
                            <dt className="text-sand-500">{t("contractor.analyticsBilled", locale)}</dt>
                            <dd className={cn("tabular-nums font-medium", cs.billed > 0 ? "text-sand-800" : "text-sand-400")}>{rands(cs.billed)}</dd>
                          </div>
                          <div className="flex gap-1">
                            <dt className="text-sand-500">{t("contractor.analyticsOwed", locale)}</dt>
                            <dd className={cn("tabular-nums font-medium", cs.owed > 0 ? "text-sand-800" : "text-sand-400")}>{rands(cs.owed)}</dd>
                          </div>
                          {cs.open > 0 ? (
                            <div className="flex gap-1">
                              <dt className="sr-only">{t("contractor.kpiOpen", locale)}</dt>
                              <dd className="tabular-nums text-sand-600">{t("contractor.openN", locale).replace("{n}", num(cs.open, 0))}</dd>
                            </div>
                          ) : null}
                        </dl>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-sand-300 bg-sand-50/60 p-4 text-sm">
                  <p className="flex items-center gap-1.5 font-semibold text-sand-900">
                    <InfoIcon className="text-lg text-brand-ink" /> {t("contractor.analyticsLocked", locale)}
                  </p>
                  <p className="mt-1 text-sand-500">{t("contractor.analyticsLockedHint", locale)}</p>
                  <p className="mt-2 flex items-center gap-1 text-xs text-sand-500">
                    <ChevronRightIcon className="text-base" /> {t("contractor.contactRr", locale)}
                  </p>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
