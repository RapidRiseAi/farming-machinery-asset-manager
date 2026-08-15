import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { movementsByBucket, CASH_BUCKETS, type CashflowMovement } from "@/lib/cashflow";

/**
 * What is behind each bucket, one row per expected movement.
 *
 * A total nobody can take apart is a total nobody believes — the same reason 0460 split
 * the expense breakdown out of the P&L. Here it matters more than usual, because the
 * reader's next action is almost always about ONE of these lines: phone the farmer who is
 * 40 days late, or ring the supplier and ask for another two weeks.
 *
 * Every amount is GROSS, because that is what moves through the bank; the screen says so
 * once, at the top, rather than on every row.
 */
export function MovementList({
  items,
  locale,
}: {
  items: readonly CashflowMovement[];
  locale: Lang;
}) {
  const grouped = movementsByBucket(items);

  return (
    <div className="flex flex-col gap-5">
      {CASH_BUCKETS.map((key) => {
        const rows = grouped.get(key) ?? [];
        if (rows.length === 0) return null;
        return (
          <section key={key} aria-labelledby={`cash-group-${key}`}>
            <h3
              id={`cash-group-${key}`}
              className="mb-2 text-sm font-semibold text-sand-700"
            >
              {t(`cash.bucket.${key}`, locale)}
            </h3>
            <ul className="flex flex-col gap-2">
              {rows.map((m) => (
                <li
                  key={`${m.source}-${m.source_id}`}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-sand-200 bg-white px-3 py-2.5"
                >
                  <span className="min-w-0 font-medium text-sand-900">{m.party}</span>
                  <Badge tone={m.direction === "in" ? "ok" : "neutral"}>
                    {t(`cash.source.${m.source}`, locale)}
                  </Badge>
                  {m.days_late > 0 ? (
                    <Badge tone="danger">
                      {t("cash.daysLate", locale).replace("{days}", String(m.days_late))}
                    </Badge>
                  ) : null}
                  <span
                    className={`ml-auto whitespace-nowrap font-semibold tabular-nums ${
                      m.direction === "in" ? "text-sand-900" : "text-status-warn"
                    }`}
                  >
                    {m.direction === "in" ? rands(m.amount_cents) : `−${rands(m.amount_cents)}`}
                  </span>
                  <span className="w-full text-xs text-sand-500">
                    {m.ref}
                    {" · "}
                    {m.days_late > 0
                      ? t("cash.wasDue", locale).replace("{date}", shortDate(m.expected_date, locale))
                      : t("cash.expectedOn", locale).replace("{date}", shortDate(m.expected_date, locale))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
