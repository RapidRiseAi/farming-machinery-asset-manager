import { requireProfile } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { farmPermissionState } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { EmptyState, NoMatches } from "@/components/ui/empty-state";
import { Flash } from "@/components/ui/flash";
import { PlusIcon, TrashIcon } from "@/components/ui/icons";
import { ActionMenu } from "@/components/ui/action-menu";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SearchField } from "@/components/ui/search-field";
import { createPart, updatePart, deletePart } from "./actions";
import { trackPart } from "./stock-actions";
import { StoreCard, type StoreRow } from "@/components/stock/store-card";
import { CommitmentCard } from "@/components/parts/commitment-card";
import { shortfallCount, type ShortfallRow } from "@/lib/reorder";
import { num } from "@/lib/format";

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

/** Case-insensitive match on the four things a person searches a catalogue by. */
function matches(p: Part, q: string): boolean {
  const needle = q.toLocaleLowerCase("en-ZA");
  return [p.part_no, p.description, p.category, p.supplier].some(
    (v) => v != null && v.toLocaleLowerCase("en-ZA").includes(needle),
  );
}

export default async function PartsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const profile = await requireProfile();
  const sp = await searchParams;
  const locale = profile.lang;
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const permissionState = await farmPermissionState(profile);
  const selectedRole = permissionState.role;
  const farmId = permissionState.farmId;
  // The extra stock grant opens stock_items/movements only. Catalogue maintenance stays
  // with its existing role policy; the two controls must not imply the same authority.
  const canManageCatalogue = Boolean(selectedRole && ["owner", "manager", "mechanic"].includes(selectedRole));
  const canManageStock = permissionState.allows("manage_stock");
  const isFarmSide = Boolean(selectedRole && ["owner", "manager", "mechanic", "operator"].includes(selectedRole));
  const isAdmin = profile.role === "rr_admin";
  const canAdd = canManageCatalogue || isAdmin;
  const q = (sp.q ?? "").trim();

  // The WHOLE catalogue is read and the search filters it here. The store below joins to
  // these rows by id, and when the search ran in SQL a tracked part that did not match
  // the search lost its part number in the store ("-"). A farm catalogue is a few hundred
  // rows; filtering them in memory also keeps the typed text out of a PostgREST filter.
  const supabase = await createClient();
  const { data } = await supabase
    .from("parts_catalogue_visible")
    .select("id, farm_id, part_no, description, supplier, category, typical_cost_cents")
    .is("deleted_at", null)
    .order("part_no", { ascending: true });
  const allParts = (data as Part[] | null) ?? [];
  const parts = q ? allParts.filter((p) => matches(p, q)) : allParts;

  // The store (0450). Farm-side only by RLS, so an rr_admin or a contractor simply gets
  // nothing back and the section stays hidden rather than rendering an empty promise.
  const [{ data: stockData }, { data: machineData }] = await Promise.all([
    supabase
      .from("stock_items")
      .select("id, farm_id, part_catalogue_id, unit, on_hand, reorder_point, bin")
      .is("deleted_at", null),
    supabase
      .from("machines")
      .select("id, name")
      .is("deleted_at", null)
      .not("status", "in", "(retired,sold)")
      .order("name"),
  ]);
  const stockItems = (stockData ?? []) as StoreRow[];
  const machines = (machineData ?? []) as { id: string; name: string }[];

  // What the schedule has already spoken for (0503). The WINDOW is asked for rather than
  // worked out here: the days printed on the card are then the days the query used, by
  // construction, so there is no mirrored rule to drift. Both functions are SECURITY
  // INVOKER, so a farm id this session cannot reach simply comes back empty.
  let lookaheadDays = 0;
  let shortfall: ShortfallRow[] = [];
  if (farmId) {
    const { data: daysData } = await supabase.rpc("reorder_lookahead_days", { p_farm: farmId });
    lookaheadDays = typeof daysData === "number" ? daysData : 0;
    if (lookaheadDays > 0) {
      const { data: shortData } = await supabase.rpc("stock_shortfall", {
        p_farm: farmId,
        p_days: lookaheadDays,
      });
      shortfall = (shortData ?? []) as ShortfallRow[];
    }
  }
  const shortCount = shortfallCount(shortfall);

  // Join to the catalogue in memory: the two lists are already loaded, and a part may be a
  // GLOBAL row, which a PostgREST embed across the nullable farm_id would not follow.
  const partById = new Map(allParts.map((p) => [p.id, p]));
  const storeRows: StoreRow[] = stockItems
    .map((s) => {
      const p = partById.get(s.part_catalogue_id);
      return {
        ...s,
        part_no: p?.part_no ?? "-",
        description: p?.description ?? null,
        supplier: p?.supplier ?? null,
        typical_cost_cents: p?.typical_cost_cents ?? null,
      };
    })
    .sort((a, b) => a.part_no.localeCompare(b.part_no));
  const trackedPartIds = new Set(stockItems.map((s) => s.part_catalogue_id));
  const showStore = isFarmSide && !!farmId;

  // A row is editable when it is a farm row the user manages, or a global row and the
  // user is RR admin. (RLS also enforces this on write.)
  const canEditRow = (p: Part) => (p.farm_id == null ? isAdmin : canManageCatalogue);
  const canTrackRow = (p: Part) => showStore && canManageStock && !trackedPartIds.has(p.id);
  const hasRowMenu = parts.some((p) => canEditRow(p) || canTrackRow(p));

  // Adding a part was a `<details>` holding six fields plus a VAT checkbox.
  const addPart = canAdd ? (
    <DialogForm
      trigger={t("parts.add", locale)}
      triggerIcon={<PlusIcon />}
      title={t("parts.add", locale)}
      closeLabel={closeLabel}
    >
      <form action={createPart}>
        <DialogFields>
          <Field label={t("parts.partNo", locale)} htmlFor="new_part_no" required>
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
            <Input id="new_cost" name="typical_cost" inputMode="decimal" />
          </Field>
          <Checkbox name="incl_vat" value="1" label={t("parts.inclVat", locale)} className="self-end" />
        </DialogFields>
        <DialogActions cancelLabel={cancelLabel}>
          <SubmitButton variant="primary">{t("parts.add", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  ) : null;

  return (
    <PageContainer size="wide">
      <PageHeader
        title={t("parts.title", locale)}
        infoKey="parts"
        locale={locale}
        lead={
          <>
            {t("parts.subtitle", locale)}
            {showStore && shortCount > 0 ? (
              // Stated before the catalogue rather than only inside the card, because it
              // is the one thing on this screen that changes what somebody does today.
              <a
                href="#next"
                className="mt-1.5 block font-medium text-status-overdue underline underline-offset-2"
              >
                {t("reorder.headline", locale)
                  .replace("{count}", num(shortCount, 0))
                  .replace("{days}", num(lookaheadDays, 0))}
              </a>
            ) : null}
          </>
        }
        actions={addPart}
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      {/* What the next N days need (0503), above the shelf it is about. */}
      {showStore ? (
        <CommitmentCard
          locale={locale}
          rows={shortfall}
          days={lookaheadDays}
          canSetWindow={selectedRole === "owner" || selectedRole === "manager"}
        />
      ) : null}

      {/* The store, what is actually on the shelf (0450). Farm side only. */}
      {showStore ? (
        <StoreCard locale={locale} rows={storeRows} machines={machines} canManage={canManageStock} />
      ) : null}

      {/* Catalogue */}
      <Card>
        <CardHeader>
          <CardTitle>{t("parts.catalogue", locale)}</CardTitle>
        </CardHeader>

        {/* Search stays on the page. It is how you USE a catalogue of a few hundred parts,
            not something you occasionally capture, so putting it behind a button would
            cost a tap on the one control that is always wanted. */}
        {allParts.length > 0 ? (
          <SearchField
            label={t("parts.searchLabel", locale)}
            placeholder={t("parts.searchPlaceholder", locale)}
            clearLabel={t("common.clearSearch", locale)}
            defaultValue={q}
            className="mb-3"
          />
        ) : null}

        {allParts.length === 0 ? (
          <EmptyState title={t("parts.empty", locale)} hint={canAdd ? t("parts.emptyHint", locale) : undefined} />
        ) : parts.length === 0 ? (
          <NoMatches
            title={t("parts.noMatchTitle", locale)}
            hint={t("parts.noMatchHint", locale)}
            clearHref="/parts"
            clearLabel={t("common.clearSearch", locale)}
          />
        ) : (
          <Table stacked>
            <Thead>
              <Tr>
                <Th>{t("parts.partNo", locale)}</Th>
                <Th>{t("parts.description", locale)}</Th>
                <Th>{t("parts.category", locale)}</Th>
                <Th>{t("parts.supplier", locale)}</Th>
                <Th className="text-right">{t("parts.typicalCost", locale)}</Th>
                {showStore ? <Th>{t("stock.inStore", locale)}</Th> : null}
                {/* The row menu's column. Its trigger carries its own accessible name. */}
                {hasRowMenu ? <Th /> : null}
              </Tr>
            </Thead>
            <Tbody>
              {parts.map((p) => {
                const name = p.part_no ?? p.description ?? "-";
                return (
                  <Tr key={p.id}>
                    <Td label={t("parts.partNo", locale)} className="font-medium text-sand-900">
                      <span className="break-all">{p.part_no}</span>
                      {/* Most rows are the farm's own, so only the exception is marked. */}
                      {p.farm_id == null ? (
                        <span className="block text-xs font-normal text-sand-500">
                          {t("parts.scopeGlobalNote", locale)}
                        </span>
                      ) : null}
                    </Td>
                    <Td label={t("parts.description", locale)}>{p.description ?? "-"}</Td>
                    <Td label={t("parts.category", locale)}>{p.category ?? "-"}</Td>
                    <Td label={t("parts.supplier", locale)}>{p.supplier ?? "-"}</Td>
                    <Td label={t("parts.typicalCost", locale)} className="text-right tabular-nums">
                      {p.typical_cost_cents != null ? rands(p.typical_cost_cents) : "-"}
                    </Td>
                    {showStore ? (
                      <Td label={t("stock.inStore", locale)}>
                        {trackedPartIds.has(p.id) ? (
                          <Badge tone="ok">{t("stock.tracked", locale)}</Badge>
                        ) : (
                          <span className="text-sand-400" aria-label={t("stock.notTracked", locale)}>
                            -
                          </span>
                        )}
                      </Td>
                    ) : null}
                    {hasRowMenu ? (
                      <Td className="lg:text-right">
                        {/*
                          Everything done TO a part, behind one menu titled with it. This
                          was an "Edit" button in the part-number cell that opened a menu
                          (two taps under a label promising one) plus a "Track in store"
                          button repeated down every untracked row.
                        */}
                        {canEditRow(p) || canTrackRow(p) ? (
                          <ActionMenu title={name} label={t("common.actions", locale)} closeLabel={closeLabel}>
                            {canTrackRow(p) ? (
                              // Starting to track IS the decision to hold this part, which is
                              // why it lives on the catalogue row rather than in the store.
                              <form action={trackPart}>
                                <input type="hidden" name="part_catalogue_id" value={p.id} />
                                <SubmitButton look="menuItem">{t("stock.track", locale)}</SubmitButton>
                              </form>
                            ) : null}

                            {canEditRow(p) ? (
                              <DialogForm
                                triggerLook="menuItem"
                                trigger={t("common.edit", locale)}
                                title={name}
                                description={t("common.edit", locale)}
                                closeLabel={closeLabel}
                              >
                                <form action={updatePart}>
                                  <input type="hidden" name="id" value={p.id} />
                                  <DialogFields>
                                    <Field label={t("parts.partNoLabel", locale)} htmlFor={`e_no_${p.id}`} required>
                                      <Input id={`e_no_${p.id}`} name="part_no" defaultValue={p.part_no} required />
                                    </Field>
                                    <Field label={t("parts.descriptionLabel", locale)} htmlFor={`e_desc_${p.id}`}>
                                      <Input id={`e_desc_${p.id}`} name="description" defaultValue={p.description ?? ""} />
                                    </Field>
                                    <Field label={t("parts.categoryLabel", locale)} htmlFor={`e_cat_${p.id}`}>
                                      <Input id={`e_cat_${p.id}`} name="category" defaultValue={p.category ?? ""} />
                                    </Field>
                                    <Field label={t("parts.supplierLabel", locale)} htmlFor={`e_sup_${p.id}`}>
                                      <Input id={`e_sup_${p.id}`} name="supplier" defaultValue={p.supplier ?? ""} />
                                    </Field>
                                    <Field label={t("parts.costLabel", locale)} htmlFor={`e_cost_${p.id}`}>
                                      <Input
                                        id={`e_cost_${p.id}`}
                                        name="typical_cost"
                                        inputMode="decimal"
                                        defaultValue={
                                          p.typical_cost_cents != null ? (p.typical_cost_cents / 100).toFixed(2) : ""
                                        }
                                      />
                                    </Field>
                                  </DialogFields>
                                  <DialogActions cancelLabel={cancelLabel}>
                                    <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                                  </DialogActions>
                                </form>
                              </DialogForm>
                            ) : null}

                            {canEditRow(p) ? (
                              <ConfirmDialog
                                action={deletePart}
                                triggerLook="menuItem"
                                triggerIcon={<TrashIcon />}
                                triggerLabel={t("common.delete", locale)}
                                title={t("confirm.deletePartTitle", locale).replace("{part}", name)}
                                intro={t("confirm.deletePartIntro", locale)}
                                consequencesTitle={t("confirm.whatHappens", locale)}
                                consequences={[t("confirm.deletePartEffect1", locale)]}
                                footnote={t("confirm.softDeleteNote", locale)}
                                confirmLabel={t("confirm.deletePartYes", locale)}
                                cancelLabel={t("confirm.keepIt", locale)}
                                closeLabel={closeLabel}
                              >
                                <input type="hidden" name="id" value={p.id} />
                              </ConfirmDialog>
                            ) : null}
                          </ActionMenu>
                        ) : null}
                      </Td>
                    ) : null}
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </Card>
    </PageContainer>
  );
}
