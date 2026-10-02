import { requireProfile, currentFarmId, effectiveFarmRole } from "@/lib/auth";
import Link from "next/link";
import { errorMessage } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { relativeDate } from "@/lib/format";
import { resolveFault, acknowledgeFault, startFault, assignFault } from "./actions";
import { NewJobCard } from "@/app/(app)/jobcards/new-job-card";
import { FaultCapture } from "@/components/fault-capture";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { AllClear } from "@/components/ui/empty-state";
import { Flash } from "@/components/ui/flash";
import { FaultsIcon, PlusIcon } from "@/components/ui/icons";
import { ActionMenu } from "@/components/ui/action-menu";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Field } from "@/components/ui/field";
import { UrgencyStatus, FaultStatus, JobStatus } from "@/components/ui/status";
import { buttonVariants } from "@/components/ui/button";
import { menuItemClass } from "@/components/ui/menu-item";
import { Disclosure } from "@/components/ui/disclosure";
import { FilterBar } from "@/components/ui/filter-bar";
import { filterState } from "@/components/ui/filter-state";
import { FilteredEmpty } from "@/components/ui/empty-state";
import { ReportFaultDialog } from "@/components/report-fault-dialog";
import { num } from "@/lib/format";

type Fault = {
  id: string; machine_id: string; farm_id: string; description: string | null;
  category: string | null; urgency: string | null; status: string;
  created_at: string; reporter_name: string | null; job_card_id: string | null;
  assigned_to: string | null; lat: number | null; lng: number | null;
  resolved_at: string | null;
};
type Attach = { id: string; parent_id: string; kind: string; storage_path: string | null };

