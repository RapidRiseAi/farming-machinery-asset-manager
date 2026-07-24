import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Flash } from "@/components/ui/flash";
import { SearchIcon } from "@/components/ui/icons";
import { createPart, updatePart, deletePart } from "./actions";

type Part = {
  id: string;
  farm_id: string | null;
  part_no: string;
  description: string | null;
  supplier: string | null;
  category: string | null;
  typical_cost_cents: number | null;
};

type SP = { q?: string; error?: string; saved?: string };

export default async function PartsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const profile = await requireProfile();
  const sp = await searchParams;
  const locale = profile.language;
  // Farm crew maintain their own catalogue; RR admin maintains the GLOBAL library.
  const canManageFarm = ["owner", "manager", "mechanic"].includes(profile.role);
  const isAdmin = profile.role === "rr_admin";
  const canAdd = canManageFarm || isAdmin;

  const supabase = await createClient();
  let query = supabase
    .from("parts_catalogue")
    .select("id, farm_id, part_no, description, supplier, category, typical_cost_cents")
    .is("deleted_at", null)
    .order("part_no", { ascending: true });
  if (sp.q) query = query.or(`part_no.ilike.%${sp.q}%,description.ilike.%${sp.q}%,category.ilike.%${sp.q}%,supplier.ilike.%${sp.q}%`);
  const { data } = await query;
  const parts = (data as Part[] | null) ?? [];

  // A row is editable when it is a farm row the user manages, or a global row and the
  // user is RR admin. (RLS also enforces this on write.)
  const canEditRow = (p: Part) => (p.farm_id == null ? isAdmin : canManageFarm);

  const inputCls = "rounded-lg border border-sand-300 px-3 py-2 text-sm";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("parts.title", locale)}</h1>
          <p className="mt-0.5 text-sm text-sand-500">{t("parts.subtitle", locale)}</p>
        </div>
        <form method="get" className="flex items-end gap-2">
          <Field label={t("parts.search", locale)} htmlFor="q">
            <span className="relative block">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[1.1rem] text-sand-400" />
              <Input id="q" name="q" defaultValue={sp.q ?? ""} placeholder={t("parts.searchPlaceholder", locale)} className="pl-8" />
            </span>
          </Field>
          <SubmitButton variant="secondary">{t("parts.search", locale)}</SubmitButton>
        </form>
      </div>

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      {/* Add a part */}
      {canAdd ? (
        <Card>
          <details>
            <summary className="cursor-pointer font-semibold text-sand-900">{t("parts.add", locale)}</summary>
            <form action={createPart} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label={t("parts.partNo", locale)} htmlFor="new_part_no">
                <Input id="new_part_no" name="part_no" required />
              </Field>
              <Field label={t("parts.description", locale)} htmlFor="new_desc">
                <Input id="new_desc" name="description" />
              </Field>
              <Field label={t("parts.category", locale)} htmlFor="new_cat">
                <Input id="new_cat" name="category" placeholder={t("parts.categoryPlaceholder", locale)} />
              </Field>
              <Field label={t("parts.supplier", locale)} htmlFor="new_supplier">
                <Input id="new_supplier" name="supplier" />
              </Field>
              <Field label={t("parts.typicalCost", locale)} htmlFor="new_cost">
                <Input id="new_cost" name="typical_cost" inputMode="decimal" placeholder="R" />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-sand-700">
                <input type="checkbox" name="incl_vat" value="1" className="h-4 w-4 rounded border-sand-300" />
                {t("parts.inclVat", locale)}
              </label>
              <div className="sm:col-span-2 lg:col-span-3">
                <SubmitButton variant="primary" size="sm">{t("parts.add", locale)}</SubmitButton>
              </div>
            </form>
          </details>
        </Card>
      ) : null}

      {/* Catalogue */}
      <Card>
        <CardHeader><CardTitle>{t("parts.catalogue", locale)}</CardTitle></CardHeader>
        {parts.length === 0 ? (
          <EmptyState title={t("parts.empty", locale)} hint={canAdd ? t("parts.emptyHint", locale) : undefined} />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>{t("parts.partNo", locale)}</Th>
                <Th>{t("parts.description", locale)}</Th>
                <Th>{t("parts.category", locale)}</Th>
                <Th>{t("parts.supplier", locale)}</Th>
                <Th className="text-right">{t("parts.typicalCost", locale)}</Th>
                <Th>{t("parts.scope", locale)}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {parts.map((p) => (
                <Tr key={p.id}>
                  <Td className="font-medium text-sand-900">
                    {p.part_no}
                    {canEditRow(p) ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs font-medium text-brand-700">{t("common.edit", locale)}</summary>
                        <form action={updatePart} className="mt-2 flex flex-wrap gap-2">
                          <input type="hidden" name="id" value={p.id} />
                          <input name="part_no" defaultValue={p.part_no} placeholder={t("parts.partNo", locale)} className={`${inputCls} w-32`} required />
                          <input name="description" defaultValue={p.description ?? ""} placeholder={t("parts.description", locale)} className={`${inputCls} w-44`} />
                          <input name="category" defaultValue={p.category ?? ""} placeholder={t("parts.category", locale)} className={`${inputCls} w-32`} />
                          <input name="supplier" defaultValue={p.supplier ?? ""} placeholder={t("parts.supplier", locale)} className={`${inputCls} w-32`} />
                          <input name="typical_cost" inputMode="decimal" defaultValue={p.typical_cost_cents != null ? (p.typical_cost_cents / 100).toFixed(2) : ""} placeholder="R" className={`${inputCls} w-24`} />
                          <SubmitButton variant="secondary" size="sm">{t("common.save", locale)}</SubmitButton>
                          <span className="w-full" />
                        </form>
                        <form action={deletePart} className="mt-1">
                          <input type="hidden" name="id" value={p.id} />
                          <button className="text-xs text-status-overdue">{t("common.delete", locale)}</button>
                        </form>
                      </details>
                    ) : null}
                  </Td>
                  <Td>{p.description ?? "—"}</Td>
                  <Td>{p.category ?? "—"}</Td>
                  <Td>{p.supplier ?? "—"}</Td>
                  <Td className="text-right tabular-nums">{p.typical_cost_cents != null ? rands(p.typical_cost_cents) : "—"}</Td>
                  <Td>
                    <Badge tone={p.farm_id == null ? "info" : "neutral"}>
                      {p.farm_id == null ? t("parts.scopeGlobal", locale) : t("parts.scopeFarm", locale)}
                    </Badge>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
