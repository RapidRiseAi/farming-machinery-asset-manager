import Link from "next/link";
import { requireProfile, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { summariseCosts, costPerMeter } from "@/lib/cost";
import { meterReading, relativeDate, num } from "@/lib/format";
import {
  MACHINE_TYPES,
  MACHINE_STATUSES,
  typeLabel,
  statusLabel,
} from "@/lib/machine-options";
import { Card } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { MachineStatus, ServiceStatus } from "@/components/ui/status";
import { Input } from "@/components/ui/input";
import { Button, buttonVariants } from "@/components/ui/button";
import { GetStarted, NoMatches } from "@/components/ui/empty-state";
import { FilterChips, type ChipOption } from "@/components/ui/filter-chips";
import { Flash } from "@/components/ui/flash";
import { MachinesIcon, PlusIcon, SearchIcon, ChevronUpIcon, ChevronDownIcon, ChevronRightIcon } from "@/components/ui/icons";

type MachineRow = {
  id: string;
  name: string;
  type: string;
  make: string | null;
  model: string | null;
  year: number | null;
  reg_no: string | null;
  status: string;
  meter_type: string;
  current_reading: number | null;
  current_reading_date: string | null;
  cost_centre: string | null;
  primary_attachment_id: string | null;
};

type SP = { type?: string; status?: string; q?: string; sort?: string; dir?: string; retired?: string; imported?: string; cc?: string; dept?: string };

const worst = (a: string, b: string) => {
  const rank: Record<string, number> = { overdue: 3, due_soon: 2, ok: 1 };
  return (rank[b] ?? 0) > (rank[a] ?? 0) ? b : a;
};

export default async function MachinesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const profile = await requireProfile();
  const sp = await searchParams;
  const locale = profile.language;
  const canEdit = profile.role === "owner" || profile.role === "manager";

  const sort = sp.sort === "reading" ? "current_reading" : "name";
  const dir = sp.dir === "desc" ? "desc" : "asc";
  const showRetired = sp.retired === "1";

  const supabase = await createClient();
  // Multi-site (F7): scope the list to the farm the user is currently acting in. For a
  // single-farm user this is simply their farm (RLS already scopes it); a multi-site user
  // sees the farm chosen in the site switcher. null → rr_admin/workshop (RLS-only scope).
  const farmId = await currentFarmId(profile);
  let query = supabase
    .from("machines")
    .select("id, name, type, make, model, year, reg_no, status, meter_type, current_reading, current_reading_date, cost_centre, primary_attachment_id")
    .is("deleted_at", null)
    .order(sort, { ascending: dir === "asc" });
  if (farmId) query = query.eq("farm_id", farmId);
  if (sp.type) query = query.eq("type", sp.type);
  if (sp.status) query = query.eq("status", sp.status);
  else if (!showRetired) query = query.not("status", "in", "(retired,sold)");
  if (sp.cc) query = query.eq("cost_centre", sp.cc);
  if (sp.dept) query = query.eq("department", sp.dept);
  if (sp.q) query = query.or(`name.ilike.%${sp.q}%,make.ilike.%${sp.q}%,model.ilike.%${sp.q}%,serial_no.ilike.%${sp.q}%`);
  const { data } = await query;
  const machines = (data as MachineRow[] | null) ?? [];

  // Distinct cost-centre / department values (farm-scoped by RLS) for the FR-3.4 filters,
  // plus the unfiltered fleet totals the header needs ("12 on the farm").
  let dimQuery = supabase
    .from("machines")
    .select("id, cost_centre, department, status")
    .is("deleted_at", null);
  if (farmId) dimQuery = dimQuery.eq("farm_id", farmId);
  const { data: dimData } = await dimQuery;
  const allRows = (dimData as { id: string; cost_centre: string | null; department: string | null; status: string }[] | null) ?? [];
  const costCentres = [...new Set(allRows.map((r) => r.cost_centre).filter((v): v is string => !!v))].sort();
  const departments = [...new Set(allRows.map((r) => r.department).filter((v): v is string => !!v))].sort();
  const liveRows = allRows.filter((r) => r.status !== "retired" && r.status !== "sold");
  const fleetTotal = liveRows.length;
  const fleetInWorkshop = liveRows.filter((r) => r.status === "in_workshop").length;

  // Primary vehicle image (0280): batch-sign the referenced photos → machine-id → URL.
  const primaryIds = machines.map((m) => m.primary_attachment_id).filter((v): v is string => !!v);
  const photoUrlByMachine = new Map<string, string>();
  if (primaryIds.length > 0) {
    const { data: atts } = await supabase
      .from("attachments")
      .select("id, storage_path")
      .in("id", primaryIds)
      .is("deleted_at", null);
    const pathById = new Map<string, string>();
    for (const a of (atts as { id: string; storage_path: string | null }[] | null) ?? []) {
      if (a.storage_path) pathById.set(a.id, a.storage_path);
    }
    const paths = [...new Set(pathById.values())];
    if (paths.length > 0) {
      const { data: signed } = await supabase.storage.from("machine-photos").createSignedUrls(paths, 3600);
      const urlByPath = new Map<string, string>();
      for (const s of signed ?? []) {
        if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
      }
      for (const m of machines) {
        const p = m.primary_attachment_id ? pathById.get(m.primary_attachment_id) : undefined;
        const u = p ? urlByPath.get(p) : undefined;
        if (u) photoUrlByMachine.set(m.id, u);
      }
    }
  }

  // Worst service status per machine, and which machines have no plan at all — the
  // second is a real to-do that used to render as an invisible sand-300 dash.
  const { data: splData } = await supabase
    .from("service_plan_lines")
    .select("machine_id, status")
    .is("deleted_at", null);
  const svcByMachine = new Map<string, string>();
  for (const l of (splData as { machine_id: string; status: string }[] | null) ?? []) {
    svcByMachine.set(l.machine_id, worst(svcByMachine.get(l.machine_id) ?? "ok", l.status));
  }
  const fleetNeedService = liveRows.filter((r) => {
    const s = svcByMachine.get(r.id);
    return s === "overdue" || s === "due_soon";
  }).length;

  // Cost per hour / km, from the same ledger that feeds the reports (F1 `cost.ts`), so
  // the list and the machine page never disagree.
  let costQ = supabase.from("cost_entries").select("machine_id, type, amount_cents").is("deleted_at", null);
  if (farmId) costQ = costQ.eq("farm_id", farmId);
  const { data: costData } = await costQ;
  const costByMachine = new Map<string, { type: string; amount_cents: number | null }[]>();
  for (const c of (costData as { machine_id: string | null; type: string; amount_cents: number | null }[] | null) ?? []) {
    if (!c.machine_id) continue;
    const list = costByMachine.get(c.machine_id) ?? [];
    list.push(c);
    costByMachine.set(c.machine_id, list);
  }
  const costPerUnit = (m: MachineRow): number | null => {
    if (m.meter_type === "none") return null;
    const rows = costByMachine.get(m.id);
    if (!rows || rows.length === 0) return null;
    return costPerMeter(summariseCosts(rows).total, m.current_reading);
  };

  const staleCut = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const isStale = (m: MachineRow) =>
    m.meter_type !== "none" && (!m.current_reading_date || m.current_reading_date < staleCut);

  // The current query string, so chips and sort links preserve everything else.
  const currentParams = new URLSearchParams();
  if (sp.type) currentParams.set("type", sp.type);
  if (sp.status) currentParams.set("status", sp.status);
  if (sp.q) currentParams.set("q", sp.q);
  if (sp.cc) currentParams.set("cc", sp.cc);
  if (sp.dept) currentParams.set("dept", sp.dept);
  if (showRetired) currentParams.set("retired", "1");
  if (sp.sort) currentParams.set("sort", sp.sort);
  if (sp.dir) currentParams.set("dir", sp.dir);
  const search = currentParams.toString();

  const sortHref = (col: "name" | "reading") => {
    const params = new URLSearchParams(search);
    params.set("sort", col);
    params.set("dir", sort === (col === "reading" ? "current_reading" : "name") && dir === "asc" ? "desc" : "asc");
    return `/machines?${params.toString()}`;
  };
  const sortIndicator = (col: "name" | "reading") => {
    const active = sort === (col === "reading" ? "current_reading" : "name");
    if (!active) return null;
    return dir === "asc" ? <ChevronUpIcon className="text-[0.9rem]" /> : <ChevronDownIcon className="text-[0.9rem]" />;
  };

  const typeOptions: ChipOption[] = [
    { value: "", label: t("machines.presetAll", locale) },
    ...MACHINE_TYPES.map((ty) => ({ value: ty, label: typeLabel(ty, locale) })),
  ];
  const statusOptions: ChipOption[] = [
    { value: "", label: t("filters.all", locale) },
    ...MACHINE_STATUSES.filter((s) => showRetired || (s !== "retired" && s !== "sold")).map((s) => ({
      value: s,
      label: statusLabel(s, locale),
    })),
  ];

  const hasFilter = !!(sp.type || sp.status || sp.q || sp.cc || sp.dept);

  /**
   * The service cell — a status, or a "set up a plan" prompt when there is no plan.
   *
   * `linked` is false inside the mobile card, whose whole surface is already a link to
   * the same machine. An `<a>` inside an `<a>` is invalid HTML: the browser lifts the
   * inner one out of the card, the DOM stops matching what the server sent, and React
   * throws the list away and re-renders it on the client.
   */
  const serviceCell = (m: MachineRow, linked = true) => {
    const s = svcByMachine.get(m.id);
    if (!s) {
      const look =
        "inline-flex items-center gap-1 rounded-full border border-dashed border-sand-300 px-2.5 py-1 text-xs font-medium text-brand-700";
      return linked ? (
        <Link
          href={`/machines/${m.id}`}
          className={`focus-ring ${look} hover:border-brand-300 hover:bg-brand-50`}
        >
          <PlusIcon className="text-[0.9rem]" />
          {t("machines.setUpPlan", locale)}
        </Link>
      ) : (
        <span className={look}>
          <PlusIcon className="text-[0.9rem]" />
          {t("machines.setUpPlan", locale)}
        </span>
      );
    }
    return <ServiceStatus value={s} locale={locale} />;
  };

  /** Meter reading + when it was last read — a stale reading is what breaks service dates. */
  const readingCell = (m: MachineRow) => {
    if (m.meter_type === "none") {
      return <span className="text-sand-400">{t("machines.noMeter", locale)}</span>;
    }
    return (
      <span className="block">
        <span className="font-medium tabular-nums text-sand-900">
          {m.current_reading != null
            ? meterReading(m.current_reading, m.meter_type, locale)
            : t("machines.noReading", locale)}
        </span>
        <span className={`mt-0.5 block text-xs ${isStale(m) ? "font-medium text-status-due" : "text-sand-500"}`}>
          {m.current_reading_date
            ? t("machines.readWhen", locale).replace("{when}", relativeDate(m.current_reading_date, locale))
            : t("machines.neverRead", locale)}
        </span>
      </span>
    );
  };

  const photo = (id: string, size: "sm" | "lg") => {
    const url = photoUrlByMachine.get(id);
    const cls = size === "sm" ? "h-12 w-12 rounded-lg" : "h-[132px] w-[132px] rounded-xl";
    return (
      <div className={`${cls} shrink-0 overflow-hidden bg-sand-100 ring-1 ring-sand-200`}>
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-sand-300">
            <MachinesIcon className={size === "sm" ? "text-[1.1rem]" : "text-[2.2rem]"} />
          </span>
        )}
      </div>
    );
  };

  const subtitle = (m: MachineRow) =>
    [typeLabel(m.type, locale), m.make ? `${m.make}${m.model ? " " + m.model : ""}` : null, m.reg_no ?? (m.year ? String(m.year) : null), m.cost_centre]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="flex flex-col gap-4">
      {/* Header — says how big the fleet is and what is wrong with it, which the page
          never did before. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[1.6rem] font-bold leading-tight tracking-tight text-sand-950">
            {t("machines.title", locale)}
          </h1>
          <p className="mt-1 text-sm text-sand-500">
            {t("machines.headerCount", locale).replace("{n}", num(fleetTotal, 0))}
            {fleetNeedService > 0 ? (
              <>
                {" · "}
                <span className="font-medium text-status-due">
                  {fleetNeedService === 1
                    ? t("machines.headerOneNeedsService", locale)
                    : t("machines.headerNeedService", locale).replace("{n}", String(fleetNeedService))}
                </span>
              </>
            ) : null}
            {fleetInWorkshop > 0 ? (
              <>
                {" · "}
                {fleetInWorkshop === 1
                  ? t("machines.headerOneInWorkshop", locale)
                  : t("machines.headerInWorkshop", locale).replace("{n}", String(fleetInWorkshop))}
              </>
            ) : null}
          </p>
        </div>
        {canEdit ? (
          <div className="flex items-center gap-2">
            <Link href="/machines/import" className={buttonVariants({ variant: "secondary" })}>
              {t("machines.import", locale)}
            </Link>
            <Link href="/machines/new" className={buttonVariants({ variant: "primary" })}>
              <PlusIcon className="text-[1.1rem]" />
              {t("machines.add", locale)}
            </Link>
          </div>
        ) : null}
      </div>

      <Flash tone="success" message={sp.imported ? t("machines.importedN", locale).replace("{n}", sp.imported) : undefined} />

      {/* Search stays a form (it needs a keyboard), but the five dropdowns and the
          Search button that ate the first screen on a phone are now chips that apply
          on tap and write the same URL params. */}
      <div className="flex flex-col gap-3">
        <form className="flex gap-2">
          <div className="relative flex-1">
            <label htmlFor="q" className="sr-only">{t("machines.search", locale)}</label>
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[1.1rem] text-sand-400" />
            <Input id="q" name="q" defaultValue={sp.q ?? ""} placeholder={t("machines.search", locale)} className="pl-9" />
          </div>
          {sp.type ? <input type="hidden" name="type" value={sp.type} /> : null}
          {sp.status ? <input type="hidden" name="status" value={sp.status} /> : null}
          {sp.cc ? <input type="hidden" name="cc" value={sp.cc} /> : null}
          {sp.dept ? <input type="hidden" name="dept" value={sp.dept} /> : null}
          {showRetired ? <input type="hidden" name="retired" value="1" /> : null}
          <Button type="submit" variant="secondary">{t("common.search", locale)}</Button>
        </form>

        <FilterChips
          paramName="type"
          current={sp.type}
          options={typeOptions}
          path="/machines"
          search={search}
          label={t("machines.filterType", locale)}
        />
        <FilterChips
          paramName="status"
          current={sp.status}
          options={statusOptions}
          path="/machines"
          search={search}
          label={t("machines.filterStatus", locale)}
        />
        {costCentres.length > 0 ? (
          <FilterChips
            paramName="cc"
            current={sp.cc}
            options={[{ value: "", label: t("filters.all", locale) }, ...costCentres.map((c) => ({ value: c, label: c }))]}
            path="/machines"
            search={search}
            label={t("machines.costCentre", locale)}
          />
        ) : null}
        {departments.length > 0 ? (
          <FilterChips
            paramName="dept"
            current={sp.dept}
            options={[{ value: "", label: t("filters.all", locale) }, ...departments.map((d) => ({ value: d, label: d }))]}
            path="/machines"
            search={search}
            label={t("machines.department", locale)}
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-3 text-sm text-sand-500">
          <span className="tabular-nums">
            {t("machines.showingOf", locale).replace("{n}", String(machines.length)).replace("{total}", String(fleetTotal))}
          </span>
          <Link
            href={showRetired ? "/machines" : "/machines?retired=1"}
            className="focus-ring rounded-md font-medium text-brand-700"
          >
            {showRetired ? t("machines.hideRetired", locale) : t("machines.showRetired", locale)}
          </Link>
        </div>
      </div>

      {machines.length === 0 && !hasFilter ? (
        /* Nothing on the farm yet — a warm first run, with a ghost of the filled list. */
        <GetStarted
          icon={<MachinesIcon />}
          title={t("machines.firstRunTitle", locale)}
          hint={t("machines.firstRunHint", locale)}
          action={
            canEdit ? (
              <Link href="/machines/new" className={buttonVariants({ variant: "primary", size: "lg" })}>
                <PlusIcon className="text-[1.15rem]" />
                {t("machines.firstRunCta", locale)}
              </Link>
            ) : undefined
          }
          secondaryAction={
            canEdit ? (
              <Link href="/machines/import" className={buttonVariants({ variant: "secondary", size: "lg" })}>
                {t("machines.firstRunAlt", locale)}
              </Link>
            ) : undefined
          }
          preview={
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-sand-500">
                {t("machines.firstRunPreview", locale)}
              </p>
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center gap-3 rounded-xl border border-sand-200 bg-white p-3">
                  <div className="h-12 w-12 shrink-0 rounded-lg bg-sand-200" />
                  <div className="flex-1">
                    <div className="h-3 w-32 rounded bg-sand-200" />
                    <div className="mt-2 h-2.5 w-44 rounded bg-sand-100" />
                  </div>
                  <div className="h-5 w-16 rounded-full bg-sand-100" />
                </div>
              ))}
            </div>
          }
        />
      ) : machines.length === 0 ? (
        /* The filter is hiding everything — the fix is to clear it, not to add a machine. */
        <NoMatches
          title={t("empty.noMatchTitle", locale)}
          hint={t("empty.noMatchHint", locale)}
          action={
            <Link href="/machines" className={buttonVariants({ variant: "primary" })}>
              {t("empty.clearFilters", locale)}
            </Link>
          }
        />
      ) : (
        <>
          {/* Mobile: a driver recognises the green John Deere long before he reads
              "JD 6120". Photo leads, at a size you can actually see. */}
          <ul className="flex flex-col gap-2.5 lg:hidden">
            {machines.map((m) => (
              <li key={m.id}>
                <Card className="p-0">
                  <Link href={`/machines/${m.id}`} className="focus-ring flex gap-3.5 rounded-xl p-3">
                    {photo(m.id, "lg")}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <p className="truncate text-[1.05rem] font-semibold leading-snug text-sand-900">{m.name}</p>
                      <p className="mt-0.5 truncate text-sm text-sand-500">{subtitle(m)}</p>
                      <div className="mt-2 text-sm">{readingCell(m)}</div>
                      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2.5">
                        <MachineStatus value={m.status} locale={locale} />
                        {serviceCell(m, false)}
                      </div>
                    </div>
                  </Link>
                </Card>
              </li>
            ))}
          </ul>

          {/* Desktop: a table is for scanning columns, so the photo stays a thumb. */}
          <Card flush className="hidden lg:block">
            <Table>
              <Thead>
                <Tr>
                  <Th className="w-14"><span className="sr-only">{t("machines.primaryPhoto", locale)}</span></Th>
                  <Th>
                    <Link href={sortHref("name")} className="focus-ring inline-flex items-center gap-1 rounded">
                      {t("machines.name", locale)} {sortIndicator("name")}
                    </Link>
                  </Th>
                  <Th>{t("machines.type", locale)}</Th>
                  <Th>
                    <Link href={sortHref("reading")} className="focus-ring inline-flex items-center gap-1 rounded">
                      {t("machines.reading", locale)} {sortIndicator("reading")}
                    </Link>
                  </Th>
                  <Th>{t("machines.nextService", locale)}</Th>
                  <Th>{t("machines.whereItIs", locale)}</Th>
                  <Th className="text-right">{t("machines.costPerUnit", locale)}</Th>
                  <Th className="text-right">{t("machines.doColumn", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {machines.map((m) => {
                  const cpu = costPerUnit(m);
                  return (
                    <Tr key={m.id}>
                      <Td>{photo(m.id, "sm")}</Td>
                      <Td>
                        <Link href={`/machines/${m.id}`} className="focus-ring rounded font-semibold text-sand-900 hover:text-brand-700 hover:underline">
                          {m.name}
                        </Link>
                        <span className="mt-0.5 block text-xs text-sand-500">{subtitle(m)}</span>
                      </Td>
                      <Td className="text-sand-600">{typeLabel(m.type, locale)}</Td>
                      <Td>{readingCell(m)}</Td>
                      <Td>{serviceCell(m)}</Td>
                      <Td><MachineStatus value={m.status} locale={locale} /></Td>
                      <Td className="text-right tabular-nums text-sand-700">
                        {cpu != null ? rands(cpu) : <span className="text-sand-300">—</span>}
                      </Td>
                      <Td className="text-right">
                        {/* A row you can act on — logging hours used to mean opening the
                            machine, logging, coming back and losing your place. */}
                        <Link
                          href={`/machines/${m.id}`}
                          className={buttonVariants({ variant: "secondary", size: "sm" })}
                        >
                          {t("machines.logHours", locale)}
                          <ChevronRightIcon className="text-[1rem]" />
                        </Link>
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </Card>
        </>
      )}

      {/* Stale readings are called out in the rows above; this keeps the legend honest. */}
      {machines.some(isStale) ? (
        <p className="text-xs text-sand-500">
          <Badge tone="warning">{t("machines.stale", locale)}</Badge>{" "}
          {t("dashboard.staleMetersHint", locale)}
        </p>
      ) : null}
    </div>
  );
}
