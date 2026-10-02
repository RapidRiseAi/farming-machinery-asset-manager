import Link from "next/link";
import { requireProfile, currentFarmId } from "@/lib/auth";
import { farmPermissionState } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { canViewFarmCosts } from "@/lib/cost-visibility";
import { sanitiseFilterTerm } from "@/lib/search-filter";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { summariseCosts, costPerMeter } from "@/lib/cost";
import { meterReading, meterUnit, relativeDate, num, todayLocal } from "@/lib/format";
import { SETTING_NUMBERS } from "@/lib/settings";
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
import { Field } from "@/components/ui/field";
import { buttonVariants } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { GetStarted, NoMatches } from "@/components/ui/empty-state";
import { FilterBar, type ChipOption, type FilterGroup } from "@/components/ui/filter-bar";
import { hrefWithParams } from "@/components/ui/filter-state";
import { withTab } from "@/components/ui/tabs-url";
import { Flash } from "@/components/ui/flash";
import { Photo } from "@/components/ui/photo";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { ActionMenu } from "@/components/ui/action-menu";
import { menuItemClass } from "@/components/ui/menu-item";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { OfflineForm } from "@/components/offline/offline-form";
import { MachinesIcon, PlusIcon } from "@/components/ui/icons";
import { addReading } from "./[id]/reading-actions";