export default async function FaultsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; page?: string; assigned?: string; machine?: string; report?: string }>;
}) {
  const profile = await requireProfile();
  const sp = await searchParams;
  const locale = profile.lang;
  const supabase = await createClient();

  const farmId = await currentFarmId(profile);
  const page = Math.min(10000, Math.max(1, Math.floor(Number(sp.page) || 1)));
  const columns = "id, machine_id, farm_id, description, category, urgency, status, created_at, reporter_name, job_card_id, assigned_to, lat, lng, resolved_at";
  // "Who has it": mine, or nobody's yet. One single-choice URL param, like /jobcards.
  const assigned = sp.assigned === "mine" || sp.assigned === "nobody" ? sp.assigned : undefined;
  const faultQuery = () => {
    let query = supabase.from("faults").select(columns, { count: "exact" }).is("deleted_at", null);
    if (assigned === "mine") query = query.eq("assigned_to", profile.id);
    if (assigned === "nobody") query = query.is("assigned_to", null);
    return farmId ? query.eq("farm_id", farmId) : query;
  };
  // PostgreSQL enum order is not lifecycle priority. Never let resolved history
  // displace active faults before urgency sorting/pagination.
  const [activeResult, historyResult] = await Promise.all([
    faultQuery().neq("status", "resolved").order("urgency", { ascending: false })
      .order("created_at", { ascending: false }).order("id").range((page - 1) * 50, page * 50 - 1),
    faultQuery().eq("status", "resolved").order("created_at", { ascending: false }).limit(25),
  ]);
  if (activeResult.error || historyResult.error) throw new Error("Could not load faults.");
  const rawFaults = [...(activeResult.data ?? []), ...(historyResult.data ?? [])] as Fault[];

  // Combine the separately paged active list and recent history, keeping resolved
  // rows below active work. Database urgency ordering happens before pagination.
  const URGENCY_RANK: Record<string, number> = { stopped: 0, limping: 1, can_work: 2 };
  const faults = [...rawFaults].sort((a, b) => {
    const ar = a.status === "resolved" ? 1 : 0;
    const br = b.status === "resolved" ? 1 : 0;
    if (ar !== br) return ar - br;
    const au = URGENCY_RANK[a.urgency ?? ""] ?? 3;
    const bu = URGENCY_RANK[b.urgency ?? ""] ?? 3;
    if (au !== bu) return au - bu;
    return b.created_at.localeCompare(a.created_at);
  });

  const machineQuery = supabase.from("machines").select("id, name, farm_id, assigned_operator_id").is("deleted_at", null).order("name");
  const { data: mData } = await (farmId ? machineQuery.eq("farm_id", farmId) : machineQuery);
  const machines = (mData as { id: string; name: string; farm_id: string; assigned_operator_id: string | null }[] | null) ?? [];
  const nameById = Object.fromEntries(machines.map((m) => [m.id, m.name]));

  // Farm users for the assignee name map + the "assign to" select (FR-7.3).
  const { data: uData } = await supabase.from("users").select("id, name").eq("active", true).is("deleted_at", null).order("name");
  const users = (uData as { id: string; name: string }[] | null) ?? [];
  const userName = new Map(users.map((u) => [u.id, u.name]));

  // Attachments for the listed faults, with signed URLs (farm-scoped by storage RLS).
  const faultIds = faults.map((f) => f.id);
  const [requestResult, linkResult, providerResult] = await Promise.all([
    faultIds.length ? supabase.from("work_requests").select("id, created_from_fault_id")
      .in("created_from_fault_id", faultIds).is("deleted_at", null) : Promise.resolve({ data: [], error: null }),
    supabase.from("workshop_links").select("workshop_id, farm_id").eq("status", "active").is("deleted_at", null),
    supabase.from("workshops").select("id, name").is("deleted_at", null),
  ]);
  if (requestResult.error || linkResult.error || providerResult.error) throw new Error("Could not load repair options.");
  const requestByFault = new Map((requestResult.data ?? []).map((r) => [r.created_from_fault_id, r.id]));
  const providerNames = new Map((providerResult.data ?? []).map((p) => [p.id, p.name]));
  const contractors = (linkResult.data ?? []).filter((l) => providerNames.has(l.workshop_id))
    .map((l) => ({ id: l.workshop_id, farm_id: l.farm_id, name: providerNames.get(l.workshop_id)! }));
  const { data: aData } = faultIds.length
    ? await supabase.from("attachments").select("id, parent_id, kind, storage_path").eq("parent_type", "fault").is("deleted_at", null).in("parent_id", faultIds)
    : { data: [] };
  const attachments = (aData as Attach[] | null) ?? [];
  const signed = new Map<string, { kind: string; url: string }[]>();
  await Promise.all(
    attachments.map(async (a) => {
      if (!a.storage_path) return;
      const bucket = a.kind === "voice" ? "fault-voice" : "fault-photos";
      const { data: s } = await supabase.storage.from(bucket).createSignedUrl(a.storage_path, 3600);
      if (s?.signedUrl) {
        const list = signed.get(a.parent_id) ?? [];
        list.push({ kind: a.kind, url: s.signedUrl });
        signed.set(a.parent_id, list);
      }
    })
  );

  const roles = new Map(await Promise.all([...new Set([...machines.map(m => m.farm_id), ...faults.map(f => f.farm_id)])].map(async id =>
    [id, profile.role === "workshop" ? "workshop" : await effectiveFarmRole(id, profile)] as const)));
  const reportMachines = machines.filter(m => {
    const role = roles.get(m.farm_id);
    return role && (["rr_admin", "owner", "manager", "mechanic"].includes(role) || (role === "operator" && m.assigned_operator_id === profile.id));
  });
  const canReport = reportMachines.length > 0;
  const defaultMachineId = reportMachines.some((m) => m.id === sp.machine) ? sp.machine : undefined;
  // Only people who can be given a fault get the "Who has it" filter; a driver is never assigned one.
  const canTriage = [...roles.values()].some((r) => ["rr_admin", "owner", "manager", "mechanic", "workshop"].includes(r ?? ""));

  // A fault already in a job links to its job card, with the card's own status. Read
  // through the visibility view, so a card this person may not open is never linked.
  const jobIds = [...new Set(faults.map((f) => f.job_card_id).filter((v): v is string => !!v))];
  const { data: jcData } = jobIds.length
    ? await supabase.from("job_cards_visible").select("id, status").in("id", jobIds).is("deleted_at", null)
    : { data: [] };
  const jobStatus = new Map(((jcData as { id: string; status: string }[] | null) ?? []).map((j) => [j.id, j.status]));

  const search = new URLSearchParams(
    Object.entries({ assigned }).filter((e): e is [string, string] => !!e[1]),
  ).toString();
  const filterGroups = [
    {
      paramName: "assigned",
      label: t("faults.assignedFilter", locale),
      current: assigned,
      options: [
        { value: "", label: t("filters.all", locale) },
        { value: "mine", label: t("faults.mine", locale) },
        { value: "nobody", label: t("faults.unassigned", locale) },
      ],
    },
  ];
  const filtered = filterState("/faults", search, filterGroups, { pageParam: "page" });
  const pageHref = (n: number) => `/faults?${search ? `${search}&` : ""}page=${n}`;
  const SAVED: Record<string, string> = {
    resolved: "faults.savedResolved",
    acknowledged: "faults.savedAcknowledged",
    started: "faults.savedStarted",
    assigned: "faults.savedAssigned",
  };
  const savedMessage = sp.saved ? t(SAVED[sp.saved] ?? "ui.saved", locale) : undefined;

  const openFaults = faults.filter((f) => f.status !== "resolved");
  const resolvedFaults = faults.filter((f) => f.status === "resolved");
  const openCount = activeResult.count ?? openFaults.length;
  const resolvedCount = historyResult.count ?? resolvedFaults.length;
  const stoppedCount = openFaults.filter((f) => f.urgency === "stopped").length;
  const sortedAt = (f: Fault) => f.resolved_at ?? f.created_at;
  // "Sorted Today" reads wrong mid-sentence; a plain date starts with a digit and is unchanged.
  const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const lastResolved = [...resolvedFaults].sort((a, b) => sortedAt(b).localeCompare(sortedAt(a)))[0] ?? null;

  return (
    <PageContainer size="wide">
      {/*
        Reporting a fault is what an operator opens this screen to do, so it stays the
        one filled action, in a dialog rather than a permanently expanded capture card.
        Below `lg` the tab bar already carries "Report a fault" (`/faults?report=1`,
        which opens this same dialog), so the page does not repeat it as a second
        green button there.
      */}
      <PageHeader
        title={t("faults.titleNew", locale)}
        infoKey="faults"
        locale={locale}
        meta={
          <>
            {stoppedCount > 0 ? (
              <>
                <span className="font-medium text-status-overdue">
                  {stoppedCount === 1
                    ? t("faults.oneStandingStill", locale)
                    : t("faults.standingStill", locale).replace("{n}", num(stoppedCount))}
                </span>
                {" · "}
              </>
            ) : null}
            {t("faults.openCount", locale).replace("{n}", num(openCount))} · {t("faults.sortedCount", locale).replace("{n}", num(resolvedCount))}
          </>
        }
        actions={
          canReport && machines.length > 0 ? (
            <ReportFaultDialog
              machines={reportMachines.map((m) => ({ id: m.id, name: m.name }))}
              defaultMachineId={defaultMachineId}
              redirectTo="/faults?saved=1"
              locale={locale}
              openParam="report"
              triggerIcon={<PlusIcon />}
              triggerClassName="hidden lg:inline-flex"
            />
          ) : null
        }
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={savedMessage} />

      {canTriage ? (
        <FilterBar
          path="/faults"
          search={search}
          groups={filterGroups}
          filtersLabel={t("filters.filters", locale)}
          clearLabel={t("filters.clearAll", locale)}
          rememberKey="faults"
        />
      ) : null}

      {openCount === 0 ? (
        <FilteredEmpty
          filtered={filtered.active}
          clearHref={filtered.clearHref}
          title={t("empty.noMatchTitle", locale)}
          hint={t("empty.noMatchHint", locale)}
          clearLabel={t("empty.clearFilters", locale)}
        >
          <AllClear
            icon={<FaultsIcon />}
            title={t("faults.nothingBrokenTitle", locale)}
            hint={
              lastResolved
                ? `${t("faults.nothingBrokenHint", locale)} ${t("faults.lastSorted", locale).replace("{when}", relativeDate(sortedAt(lastResolved), locale))}`
                : t("faults.nothingBrokenHint", locale)
            }
          />
        </FilteredEmpty>
      ) : null}

      {openFaults.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {openFaults.map((f) => {
            const role = roles.get(f.farm_id) ?? "";
            const canJob = ["rr_admin", "owner", "manager", "mechanic", "workshop"].includes(role);
            const canResolve = ["rr_admin", "owner", "manager", "mechanic"].includes(role);
            const media = signed.get(f.id) ?? [];
            const resolved = f.status === "resolved";
            return (
              <li key={f.id} id={`fault-${f.id}`} className="scroll-mt-24">
                <Card className={resolved ? "opacity-70" : undefined}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-sand-900">{nameById[f.machine_id] ?? "-"}</p>
                      <p className="mt-0.5 text-sm text-sand-700">{f.description}</p>
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-sand-500">
                        <FaultStatus value={f.status} locale={locale} />
                        <span>
                          {f.reporter_name
                            ? t("faults.reportedByWhen", locale)
                                .replace("{name}", f.reporter_name)
                                .replace("{when}", relativeDate(f.created_at, locale))
                            : relativeDate(f.created_at, locale)}
                        </span>
                        {/* Who has it. A fault in a job says where the work is instead of
                            "nobody looking", which contradicted its own "In job" badge. */}
                        {f.job_card_id && jobStatus.has(f.job_card_id) ? (
                          <span className="inline-flex items-center gap-1.5">
                            {t("work.jobCard", locale)}
                            <JobStatus value={jobStatus.get(f.job_card_id)} locale={locale} />
                          </span>
                        ) : f.assigned_to ? (
                          <span>{`${t("faults.assignedTo", locale)} ${userName.get(f.assigned_to) ?? "-"}`}</span>
                        ) : !resolved && !f.job_card_id ? (
                          <span className="font-medium text-status-due">{t("faults.nobodyLooking", locale)}</span>
                        ) : null}
                      </p>
                      {f.lat != null && f.lng != null ? (
                        <a
                          href={`https://www.google.com/maps?q=${f.lat},${f.lng}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="focus-ring mt-1 inline-flex items-center gap-1 rounded text-xs font-medium text-brand-ink"
                        >
                          {t("faults.viewLocation", locale)}
                        </a>
                      ) : null}
                    </div>
                    {f.urgency && !resolved ? <UrgencyStatus value={f.urgency} locale={locale} className="shrink-0" /> : null}
                  </div>

                  {media.length > 0 ? (
                    <div className="mt-3 flex flex-wrap items-start gap-3">
                      {media.filter((m) => m.kind === "photo").map((m, i) => (
                        <a key={i} href={m.url} target="_blank" rel="noopener noreferrer" className="focus-ring rounded-xl">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={m.url}
                            alt={t("faults.viewPhoto", locale)}
                            className={`rounded-xl object-cover ring-1 ring-sand-200 ${
                              f.urgency === "stopped" ? "h-[132px] w-[132px]" : "h-24 w-24"
                            }`}
                          />
                        </a>
                      ))}
                      {media.filter((m) => m.kind === "voice").map((m, i) => (
                        <figure key={i} className="rounded-xl border border-sand-200 bg-sand-50 p-2.5">
                          <figcaption className="mb-1.5 text-xs font-medium text-sand-600">
                            {f.reporter_name
                              ? t("faults.voiceNote", locale).replace("{name}", f.reporter_name)
                              : t("faults.voiceNoteAnon", locale)}
                          </figcaption>
                          <audio controls src={m.url} className="h-10 max-w-[240px]" aria-label={t("faults.playVoiceNote", locale)} />
                        </figure>
                      ))}
                    </div>
                  ) : null}

                  {f.job_card_id ? <Link href={`/jobcards/${f.job_card_id}`} className="focus-ring mt-3 inline-flex min-h-[44px] items-center rounded text-sm font-medium text-brand-ink underline">{t("jobcards.workflow.openJob", locale)}</Link> : null}
                  {!resolved ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {f.job_card_id && jobStatus.has(f.job_card_id) ? (
                        <Link href={`/jobcards/${f.job_card_id}`} className={buttonVariants({ variant: "secondary" })}>
                          {t("work.openJobCard", locale)}
                        </Link>
                      ) : null}
                      {/*
                        One green action per row, kept on the row. Everything else moved
                        behind it: acknowledge, start, assign and resolve were four more
                        `<form>`s on every row, and the assign form carried a `<Select>`
                        listing every active user on the farm, so eight open faults put
                        forty controls and eight copies of the staff list on one screen.
                        The job-card action stays visible; per-row actions use the same
                        secondary styling as the rest of the list.
                      */}
                      {canJob && !f.job_card_id && !requestByFault.has(f.id) ? (
                        <NewJobCard
                          triggerVariant="secondary" triggerSize="sm"
                          actorId={profile.id}
                          machines={[{ id: f.machine_id, farm_id: f.farm_id, name: nameById[f.machine_id] ?? "-", allowExternal: ["owner", "manager", "rr_admin"].includes(roles.get(f.farm_id) ?? "") }]}
                          contractors={contractors} isContractor={profile.role === "workshop"} locale={locale} sourceFault={f}
                        />
                      ) : null}
                      {!f.job_card_id && requestByFault.has(f.id) ? <Link href={`/work/${requestByFault.get(f.id)}`} className="focus-ring rounded text-sm font-medium text-brand-ink underline">{t("jobcards.workflow.openRequest", locale)}</Link> : null}

                      {canJob || canResolve ? (
                        <ActionMenu
                          title={nameById[f.machine_id] ?? "-"}
                          label={t("common.actions", locale)}
                          closeLabel={t("ui.close", locale)}
                        >
                          {f.job_card_id && jobStatus.has(f.job_card_id) ? (
                            <Link href={`/jobcards/${f.job_card_id}`} className={menuItemClass()}>
                              {t("work.openJobCard", locale)}
                            </Link>
                          ) : null}
                          {canJob && f.status === "open" ? (
                            <form action={acknowledgeFault}>
                              <input type="hidden" name="id" value={f.id} />
                              <SubmitButton look="menuItem">{t("faults.acknowledge", locale)}</SubmitButton>
                            </form>
                          ) : null}
                          {canJob && (f.status === "open" || f.status === "acknowledged") ? (
                            <form action={startFault}>
                              <input type="hidden" name="id" value={f.id} />
                              <SubmitButton look="menuItem">{t("faults.startWork", locale)}</SubmitButton>
                            </form>
                          ) : null}
                          {canResolve ? (
                            <form action={resolveFault}>
                              <input type="hidden" name="id" value={f.id} />
                              <SubmitButton look="menuItem">{t("faults.itsSorted", locale)}</SubmitButton>
                            </form>
                          ) : null}

                          {/* The one action with a field of its own, so it gets a dialog
                              rather than a row: a `<Select>` of the whole farm inside a
                              menu row is the clutter this was meant to remove. */}
                          {canResolve && users.length > 0 ? (
                            <DialogForm
                              triggerLook="menuItem"
                              trigger={t("faults.assign", locale)}
                              title={t("faults.assignTo", locale)}
                              description={nameById[f.machine_id] ?? undefined}
                              closeLabel={t("ui.close", locale)}
                              size="md"
                            >
                              <form action={assignFault}>
                                <input type="hidden" name="id" value={f.id} />
                                <DialogFields columns={1}>
                                  <Field label={t("faults.assignTo", locale)} htmlFor={`as-${f.id}`}>
                                    <Select id={`as-${f.id}`} name="assigned_to" defaultValue={f.assigned_to ?? ""}>
                                      <option value="">{t("faults.unassigned", locale)}</option>
                                      {users.map((u) => (
                                        <option key={u.id} value={u.id}>{u.name}</option>
                                      ))}
                                    </Select>
                                  </Field>
                                </DialogFields>
                                <DialogActions cancelLabel={t("common.cancel", locale)}>
                                  <SubmitButton variant="primary">{t("faults.assign", locale)}</SubmitButton>
                                </DialogActions>
                              </form>
                            </DialogForm>
                          ) : null}
                        </ActionMenu>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {page > 1 || openCount > page * 50 ? (
        <nav aria-label={t("faults.pages", locale)} className="flex items-center justify-between gap-3">
          {page > 1 ? <Link className="focus-ring inline-flex min-h-[48px] items-center rounded px-3 underline" href={pageHref(page - 1)}>{t("faults.previousPage", locale)}</Link> : <span />}
          {openCount > page * 50 ? <Link className="focus-ring inline-flex min-h-[48px] items-center rounded px-3 underline" href={pageHref(page + 1)}>{t("faults.nextPage", locale)}</Link> : null}
        </nav>
      ) : null}

      {/* History to read, not work to do: collapsed under the active list. */}
      {resolvedFaults.length > 0 ? (
        <Disclosure summary={t("faults.sortedOut", locale)} meta={num(resolvedCount)}>
          <ul className="flex flex-col divide-y divide-sand-100">
            {resolvedFaults.map((f) => (
              <li key={f.id} id={`fault-${f.id}`} className="scroll-mt-24 py-3 first:pt-0">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <div className="min-w-0">
                    <p className="font-semibold text-sand-900">{nameById[f.machine_id] ?? "-"}</p>
                    {f.description ? <p className="mt-0.5 break-words text-sm text-sand-700">{f.description}</p> : null}
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-sand-500">
                      <FaultStatus value={f.status} locale={locale} />
                      <span>{t("faults.sortedWhen", locale).replace("{when}", lowerFirst(relativeDate(sortedAt(f), locale)))}</span>
                      {f.assigned_to ? <span>{`${t("faults.assignedTo", locale)} ${userName.get(f.assigned_to) ?? "-"}`}</span> : null}
                    </p>
                  </div>
                  {f.job_card_id && jobStatus.has(f.job_card_id) ? (
                    <Link
                      href={`/jobcards/${f.job_card_id}`}
                      className="focus-ring inline-flex min-h-[48px] items-center rounded px-1 text-sm font-medium text-brand-ink underline sm:min-h-[36px]"
                    >
                      {t("work.openJobCard", locale)}
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {resolvedCount > resolvedFaults.length ? (
            <p className="mt-2 text-xs text-sand-500">{t("faults.historyLatest", locale).replace("{n}", num(resolvedFaults.length))}</p>
          ) : null}
        </Disclosure>
      ) : null}
    </PageContainer>
  );
}
