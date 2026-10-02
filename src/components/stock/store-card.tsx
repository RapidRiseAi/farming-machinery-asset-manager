import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { todayLocal } from "@/lib/format";
import { qtyLabel, stockTone, type StockItem } from "@/lib/stock";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ActionMenu } from "@/components/ui/action-menu";
import { DialogActions, DialogFields, DialogForm, DialogSection } from "@/components/ui/dialog-form";
import { TrashIcon } from "@/components/ui/icons";
import {
  receiveDelivery,
  recordMovement,
  updateStockItem,
  untrackPart,
} from "@/app/(app)/parts/stock-actions";

export type StoreRow = StockItem & {
  part_no: string;
  description: string | null;
  supplier: string | null;
  typical_cost_cents: number | null;
};

/** A list long enough to scroll earns a one-line summary of what is low. */
const LOW_SUMMARY_FROM = 6;

/**
 * The store: what a farm actually holds, and the things done to it.
 *
 * Each row states what IS: the part, the count with its tone, and where it lives. The
 * count leads, because "have we got one?" is the question this screen exists to answer.
 *
 * Everything that CHANGES the count sits behind the row's menu, titled with the part.
 * This used to be three inline forms per row (seven boxes and four buttons, about 800px
 * per part on a phone), defended on the grounds that a delivery means typing six
 * quantities in a row. That case now has its own dialog, "Receive a delivery", which
 * lists every tracked part once and books the filled rows together, so the page no
 * longer grows by seven inputs for every part a farm decides to count.
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
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const today = todayLocal();
  const partName = (r: StoreRow) => (r.description ? `${r.part_no} · ${r.description}` : r.part_no);
  const onShelf = (r: StoreRow) =>
    t("stock.onShelf", locale).replace("{qty}", qtyLabel(r.on_hand, r.unit));

  return (
    <Card id="store">
      <CardHeader
        action={
          canManage && rows.length > 0 ? (
            <DialogForm
              trigger={t("stock.receiveDelivery", locale)}
              triggerVariant="secondary"
              triggerSize="sm"
              title={t("stock.receiveDelivery", locale)}
              description={t("stock.receiveDeliveryHint", locale)}
              closeLabel={closeLabel}
            >
              <form action={receiveDelivery} className="flex flex-col gap-3">
                <ul className="flex flex-col divide-y divide-sand-100">
                  {rows.map((r) => (
                    <li key={r.id} className="py-3 first:pt-0">
                      <input type="hidden" name="stock_item_id" value={r.id} />
                      <p className="break-words text-sm font-medium text-sand-900">{partName(r)}</p>
                      <p className="mb-2 text-xs text-sand-500">{onShelf(r)}</p>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label={t("revise.qty", locale)} htmlFor={`dq-${r.id}`}>
                          <Input id={`dq-${r.id}`} name={`qty__${r.id}`} inputMode="decimal" />
                        </Field>
                        <Field label={t("stock.unitCost", locale)} htmlFor={`dc-${r.id}`}>
                          <Input id={`dc-${r.id}`} name={`unit_cost__${r.id}`} inputMode="decimal" />
                        </Field>
                      </div>
                    </li>
                  ))}
                </ul>
                <DialogFields>
                  <DialogSection title={t("stock.deliveryMore", locale)}>
                    <Field label={t("stock.deliveredOn", locale)} htmlFor="delivery-date">
                      <Input id="delivery-date" name="occurred_on" type="date" defaultValue={today} max={today} />
                    </Field>
                    <Field label={t("stock.deliveryNote", locale)} htmlFor="delivery-note">
                      <Input id="delivery-note" name="note" />
                    </Field>
                  </DialogSection>
                </DialogFields>
                <DialogActions cancelLabel={cancelLabel}>
                  <SubmitButton variant="primary">{t("stock.receiveDo", locale)}</SubmitButton>
                </DialogActions>
              </form>
            </DialogForm>
          ) : null
        }
      >
        <CardTitle>{t("stock.storeTitle", locale)}</CardTitle>
      </CardHeader>
      <p className="mb-3 text-sm text-sand-600">{t("stock.storeLead", locale)}</p>

      {rows.length === 0 ? (
        <EmptyState title={t("stock.emptyTitle", locale)} hint={t("stock.emptyBody", locale)} />
      ) : (
        <>
          {low.length > 0 && rows.length >= LOW_SUMMARY_FROM ? (
            <p className="mb-3 rounded-lg border border-callout-warn-edge bg-callout-warn-bg px-3 py-2 text-sm text-callout-warn-ink">
              {t("stock.lowSummary", locale)}{" "}
              <span className="break-words font-semibold">{low.map((r) => r.part_no).join(", ")}</span>
            </p>
          ) : null}

          <ul className="flex flex-col divide-y divide-sand-100">
            {rows.map((r) => {
              const tone = stockTone(r);
              const where = [
                r.bin ? `${t("stock.bin", locale)}: ${r.bin}` : null,
                r.reorder_point != null
                  ? `${t("stock.reorderAt", locale)} ${qtyLabel(r.reorder_point, r.unit)}`
                  : t("stock.noReorderPoint", locale),
                r.typical_cost_cents ? rands(r.typical_cost_cents) : null,
              ].filter(Boolean);
              return (
                <li key={r.id} className="flex items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <span className="break-all font-mono text-sm font-medium text-sand-900">{r.part_no}</span>
                      {r.description ? (
                        <span className="min-w-0 break-words text-sm text-sand-600">{r.description}</span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 break-words text-xs text-sand-500">{where.join(" · ")}</p>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span
                      className={
                        tone === "negative"
                          ? "font-semibold tabular-nums text-status-overdue"
                          : tone === "low"
                            ? "font-semibold tabular-nums text-status-due"
                            : "font-semibold tabular-nums text-sand-900"
                      }
                    >
                      {qtyLabel(r.on_hand, r.unit)}
                    </span>
                    {tone === "negative" ? (
                      <StatusBadge label={t("stock.negative", locale)} tone="danger" shape="square" />
                    ) : tone === "low" ? (
                      <StatusBadge label={t("stock.low", locale)} tone="warning" shape="triangle" />
                    ) : null}
                  </div>

                  {canManage ? (
                    <ActionMenu title={partName(r)} label={t("common.actions", locale)} closeLabel={closeLabel}>
                      {/* Issue, to a machine. The cost goes to that vehicle. */}
                      <DialogForm
                        triggerLook="menuItem"
                        trigger={t("stock.takeOut", locale)}
                        title={partName(r)}
                        description={`${t("stock.takeOut", locale)}. ${onShelf(r)}`}
                        closeLabel={closeLabel}
                        size="md"
                      >
                        <form action={recordMovement}>
                          <input type="hidden" name="stock_item_id" value={r.id} />
                          <input type="hidden" name="kind" value="issue" />
                          <DialogFields>
                            <Field label={t("revise.qty", locale)} htmlFor={`iq-${r.id}`} required>
                              <Input id={`iq-${r.id}`} name="qty" inputMode="decimal" required />
                            </Field>
                            <Field label={t("stock.toMachine", locale)} htmlFor={`im-${r.id}`}>
                              <Select id={`im-${r.id}`} name="machine_id">
                                <option value="">{t("stock.noMachine", locale)}</option>
                                {machines.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.name}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <Field label={t("stock.unitCost", locale)} htmlFor={`ic-${r.id}`}>
                              <Input
                                id={`ic-${r.id}`}
                                name="unit_cost"
                                inputMode="decimal"
                                defaultValue={r.typical_cost_cents ? (r.typical_cost_cents / 100).toFixed(2) : ""}
                              />
                            </Field>
                          </DialogFields>
                          <DialogActions cancelLabel={cancelLabel}>
                            <SubmitButton variant="primary">{t("stock.issueDo", locale)}</SubmitButton>
                          </DialogActions>
                        </form>
                      </DialogForm>

                      {/* Receive one part, no machine, no cost to any vehicle. */}
                      <DialogForm
                        triggerLook="menuItem"
                        trigger={t("stock.receiveOne", locale)}
                        title={partName(r)}
                        description={`${t("stock.receiveOne", locale)}. ${onShelf(r)}`}
                        closeLabel={closeLabel}
                        size="md"
                      >
                        <form action={recordMovement}>
                          <input type="hidden" name="stock_item_id" value={r.id} />
                          <input type="hidden" name="kind" value="receipt" />
                          <DialogFields>
                            <Field label={t("revise.qty", locale)} htmlFor={`rq-${r.id}`} required>
                              <Input id={`rq-${r.id}`} name="qty" inputMode="decimal" required />
                            </Field>
                            <Field label={t("stock.unitCost", locale)} htmlFor={`rc-${r.id}`}>
                              <Input id={`rc-${r.id}`} name="unit_cost" inputMode="decimal" />
                            </Field>
                          </DialogFields>
                          <DialogActions cancelLabel={cancelLabel}>
                            <SubmitButton variant="primary">{t("stock.receiveDo", locale)}</SubmitButton>
                          </DialogActions>
                        </form>
                      </DialogForm>

                      {/* Where it lives and when to reorder. Never the quantity. */}
                      <DialogForm
                        triggerLook="menuItem"
                        trigger={t("stock.editPlace", locale)}
                        title={partName(r)}
                        description={t("stock.editPlace", locale)}
                        closeLabel={closeLabel}
                        size="md"
                      >
                        <form action={updateStockItem}>
                          <input type="hidden" name="stock_item_id" value={r.id} />
                          <input type="hidden" name="unit" value={r.unit} />
                          <DialogFields>
                            <Field label={t("stock.bin", locale)} htmlFor={`bn-${r.id}`}>
                              <Input id={`bn-${r.id}`} name="bin" defaultValue={r.bin ?? ""} />
                            </Field>
                            <Field label={t("stock.reorderPoint", locale)} htmlFor={`rp-${r.id}`}>
                              <Input
                                id={`rp-${r.id}`}
                                name="reorder_point"
                                inputMode="decimal"
                                defaultValue={r.reorder_point ?? ""}
                              />
                            </Field>
                          </DialogFields>
                          <DialogActions cancelLabel={cancelLabel}>
                            <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                          </DialogActions>
                        </form>
                      </DialogForm>

                      <ConfirmDialog
                        action={untrackPart}
                        triggerLook="menuItem"
                        triggerLabel={t("stock.untrack", locale)}
                        triggerIcon={<TrashIcon />}
                        title={t("stock.untrackTitle", locale)}
                        intro={partName(r)}
                        consequences={[t("stock.untrackConsequence", locale)]}
                        confirmLabel={t("stock.untrack", locale)}
                        cancelLabel={cancelLabel}
                        closeLabel={closeLabel}
                      >
                        <input type="hidden" name="stock_item_id" value={r.id} />
                      </ConfirmDialog>
                    </ActionMenu>
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