type MachineRow = {
  id: string;
  farm_id: string;
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

type SP = {
  type?: string;
  status?: string;
  q?: string;
  sort?: string;
  dir?: string;
  retired?: string;
  imported?: string;
  cc?: string;
  dept?: string;
  service?: string;
  error?: string;
  saved?: string;
};

const SERVICE_FILTERS = ["due", "overdue", "none"] as const;
const SORTS = ["attention", "reading", "lastread"] as const;

/** Below this many machines a search box and a filter panel are clutter, not help. */
const FILTERS_FROM = 6;

const worst = (a: string, b: string) => {
  const rank: Record<string, number> = { overdue: 3, due_soon: 2, ok: 1 };
  return (rank[b] ?? 0) > (rank[a] ?? 0) ? b : a;
};

export default async function MachinesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const profile = await requireProfile();
  const sp = await searchParams;
  const locale = profile.lang;

  // `sort` is "" (name) or one of SORTS; a legacy `sort=name` from an old link reads as name.
  const sort = (SORTS as readonly string[]).includes(sp.sort ?? "") ? (sp.sort as (typeof SORTS)[number]) : "";
  // Name reads A to Z by default; the highest reading is the useful end of that one.
  const dir = sp.dir === "asc" || sp.dir === "desc" ? sp.dir : sort === "reading" ? "desc" : "asc";
  const service = (SERVICE_FILTERS as readonly string[]).includes(sp.service ?? "") ? sp.service! : "";
  const showRetired = sp.retired === "1";

  const supabase = await createClient();
  // Multi-site (F7): scope the list to the farm the user is currently acting in. For a
  // single-farm user this is simply their farm (RLS already scopes it); a multi-site user
  // sees the farm chosen in the site switcher. null: rr_admin/workshop (RLS-only scope).
  const farmId = await currentFarmId(profile);
  const permissionState = await farmPermissionState(profile, farmId);
  const canEdit = permissionState.role === "owner" || permissionState.role === "manager";
  const canAddReading = permissionState.role != null &&
    ["rr_admin", "owner", "manager", "mechanic", "operator"].includes(permissionState.role);
  const hasFullFleetGrant = permissionState.grants.has("see_all_vehicles");
  const costsVisible = profile.role === "rr_admin" || await canViewFarmCosts(supabase, farmId);

  // The list query has no range: a farm's fleet is bounded by its vehicle slots, and the
  // service filter and "needs attention" sort below need the whole set to be honest.
  let query = supabase
    .from("machines")
    .select("id, farm_id, name, type, make, model, year, reg_no, status, meter_type, current_reading, current_reading_date, cost_centre, primary_attachment_id")
    .is("deleted_at", null)
    .order("name", { ascending: true });
  if (farmId) query = query.eq("farm_id", farmId);
  if (sp.type) query = query.eq("type", sp.type);
  if (sp.status) query = query.eq("status", sp.status);
  else if (!showRetired) query = query.not("status", "in", "(retired,sold)");
  if (sp.cc) query = query.eq("cost_centre", sp.cc);
  if (sp.dept) query = query.eq("department", sp.dept);
  // Sanitised, not interpolated raw: PostgREST reads `or=(...)` as an expression,
  // so a comma or a parenthesis in the search box would end one condition and
  // start another. See src/lib/search-filter.ts.
  const qTerm = sp.q ? sanitiseFilterTerm(sp.q) : "";
  if (qTerm)
    query = query.or(
      `name.ilike.%${qTerm}%,make.ilike.%${qTerm}%,model.ilike.%${qTerm}%,serial_no.ilike.%${qTerm}%,reg_no.ilike.%${qTerm}%`,
    );

  // Distinct cost-centre / department values (farm-scoped by RLS) for the FR-3.4 filters,
  // plus the unfiltered fleet totals the header needs ("12 on the farm").
  let dimQuery = supabase
    .from("machines")
    .select("id, cost_centre, department, status")
    .is("deleted_at", null);
  if (farmId) dimQuery = dimQuery.eq("farm_id", farmId);

  let costQ = supabase.from("cost_entries").select("machine_id, type, amount_cents").is("deleted_at", null);
  if (farmId) costQ = costQ.eq("farm_id", farmId);

  type CostRow = { machine_id: string | null; type: string; amount_cents: number | null };
  const [{ data }, { data: dimData }, { data: splData }, costResult, farmResult] = await Promise.all([
    query,
    dimQuery,
    supabase.from("service_plan_lines").select("machine_id, status").is("deleted_at", null),
    costsVisible ? costQ : Promise.resolve({ data: [] as CostRow[] }),
    farmId
      ? supabase.from("farms").select("settings").eq("id", farmId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const fetched = (data as MachineRow[] | null) ?? [];

  const allRows = (dimData as { id: string; cost_centre: string | null; department: string | null; status: string }[] | null) ?? [];
  const costCentres = [...new Set(allRows.map((r) => r.cost_centre).filter((v): v is string => !!v))].sort();
  const departments = [...new Set(allRows.map((r) => r.department).filter((v): v is string => !!v))].sort();
  const liveRows = allRows.filter((r) => r.status !== "retired" && r.status !== "sold");
  const fleetTotal = liveRows.length;
  const hasRetired = allRows.length > fleetTotal;
  const fleetInWorkshop = liveRows.filter((r) => r.status === "in_workshop").length;

  // Worst service status per machine, and which machines have no plan at all, the
  // second is a real to-do that used to render as an invisible sand-300 dash.
  const svcByMachine = new Map<string, string>();
  for (const l of (splData as { machine_id: string; status: string }[] | null) ?? []) {
    svcByMachine.set(l.machine_id, worst(svcByMachine.get(l.machine_id) ?? "ok", l.status));
  }
  const needsService = (id: string) => {
    const s = svcByMachine.get(id);
    return s === "overdue" || s === "due_soon";
  };
  const fleetNeedService = liveRows.filter((r) => needsService(r.id)).length;

  // The farm's own stale window (Settings > stale_reading_days), not a hard-coded month:
  // a farm whose machines stand idle for a season would otherwise see every row amber.
  const farmSettings = ((farmResult.data as { settings: Record<string, unknown> | null } | null)?.settings ?? {}) as Record<string, unknown>;
  const staleSetting = Number(farmSettings.stale_reading_days);
  const staleDays = Number.isFinite(staleSetting) && staleSetting > 0 ? staleSetting : SETTING_NUMBERS.stale_reading_days;
  const staleCut = todayLocal(new Date(Date.now() - staleDays * 86400000));
  const isStale = (m: MachineRow) =>
    m.meter_type !== "none" && (!m.current_reading_date || m.current_reading_date < staleCut);

  // Service filter, in JS on the same map the cells read, so the two cannot disagree.
  const filtered = fetched.filter((m) => {
    const s = svcByMachine.get(m.id);
    if (service === "due") return s === "overdue" || s === "due_soon";
    if (service === "overdue") return s === "overdue";
    if (service === "none") return !s;
    return true;
  });

  const byName = (a: MachineRow, b: MachineRow) => a.name.localeCompare(b.name, locale === "af" ? "af" : "en");
  const attentionRank = (m: MachineRow) => {
    const s = svcByMachine.get(m.id);
    if (m.status === "out_of_service") return 0;
    if (s === "overdue") return 1;
    if (s === "due_soon") return 2;
    if (!s) return 3;
    if (isStale(m)) return 4;
    return 5;
  };
  const sign = dir === "desc" ? -1 : 1;
  const machines = filtered.slice().sort((a, b) => {
    if (sort === "attention") return attentionRank(a) - attentionRank(b) || byName(a, b);
    if (sort === "reading") {
      // No meter or no reading sinks to the end in either direction.
      const ra = a.meter_type === "none" ? null : a.current_reading;
      const rb = b.meter_type === "none" ? null : b.current_reading;
      if (ra == null && rb == null) return byName(a, b);
      if (ra == null) return 1;
      if (rb == null) return -1;
      return (ra - rb) * sign || byName(a, b);
    }
    if (sort === "lastread") {
      // Longest since read first; never read leads, calendar-only machines trail.
      const da = a.meter_type === "none" ? "~" : a.current_reading_date ?? "";
      const db = b.meter_type === "none" ? "~" : b.current_reading_date ?? "";
      return da.localeCompare(db) || byName(a, b);
    }
    return byName(a, b) * sign;
  });

  // Primary vehicle image (0280): batch-sign the referenced photos, machine-id to URL.
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
      // NOTE: the BATCH api (`createSignedUrls`) takes no `transform`, only the
      // single-object `createSignedUrl` does, and the signature covers the
      // transformation, so the parameters cannot be appended afterwards. Signing
      // 15 photos one at a time to get a resize would be 15 round trips to save
      // bytes, which is the wrong trade on this screen.
      //
      // So the list keeps the batch call and takes the wins that need no server
      // support: `<Photo>` gives every thumbnail intrinsic dimensions (no layout
      // shift as photos land) and lazy loading (only what is on screen is
      // fetched). See lib/storage-image.ts.
      const { data: signed } = await supabase.storage
        .from("machine-photos")
        .createSignedUrls(paths, 3600);
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

  // Cost per hour / km, from the same ledger that feeds the reports (F1 `cost.ts`), so
  // the list and the machine page never disagree.
  const costData = ((costResult.data as CostRow[] | null) ?? []);
  const costByMachine = new Map<string, { type: string; amount_cents: number | null }[]>();
  for (const c of costData) {
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

  // The current query string, so chips, sort links and search preserve everything else.
  const currentParams = new URLSearchParams();
  if (sp.type) currentParams.set("type", sp.type);
  if (sp.status) currentParams.set("status", sp.status);
  if (sp.q) currentParams.set("q", sp.q);
  if (sp.cc) currentParams.set("cc", sp.cc);
  if (sp.dept) currentParams.set("dept", sp.dept);
  if (service) currentParams.set("service", service);
  if (showRetired) currentParams.set("retired", "1");
  if (sort) currentParams.set("sort", sort);
  if (sp.dir === "asc" || sp.dir === "desc") currentParams.set("dir", sp.dir);
  const search = currentParams.toString();
  // This list as it stands, filters and all: the detail page's back link returns here
  // (`?from=`, checked by backHref), and so does a reading logged from a row.
  const listHref = search ? `/machines?${search}` : "/machines";
  const detailHref = (id: string) =>
    search ? `/machines/${id}?from=${encodeURIComponent(listHref)}` : `/machines/${id}`;

  /** Desktop column headers: the same sort the Filters panel sets, plus a direction. */
  const sortHref = (col: "" | "reading") => {
    const active = sort === col;
    const next = active ? (dir === "asc" ? "desc" : "asc") : col === "reading" ? "desc" : "asc";
    return hrefWithParams("/machines", search, { sort: col, dir: next });
  };
  const sortState = (col: "" | "reading"): "asc" | "desc" | null => (sort === col ? dir : null);

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
  const serviceOptions: ChipOption[] = [
    { value: "", label: t("filters.all", locale) },
    { value: "due", label: t("machines.serviceNeeded", locale) },
    { value: "overdue", label: t("ui.overdue", locale) },
    { value: "none", label: t("machines.presetNoPlan", locale) },
  ];
  const sortOptions: ChipOption[] = [
    { value: "", label: t("machines.sortName", locale) },
    { value: "attention", label: t("machines.sortAttention", locale) },
    { value: "reading", label: t("machines.sortReading", locale) },
    { value: "lastread", label: t("machines.sortLastRead", locale) },
  ];
  const groups: FilterGroup[] = [
    { paramName: "service", label: t("machines.service", locale), current: service, options: serviceOptions },
    { paramName: "type", label: t("machines.filterType", locale), current: sp.type, options: typeOptions },
    { paramName: "status", label: t("machines.filterStatus", locale), current: sp.status, options: statusOptions },
    ...(costCentres.length > 0
      ? [{
          paramName: "cc",
          label: t("machines.costCentre", locale),
          current: sp.cc,
          options: [{ value: "", label: t("filters.all", locale) }, ...costCentres.map((c) => ({ value: c, label: c }))],
        }]
      : []),
    ...(departments.length > 0
      ? [{
          paramName: "dept",
          label: t("machines.department", locale),
          current: sp.dept,
          options: [{ value: "", label: t("filters.all", locale) }, ...departments.map((d) => ({ value: d, label: d }))],
        }]
      : []),
    { paramName: "sort", label: t("machines.sortLabel", locale), current: sort, options: sortOptions },
  ];

  const hasFilter = !!(sp.type || sp.status || sp.q || sp.cc || sp.dept || service);
  // A driver with one or two machines gets the machines, not a search box, a Filters
  // button and "Showing 1 of 1". The tools come back as the fleet grows, and whenever
  // a link arrives already filtered (so the filter can be seen and cleared).
  const showFilters = fleetTotal >= FILTERS_FROM || hasFilter || !!sort;
  const listTotal = showRetired ? allRows.length : fleetTotal;
  const showCount = hasFilter || machines.length !== listTotal;
  // Retired and sold machines are an office matter.
  const showRetiredToggle = canEdit && (hasRetired || showRetired);
  const canLog = (m: MachineRow) =>
    canAddReading && m.meter_type !== "none" && m.status !== "retired" && m.status !== "sold";
  const showReadingActions = machines.some(canLog);
  const closeLabel = t("ui.close", locale);
  const today = todayLocal();
  const clearHref = hrefWithParams("/machines", search, { type: "", status: "", q: "", cc: "", dept: "", service: "" });
  // The sticker sheet prints what the list is narrowed to (type, cost centre, department,
  // search), so "the bakkies" or "camp 3" can be done in one go; unfiltered, the fleet.
  const qrHref = hrefWithParams("/machines/qr", "", {
    type: sp.type ?? "",
    cc: sp.cc ?? "",
    dept: sp.dept ?? "",
    q: sp.q ?? "",
  });

  /**
   * The service cell, a status, or a "set up a plan" prompt when there is no plan.
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
        "inline-flex items-center gap-1 rounded-full border border-dashed border-sand-300 px-2.5 py-1 text-xs font-medium text-brand-ink";
      return linked ? (
        <Link
          href={withTab(detailHref(m.id), "servicing")}
          className={`focus-ring ${look} hover:border-brand-300 hover:bg-brand-tint`}
        >
          <PlusIcon className="text-sm" />
          {t("machines.setUpPlan", locale)}
        </Link>
      ) : (
        <span className={look}>
          <PlusIcon className="text-sm" />
          {t("machines.setUpPlan", locale)}
        </span>
      );
    }
    return <ServiceStatus value={s} locale={locale} />;
  };

  /** Meter reading + when it was last read, a stale reading is what breaks service dates. */
  const readingCell = (m: MachineRow) => {
    if (m.meter_type === "none") {
      return <span className="text-sand-500">{t("machines.noMeter", locale)}</span>;
    }
    return (
      <span className="block">
        <span className="font-medium tabular-nums text-sand-900">
          {m.current_reading != null
            ? meterReading(m.current_reading, m.meter_type, locale)
            : t("machines.noReading", locale)}
        </span>
        {/* Stale is said in a word on the row it applies to; a legend under the list
            used to explain amber text that nothing labelled. */}
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-sand-500">
          {m.current_reading_date
            ? t("machines.readWhen", locale).replace("{when}", relativeDate(m.current_reading_date, locale))
            : t("machines.neverRead", locale)}
          {isStale(m) ? <Badge tone="warning">{t("machines.stale", locale)}</Badge> : null}
        </span>
      </span>
    );
  };

  /**
   * Log a reading without leaving the list: an operator's most frequent task. The same
   * offline-capable form as the machine page, so a reading taken out of signal is queued.
   */
  const logReading = (m: MachineRow, where: "card" | "row") => {
    const label = m.meter_type === "km" ? t("machines.logKm", locale) : t("machines.logHours", locale);
    const fieldId = `${where}-${m.id}`;
    const last =
      m.current_reading != null
        ? t("machines.lastReadingHint", locale)
            .replace("{reading}", meterReading(m.current_reading, m.meter_type, locale))
            .replace(
              "{when}",
              m.current_reading_date ? relativeDate(m.current_reading_date, locale) : t("machines.neverRead", locale),
            )
        : undefined;
    return (
      <DialogForm
        trigger={label}
        triggerVariant="secondary"
        triggerSize={where === "row" ? "sm" : "md"}
        triggerFullWidth={where === "card"}
        title={label}
        description={m.name}
        closeLabel={closeLabel}
        size="md"
      >
        <OfflineForm action={addReading} type="log_reading" scope="app" locale={locale}>
          <input type="hidden" name="machine_id" value={m.id} />
          <input type="hidden" name="farm_id" value={m.farm_id} />
          {/* Back to this list, not off to the machine's page. */}
          <input type="hidden" name="return_to" value={listHref} />
          <DialogFields>
            <Field
              label={`${t("machine.newReading", locale)} (${meterUnit(m.meter_type, locale)})`}
              htmlFor={`reading-${fieldId}`}
              hint={last}
              required
            >
              <Input
                id={`reading-${fieldId}`}
                name="reading"
                type="number"
                inputMode="decimal"
                step="0.1"
                min={m.current_reading ?? 0}
                required
              />
            </Field>
            <Field label={t("machine.date", locale)} htmlFor={`reading-date-${fieldId}`}>
              <Input id={`reading-date-${fieldId}`} name="reading_date" type="date" defaultValue={today} max={today} />
            </Field>
          </DialogFields>
          <DialogActions cancelLabel={t("common.cancel", locale)}>
            <SubmitButton variant="primary">{t("machine.log", locale)}</SubmitButton>
          </DialogActions>
        </OfflineForm>
      </DialogForm>
    );
  };

  /**
   * The card's picture. A real photo leads at a size a driver recognises; with no photo
   * a small type tile stands in, so an empty 132px box no longer truncates every name.
   * `alt=""` is correct here and only here: the card names the machine in adjacent text.
   */
  const cardVisual = (m: MachineRow) => {
    const url = photoUrlByMachine.get(m.id);
    if (!url) {
      return (
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-ink-subtle ring-1 ring-edge-soft">
          <MachinesIcon className="text-2xl" />
        </span>
      );
    }
    return (
      <Photo
        src={url}
        alt=""
        size="card"
        className="h-24 w-24 shrink-0 rounded-xl ring-1 ring-edge-soft sm:h-[132px] sm:w-[132px]"
        placeholder={<MachinesIcon className="text-4xl text-ink-subtle" />}
      />
    );
  };

  const rowThumb = (m: MachineRow) => (
    <Photo
      src={photoUrlByMachine.get(m.id)}
      alt=""
      size="thumb"
      className="h-12 w-12 shrink-0 rounded-lg ring-1 ring-edge-soft"
      placeholder={<MachinesIcon className="text-2xl text-ink-subtle" />}
    />
  );

  /** Make, model, reg/year, cost centre. The card leads with the type; the table has a Type column. */
  const subtitle = (m: MachineRow, withType: boolean) =>
    [
      withType ? typeLabel(m.type, locale) : null,
      m.make ? `${m.make}${m.model ? " " + m.model : ""}` : null,
      m.reg_no ?? (m.year ? String(m.year) : null),
      m.cost_centre,
    ]
      .filter(Boolean)
      .join(" · ");

  const headerMeta = (
    <span>
      {t("machines.headerCount", locale).replace("{n}", num(fleetTotal, 0))}
      {fleetNeedService > 0 ? (
        <>
          {" · "}
          {/* A way in, not just a number: narrows the list to exactly those machines. */}
          <Link
            href="/machines?service=due"
            className="focus-ring rounded font-medium text-status-due underline-offset-2 hover:underline"
          >
            {fleetNeedService === 1
              ? t("machines.headerOneNeedsService", locale)
              : t("machines.headerNeedService", locale).replace("{n}", String(fleetNeedService))}
          </Link>
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
    </span>
  );

  const headerActions = canEdit ? (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <Link href="/machines/new" className={buttonVariants({ variant: "primary", className: "flex-1 sm:flex-none" })}>
        <PlusIcon className="text-lg" />
        {t("machines.add", locale)}
      </Link>
      {/* Bulk tools are occasional, so they share one menu instead of a row of buttons. */}
      <ActionMenu
        title={t("machines.title", locale)}
        label={t("nav.more", locale)}
        closeLabel={closeLabel}
        trigger={t("nav.more", locale)}
      >
        <Link href={qrHref} className={menuItemClass()}>
          {t("machines.printQrStickers", locale)}
        </Link>
        <Link href="/machines/import" className={menuItemClass()}>
          {t("machines.import", locale)}
        </Link>
      </ActionMenu>
    </div>
  ) : undefined;

  const extra =
    showCount || showRetiredToggle ? (
      <>
        {showCount ? (
          <span className="tabular-nums">
            {t("machines.showingOf", locale)
              .replace("{n}", num(machines.length, 0))
              .replace("{total}", num(listTotal, 0))}
          </span>
        ) : null}
        {showRetiredToggle ? (
          <Link
            href={hrefWithParams("/machines", search, { retired: showRetired ? "" : "1", status: "" })}
            className="focus-ring inline-flex min-h-[48px] items-center rounded-md font-medium text-brand-ink sm:min-h-[36px]"
          >
            {showRetired ? t("machines.hideRetired", locale) : t("machines.showRetired", locale)}
          </Link>
        ) : null}
      </>
    ) : null;

  return (
    <PageContainer size="wide">
      {/* The header says how big the fleet is and what is wrong with it. */}
      <PageHeader
        title={t("machines.title", locale)}
        meta={headerMeta}
        lead={hasFullFleetGrant ? t("permissions.fullFleetActive", locale) : undefined}
        infoKey="machines"
        locale={locale}
        actions={headerActions}
      />

      <Flash tone="success" message={sp.imported ? t("machines.importedN", locale).replace("{n}", sp.imported) : undefined} />
      <Flash tone="success" message={sp.saved === "reading" ? t("ui.saved", locale) : undefined} />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />

      {/*
        One filter control: a search that narrows as you type, and a Filters button whose
        groups (service, type, status, cost centre, department, and the sort, so a phone
        can sort too) open on demand. What is filtering shows in words above the list,
        and the choice is remembered on this device until Clear.
      */}
      {showFilters ? (
        <FilterBar
          path="/machines"
          search={search}
          filtersLabel={t("filters.filters", locale)}
          clearLabel={t("filters.clearAll", locale)}
          groups={groups}
          searchField={{ label: t("machines.search", locale), clearLabel: t("common.clearSearch", locale) }}
          rememberKey="machines"
          extra={extra}
        />
      ) : extra ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-sand-500">{extra}</div>
      ) : null}

      {machines.length === 0 && !hasFilter && !showRetired ? (
        /* Nothing on the farm yet, a warm first run, with a ghost of the filled list. */
        <GetStarted
          icon={<MachinesIcon />}
          title={t("machines.firstRunTitle", locale)}
          hint={t("machines.firstRunHint", locale)}
          action={
            canEdit ? (
              <Link href="/machines/new" className={buttonVariants({ variant: "primary", size: "lg" })}>
                <PlusIcon className="text-lg" />
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
                <div key={i} className="flex items-center gap-3 rounded-xl border border-sand-200 bg-surface p-3">
                  <div className="h-12 w-12 shrink-0 rounded-lg bg-sand-200" />
                  <div className="min-w-0 flex-1">
                    <div className="h-3 w-32 max-w-full rounded bg-sand-200" />
                    <div className="mt-2 h-2.5 w-44 max-w-full rounded bg-sand-100" />
                  </div>
                  <div className="h-5 w-16 rounded-full bg-sand-100" />
                </div>
              ))}
            </div>
          }
        />
      ) : machines.length === 0 ? (
        /* The filter is hiding everything, the fix is to clear it, not to add a machine. */
        <NoMatches
          title={t("empty.noMatchTitle", locale)}
          hint={t("empty.noMatchHint", locale)}
          clearHref={clearHref}
          clearLabel={t("empty.clearFilters", locale)}
        />
      ) : (
        <>
          {/* Mobile: a driver recognises the green John Deere long before he reads
              "JD 6120", so a real photo leads; the name gets two lines, not an ellipsis. */}
          <ul className="flex flex-col gap-2.5 lg:hidden">
            {machines.map((m) => (
              <li key={m.id}>
                <Card className="p-0">
                  <Link href={detailHref(m.id)} className="focus-ring flex gap-3 rounded-xl p-3">
                    {cardVisual(m)}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <p className="line-clamp-2 break-words text-base font-semibold leading-snug text-sand-900">{m.name}</p>
                      <p className="mt-0.5 line-clamp-2 break-words text-sm text-sand-500">{subtitle(m, true)}</p>
                      <div className="mt-2 text-sm">{readingCell(m)}</div>
                      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2.5">
                        <MachineStatus value={m.status} locale={locale} />
                        {serviceCell(m, false)}
                      </div>
                    </div>
                  </Link>
                  {/* Outside the card's link: a button inside an `<a>` is invalid HTML. */}
                  {canLog(m) ? <div className="px-3 pb-3">{logReading(m, "card")}</div> : null}
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
                  <Th sort={sortState("")}>
                    <Link href={sortHref("")} className="focus-ring inline-flex items-center gap-1 rounded">
                      {t("machines.name", locale)}
                    </Link>
                  </Th>
                  <Th>{t("machines.type", locale)}</Th>
                  <Th sort={sortState("reading")}>
                    <Link href={sortHref("reading")} className="focus-ring inline-flex items-center gap-1 rounded">
                      {t("machines.reading", locale)}
                    </Link>
                  </Th>
                  <Th>{t("machines.nextService", locale)}</Th>
                  <Th>{t("machines.status", locale)}</Th>
                  {costsVisible ? <Th className="text-right">{t("machines.costPerUnit", locale)}</Th> : null}
                  {showReadingActions ? (
                    <Th className="text-right"><span className="sr-only">{t("common.actions", locale)}</span></Th>
                  ) : null}
                </Tr>
              </Thead>
              <Tbody>
                {machines.map((m) => {
                  const cpu = costPerUnit(m);
                  return (
                    <Tr key={m.id}>
                      <Td>{rowThumb(m)}</Td>
                      <Td>
                        <Link href={detailHref(m.id)} className="focus-ring rounded font-semibold text-sand-900 hover:text-brand-ink hover:underline">
                          {m.name}
                        </Link>
                        <span className="mt-0.5 block text-xs text-sand-500">{subtitle(m, false)}</span>
                      </Td>
                      <Td className="text-sand-600">{typeLabel(m.type, locale)}</Td>
                      <Td>{readingCell(m)}</Td>
                      <Td>{serviceCell(m)}</Td>
                      <Td><MachineStatus value={m.status} locale={locale} /></Td>
                      {costsVisible ? (
                        <Td className="text-right tabular-nums text-sand-700">
                          {cpu != null ? rands(cpu) : <span className="text-sand-400">-</span>}
                        </Td>
                      ) : null}
                      {showReadingActions ? (
                        <Td className="text-right">
                          {canLog(m) ? logReading(m, "row") : <span className="text-sand-400">-</span>}
                        </Td>
                      ) : null}
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </Card>
        </>
      )}
    </PageContainer>
  );
}
