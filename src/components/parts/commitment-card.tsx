import { t, type Lang } from "@/lib/i18n";
import { num } from "@/lib/format";
import { qtyLabel } from "@/lib/stock";
import {
  bySeverity,
  committedRows,
  readSources,
  shortfallCount,
  sourcesByMachine,
  MIN_LOOKAHEAD_DAYS,
  MAX_LOOKAHEAD_DAYS,
  type ShortfallRow,
} from "@/lib/reorder";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { AllClear } from "@/components/ui/empty-state";
import { setReorderWindow } from "@/app/(app)/parts/stock-actions";

/**
 * What the schedule has already spoken for.
 *
 * A server component: every figure comes from `public.stock_shortfall`, and there is
 * nothing here for a browser to recompute. It leads with the shortfall COUNT because that
 * is the only number that changes what somebody does today, and it states the window in
 * words on the line beneath — "services due in the next 30 days" — because a total with an
 * invisible time-box behind it is a number nobody can check.
 *
 * Each row shows its working: the machines and kits behind the quantity. That is not
 * decoration. A machine with several kits counts all of them (0503: nothing in the schema
 * says which service a kit belongs to), so the total is deliberately generous, and a
 * generous total that cannot be inspected is one people learn to discount.
 */
export function CommitmentCard({
  locale,
  rows,
  days,
  canSetWindow,
}: {
  locale: Lang;
  rows: ShortfallRow[];
  days: number;
  canSetWindow: boolean;
}) {
  const committed = committedRows(rows).sort(bySeverity);
  const short = shortfallCount(rows);
  const windowWords = t("reorder.window", locale).replace("{days}", num(days, 0));

  return (
    <Card id="next">
      <CardHeader>
        <CardTitle>{t("reorder.title", locale)}</CardTitle>
      </CardHeader>

      <p className="text-sm text-sand-600">{windowWords}</p>

      {committed.length === 0 ? (
        <AllClear
          className="mt-3"
          title={t("reorder.nothingDueTitle", locale)}
          hint={t("reorder.nothingDueBody", locale)}
        />
      ) : (
        <>
          {short > 0 ? (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
              {t("reorder.shortCount", locale).replace("{count}", num(short, 0))}
            </p>
          ) : (
            <p className="mt-3 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-900">
              {t("reorder.allCovered", locale)}
            </p>
          )}

          <ul className="mt-3 flex flex-col divide-y divide-sand-100">
            {committed.map((r) => {
              const machines = sourcesByMachine(readSources(r.sources));
              return (
                <li key={r.stock_item_id} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-sm font-medium text-sand-900">
                      {r.part_no ?? "—"}
                    </span>
                    {r.description ? (
                      <span className="text-sm text-sand-600">{r.description}</span>
                    ) : null}
                    <span className="ml-auto">
                      {r.is_short ? (
                        <StatusBadge
                          label={t("reorder.shortBy", locale).replace(
                            "{qty}",
                            qtyLabel(r.short_qty, r.unit),
                          )}
                          tone="danger"
                          shape="square"
                          size="md"
                        />
                      ) : (
                        <StatusBadge
                          label={t("reorder.covered", locale)}
                          tone="ok"
                          shape="check"
                          size="md"
                        />
                      )}
                    </span>
                  </div>

                  {/* On hand, committed, and what is left — the three numbers the whole
                      card exists to put side by side. */}
                  <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    <div className="flex gap-1.5">
                      <dt className="text-sand-500">{t("reorder.onHand", locale)}</dt>
                      <dd className="font-medium tabular-nums text-sand-900">
                        {qtyLabel(r.on_hand, r.unit)}
                      </dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-sand-500">{t("reorder.committed", locale)}</dt>
                      <dd className="font-medium tabular-nums text-sand-900">
                        {qtyLabel(r.committed_qty, r.unit)}
                      </dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-sand-500">{t("reorder.leftOver", locale)}</dt>
                      <dd
                        className={
                          r.is_short
                            ? "font-semibold tabular-nums text-status-overdue"
                            : "font-medium tabular-nums text-sand-900"
                        }
                      >
                        {qtyLabel(r.projected_qty, r.unit)}
                      </dd>
                    </div>
                  </dl>

                  {machines.length > 0 ? (
                    <p className="mt-1 text-xs text-sand-500">
                      {t("reorder.forMachines", locale)}{" "}
                      {machines.map((m, i) => (
                        <span key={m.machine_id}>
                          {i > 0 ? " · " : ""}
                          <span className="text-sand-700">{m.machine ?? "—"}</span>
                          {m.kits.length > 0 ? ` (${m.kits.join(", ")})` : ""}
                          {" "}
                          {qtyLabel(m.qty, r.unit)}
                        </span>
                      ))}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <p className="mt-3 text-xs text-sand-500">{t("reorder.severalKitsNote", locale)}</p>
        </>
      )}

      {canSetWindow ? (
        <form action={setReorderWindow} className="mt-4 flex flex-wrap items-end gap-2 border-t border-sand-100 pt-4">
          <Field
            label={t("reorder.windowLabel", locale)}
            htmlFor="reorder_days"
            hint={t("reorder.windowHint", locale)}
          >
            <Input
              id="reorder_days"
              name="reorder_lookahead_days"
              type="number"
              inputMode="numeric"
              min={MIN_LOOKAHEAD_DAYS}
              max={MAX_LOOKAHEAD_DAYS}
              defaultValue={days}
              className="w-28"
            />
          </Field>
          <SubmitButton variant="secondary" size="sm">
            {t("reorder.windowSave", locale)}
          </SubmitButton>
        </form>
      ) : null}
    </Card>
  );
}
