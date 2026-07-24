import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import {
  MACHINE_TYPES,
  MACHINE_STATUSES,
  typeLabel,
  statusLabel,
} from "@/lib/machine-options";
import { Card } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { StatusPill, Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Flash } from "@/components/ui/flash";
import { MachinesIcon, PlusIcon, SearchIcon, ChevronUpIcon, ChevronDownIcon } from "@/components/ui/icons";

type MachineRow = {
  id: string;
  name: string;
  type: string;
  make: string | null;
  model: string | null;
  status: string;
  meter_type: string;
  current_reading: number | null;
  current_reading_date: string | null;
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
  let query = supabase
    .from("machines")
    .select("id, name, type, make, model, status, meter_type, current_reading, current_reading_date, primary_attachment_id")
    .is("deleted_at", null)
    .order(sort, { ascending: dir === "asc" });
  if (sp.type) query = query.eq("type", sp.type);
  if (sp.status) query = query.eq("status", sp.status);
  else if (!showRetired) query = query.not("status", "in", "(retired,sold)");
  if (sp.cc) query = query.eq("cost_centre", sp.cc);
  if (sp.dept) query = query.eq("department", sp.dept);
  if (sp.q) query = query.or(`name.ilike.%${sp.q}%,make.ilike.%${sp.q}%,model.ilike.%${sp.q}%,serial_no.ilike.%${sp.q}%`);
  const { data } = await query;
  const machines = (data as MachineRow[] | null) ?? [];

  // Distinct cost-centre / department values (farm-scoped by RLS) for the FR-3.4 filters.
  const { data: dimData } = await supabase
    .from("machines")
    .select("cost_centre, department")
    .is("deleted_at", null);
  const costCentres = [...new Set(((dimData as { cost_centre: string | null }[] | null) ?? []).map((r) => r.cost_centre).filter((v): v is string => !!v))].sort();
  const departments = [...new Set(((dimData as { department: string | null }[] | null) ?? []).map((r) => r.department).filter((v): v is string => !!v))].sort();

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

  // Worst service status per machine.
  const { data: splData } = await supabase
    .from("service_plan_lines")
    .select("machine_id, status")
    .is("deleted_at", null);
  const svcByMachine = new Map<string, string>();
  for (const l of (splData as { machine_id: string; status: string }[] | null) ?? []) {
    svcByMachine.set(l.machine_id, worst(svcByMachine.get(l.machine_id) ?? "ok", l.status));
  }

  const staleCut = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const isStale = (m: MachineRow) =>
    m.meter_type !== "none" && (!m.current_reading_date || m.current_reading_date < staleCut);

  // Preserve filters when building sort links.
  const sortHref = (col: "name" | "reading") => {
    const params = new URLSearchParams();
    if (sp.type) params.set("type", sp.type);
    if (sp.status) params.set("status", sp.status);
    if (sp.q) params.set("q", sp.q);
    if (sp.cc) params.set("cc", sp.cc);
    if (sp.dept) params.set("dept", sp.dept);
    if (showRetired) params.set("retired", "1");
    params.set("sort", col);
    params.set("dir", sort === (col === "reading" ? "current_reading" : "name") && dir === "asc" ? "desc" : "asc");
    return `/machines?${params.toString()}`;
  };
  const sortIndicator = (col: "name" | "reading") => {
    const active = sort === (col === "reading" ? "current_reading" : "name");
    if (!active) return null;
    return dir === "asc" ? <ChevronUpIcon className="text-[0.9rem]" /> : <ChevronDownIcon className="text-[0.9rem]" />;
  };

  const svcPill = (id: string) => {
    const s = svcByMachine.get(id);
    if (!s) return <span className="text-sand-300">—</span>;
    return <StatusPill status={s as "ok" | "due_soon" | "overdue"} label={t(`ui.status${s === "due_soon" ? "DueSoon" : s === "overdue" ? "Overdue" : "Ok"}`, locale)} />;
  };

  // Primary-image thumbnail (0280) with a graceful placeholder.
  const thumb = (id: string, size: "sm" | "md" = "md") => {
    const url = photoUrlByMachine.get(id);
    const cls = size === "sm" ? "h-9 w-9" : "h-11 w-11";
    return (
      <div className={`${cls} shrink-0 overflow-hidden rounded-lg bg-sand-100 ring-1 ring-sand-200`}>
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-sand-300">
            <MachinesIcon className="text-[1rem]" />
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("machines.title", locale)}</h1>
        {canEdit ? (
          <div className="flex items-center gap-2">
            <Link href="/machines/import" className={buttonVariants({ variant: "secondary", size: "sm" })}>
              {t("machines.import", locale)}
            </Link>
            <Link href="/machines/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
              <PlusIcon className="text-[1.1rem]" />
              {t("machines.add", locale)}
            </Link>
          </div>
        ) : null}
      </div>

      <Flash tone="success" message={sp.imported ? t("machines.importedN", locale).replace("{n}", sp.imported) : undefined} />

      <Card>
        <form className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <Field label={t("common.search", locale)} htmlFor="q" className="sm:min-w-[12rem] sm:flex-1">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[1.1rem] text-sand-400" />
              <Input id="q" name="q" defaultValue={sp.q ?? ""} placeholder={t("machines.search", locale)} className="pl-9" />
            </div>
          </Field>
          <Field label={t("machines.type", locale)} htmlFor="type" className="sm:w-40">
            <Select id="type" name="type" defaultValue={sp.type ?? ""}>
              <option value="">{t("machines.allTypes", locale)}</option>
              {MACHINE_TYPES.map((ty) => (
                <option key={ty} value={ty}>{typeLabel(ty, locale)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("machines.status", locale)} htmlFor="status" className="sm:w-40">
            <Select id="status" name="status" defaultValue={sp.status ?? ""}>
              <option value="">{t("machines.allStatuses", locale)}</option>
              {MACHINE_STATUSES.map((s) => (
                <option key={s} value={s}>{statusLabel(s, locale)}</option>
              ))}
            </Select>
          </Field>
          {costCentres.length > 0 ? (
            <Field label={t("machines.costCentre", locale)} htmlFor="cc" className="sm:w-40">
              <Select id="cc" name="cc" defaultValue={sp.cc ?? ""}>
                <option value="">{t("machines.allCostCentres", locale)}</option>
                {costCentres.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </Field>
          ) : null}
          {departments.length > 0 ? (
            <Field label={t("machines.department", locale)} htmlFor="dept" className="sm:w-40">
              <Select id="dept" name="dept" defaultValue={sp.dept ?? ""}>
                <option value="">{t("machines.allDepartments", locale)}</option>
                {departments.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </Select>
            </Field>
          ) : null}
          <div className="flex items-end">
            <Button type="submit" variant="secondary" fullWidth>
              {t("common.search", locale)}
            </Button>
          </div>
          {showRetired ? <input type="hidden" name="retired" value="1" /> : null}
        </form>
        <div className="mt-3 flex items-center gap-3 text-sm">
          {showRetired ? (
            <Link href="/machines" className="focus-ring rounded-md text-brand-700">{t("machines.hideRetired", locale)}</Link>
          ) : (
            <Link href="/machines?retired=1" className="focus-ring rounded-md text-brand-700">{t("machines.showRetired", locale)}</Link>
          )}
        </div>
      </Card>

      {machines.length === 0 ? (
        <EmptyState
          icon={<MachinesIcon />}
          title={t("machines.empty", locale)}
          hint={t("machines.emptyHint", locale)}
          action={
            canEdit ? (
              <Link href="/machines/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
                {t("machines.add", locale)}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* Mobile: cards */}
          <ul className="flex flex-col gap-2 lg:hidden">
            {machines.map((m) => (
              <li key={m.id}>
                <Link href={`/machines/${m.id}`} className="focus-ring block rounded-xl">
                  <Card className="transition-shadow hover:shadow-soft">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        {thumb(m.id)}
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-sand-900">{m.name}</p>
                          <p className="truncate text-sm text-sand-500">
                            {typeLabel(m.type, locale)}
                            {m.make ? ` · ${m.make}${m.model ? " " + m.model : ""}` : ""}
                          </p>
                        </div>
                      </div>
                      <Badge tone="neutral" className="shrink-0 capitalize">{statusLabel(m.status, locale)}</Badge>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2 text-sm">
                      <span className="text-sand-600">
                        {m.meter_type === "none"
                          ? "—"
                          : m.current_reading != null
                            ? `${m.current_reading} ${m.meter_type}`
                            : t("machines.noReading", locale)}
                        {isStale(m) ? <Badge tone="warning" className="ml-2">{t("machines.stale", locale)}</Badge> : null}
                      </span>
                      {svcPill(m.id)}
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>

          {/* Desktop: dense table */}
          <Card flush className="hidden lg:block">
            <Table>
              <Thead>
                <Tr>
                  <Th className="w-12"><span className="sr-only">{t("machines.primaryPhoto", locale)}</span></Th>
                  <Th>
                    <Link href={sortHref("name")} className="focus-ring inline-flex items-center gap-1 rounded">
                      {t("machines.name", locale)} {sortIndicator("name")}
                    </Link>
                  </Th>
                  <Th>{t("machines.type", locale)}</Th>
                  <Th>{t("machines.make", locale)}</Th>
                  <Th>
                    <Link href={sortHref("reading")} className="focus-ring inline-flex items-center gap-1 rounded">
                      {t("machines.reading", locale)} {sortIndicator("reading")}
                    </Link>
                  </Th>
                  <Th>{t("machines.service", locale)}</Th>
                  <Th>{t("machines.status", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {machines.map((m) => (
                  <Tr key={m.id}>
                    <Td>{thumb(m.id, "sm")}</Td>
                    <Td className="font-medium">
                      <Link href={`/machines/${m.id}`} className="focus-ring rounded font-medium text-brand-700 hover:underline">
                        {m.name}
                      </Link>
                    </Td>
                    <Td className="text-sand-600">{typeLabel(m.type, locale)}</Td>
                    <Td className="text-sand-600">{m.make ? `${m.make}${m.model ? " " + m.model : ""}` : "—"}</Td>
                    <Td>
                      {m.meter_type === "none"
                        ? "—"
                        : m.current_reading != null
                          ? `${m.current_reading} ${m.meter_type}`
                          : t("machines.noReading", locale)}
                      {isStale(m) ? <Badge tone="warning" className="ml-2">{t("machines.stale", locale)}</Badge> : null}
                    </Td>
                    <Td>{svcPill(m.id)}</Td>
                    <Td><Badge tone="neutral" className="capitalize">{statusLabel(m.status, locale)}</Badge></Td>
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
