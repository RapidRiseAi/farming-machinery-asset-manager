import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { qtyLabel, stockTone, type StockItem } from "@/lib/stock";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { AllClear } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrashIcon } from "@/components/ui/icons";
import { recordMovement, updateStockItem, untrackPart } from "@/app/(app)/parts/stock-actions";

export type StoreRow = StockItem & {
  part_no: string;
  description: string | null;
  supplier: string | null;
  typical_cost_cents: number | null;
};

/**
 * The store: what a farm actually holds, and the two things done to it.
 *
 * The list leads with the count and its tone, because "have we got one?" is the question
 * this screen exists to answer — the part number and the bin are how you then go and find
 * it. Receiving and issuing are inline per row rather than behind a modal: a farm doing a
 * delivery types six quantities in a row, and six dialogs is five too many.
 */
export function StoreCard({
  locale,
  rows,
  machines,
  canManage,
}: {
  locale: Lang;
  rows: StoreRow[];
  machines: { id: string; name: string }[];
  canManage: boolean;
}) {
  const low = rows.filter((r) => stockTone(r) !== "ok");

  return (
    <Card id="store">
      <CardHeader>
        <CardTitle>{t("stock.storeTitle", locale)}</CardTitle>
      </CardHeader>
      <p className="mb-3 text-sm text-sand-600">{t("stock.storeLead", locale)}</p>

      {rows.length === 0 ? (
        <AllClear
          title={t("stock.emptyTitle", locale)}
          hint={t("stock.emptyBody", locale)}
        />
      ) : (
        <>
          {low.length > 0 ? (
            <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {t("stock.lowSummary", locale)}{" "}
              <span className="font-semibold">{low.map((r) => r.part_no).join(", ")}</span>
            </p>
          ) : null}

          <ul className="flex flex-col divide-y divide-sand-100">
            {rows.map((r) => {
              const tone = stockTone(r);
              return (
                <li key={r.id} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-sm font-medium text-sand-900">{r.part_no}</span>
                    {r.description ? <span className="text-sm text-sand-600">{r.description}</span> : null}
                    <span className="ml-auto flex items-center gap-2">
                      <span
                        className={
                          tone === "ok"
                            ? "font-semibold tabular-nums text-sand-900"
                            : "font-semibold tabular-nums text-status-warn"
                        }
                      >
                        {qtyLabel(r.on_hand, r.unit)}
                      </span>
                      {tone === "negative" ? (
                        <Badge tone="danger">{t("stock.negative", locale)}</Badge>
                      ) : tone === "low" ? (
                        <Badge tone="warning">{t("stock.low", locale)}</Badge>
                      ) : null}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-sand-500">
                    {r.bin ? `${t("stock.bin", locale)}: ${r.bin} · ` : ""}
                    {r.reorder_point != null
                      ? `${t("stock.reorderAt", locale)} ${qtyLabel(r.reorder_point, r.unit)}`
                      : t("stock.noReorderPoint", locale)}
                    {r.typical_cost_cents ? ` · ${rands(r.typical_cost_cents)}` : ""}
                  </p>

                  {canManage ? (
                    <div className="mt-2 flex flex-wrap items-end gap-4">
                      {/* Receive — no machine, no cost to any vehicle. */}
                      <form action={recordMovement} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="stock_item_id" value={r.id} />
                        <input type="hidden" name="kind" value="receipt" />
                        <Field label={t("stock.receive", locale)} htmlFor={`rq-${r.id}`}>
                          <Input id={`rq-${r.id}`} name="qty" inputMode="decimal" className="w-24" />
                        </Field>
                        <Field label={t("stock.unitCost", locale)} htmlFor={`rc-${r.id}`}>
                          <Input id={`rc-${r.id}`} name="unit_cost" inputMode="decimal" className="w-28" />
                        </Field>
                        <SubmitButton variant="secondary" size="sm">{t("stock.receiveDo", locale)}</SubmitButton>
                      </form>

                      {/* Issue — to a machine. Naming a job card hands the cost to that card. */}
                      <form action={recordMovement} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="stock_item_id" value={r.id} />
                        <input type="hidden" name="kind" value="issue" />
                        <Field label={t("stock.issue", locale)} htmlFor={`iq-${r.id}`}>
                          <Input id={`iq-${r.id}`} name="qty" inputMode="decimal" className="w-24" />
                        </Field>
                        <Field label={t("stock.toMachine", locale)} htmlFor={`im-${r.id}`}>
                          <Select id={`im-${r.id}`} name="machine_id" className="w-44">
                            <option value="">{t("stock.noMachine", locale)}</option>
                            {machines.map((m) => (
                              <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                          </Select>
                        </Field>
                        <Field label={t("stock.unitCost", locale)} htmlFor={`ic-${r.id}`}>
                          <Input
                            id={`ic-${r.id}`}
                            name="unit_cost"
                            inputMode="decimal"
                            className="w-28"
                            defaultValue={r.typical_cost_cents ? (r.typical_cost_cents / 100).toFixed(2) : ""}
                          />
                        </Field>
                        <SubmitButton variant="secondary" size="sm">{t("stock.issueDo", locale)}</SubmitButton>
                      </form>

                      {/* Where it lives and when to reorder. Never the quantity. */}
                      <form action={updateStockItem} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="stock_item_id" value={r.id} />
                        <input type="hidden" name="unit" value={r.unit} />
                        <Field label={t("stock.reorderPoint", locale)} htmlFor={`rp-${r.id}`}>
                          <Input
                            id={`rp-${r.id}`}
                            name="reorder_point"
                            inputMode="decimal"
                            className="w-24"
                            defaultValue={r.reorder_point ?? ""}
                          />
                        </Field>
                        <Field label={t("stock.bin", locale)} htmlFor={`bn-${r.id}`}>
                          <Input id={`bn-${r.id}`} name="bin" className="w-40" defaultValue={r.bin ?? ""} />
                        </Field>
                        <SubmitButton variant="ghost" size="sm">{t("common.save", locale)}</SubmitButton>
                      </form>

                      <ConfirmDialog
                        action={untrackPart}
                        triggerLabel={t("stock.untrack", locale)}
                        triggerIcon={<TrashIcon />}
                        triggerVariant="ghost"
                        triggerSize="sm"
                        title={t("stock.untrackTitle", locale)}
                        intro={r.part_no}
                        consequences={[t("stock.untrackConsequence", locale)]}
                        confirmLabel={t("stock.untrack", locale)}
                        cancelLabel={t("common.cancel", locale)}
                        closeLabel={t("ui.close", locale)}
                      >
                        <input type="hidden" name="stock_item_id" value={r.id} />
                      </ConfirmDialog>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}
