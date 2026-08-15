import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import { balanceAfter, type CashflowBucket } from "@/lib/cashflow";

/**
 * The forecast itself: five buckets, in and out, and a closing balance per bucket.
 *
 * The closing balance is the column people actually read — it is the one that turns four
 * amounts into a decision — so it is last, bold, and coloured the moment it goes under.
 * The bucket a reader first goes negative in is marked in words as well as in red,
 * because "the red one" is not a signal on a cracked phone in sunlight, which is the
 * screen this product is used on.
 *
 * On a phone the table scrolls sideways inside its own container rather than pushing the
 * page out; the same treatment `/money`'s ageing tables use.
 */
export function ForecastTable({
  rows,
  openingCents,
  locale,
}: {
  rows: readonly CashflowBucket[];
  /** null when the reader has not said what is in the account. */
  openingCents: number | null;
  locale: Lang;
}) {
  const closing = balanceAfter(rows, openingCents ?? 0);
  const firstNegative = openingCents == null ? -1 : closing.findIndex((c) => c < 0);

  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <caption className="sr-only">{t("cash.tableCaption", locale)}</caption>
        <thead>
          <tr className="border-b border-sand-200 text-left text-sand-500">
            <th scope="col" className="py-2 pr-3 font-medium">{t("cash.colWhen", locale)}</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">{t("cash.colIn", locale)}</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">{t("cash.colOut", locale)}</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">{t("cash.colNet", locale)}</th>
            <th scope="col" className="py-2 text-right font-medium">
              {openingCents == null ? t("cash.colChange", locale) : t("cash.colBalance", locale)}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const shown = openingCents == null ? r.running_cents : closing[i];
            const under = openingCents != null && shown < 0;
            return (
              <tr key={r.bucket} className="border-b border-sand-100 last:border-0">
                <th scope="row" className="py-2.5 pr-3 text-left font-medium text-sand-900">
                  {t(`cash.bucket.${r.bucket}`, locale)}
                  <span className="block text-xs font-normal text-sand-500">
                    <BucketWindow row={r} locale={locale} />
                  </span>
                  {i === firstNegative ? (
                    <span className="mt-1 block text-xs font-medium text-status-overdue">
                      {t("cash.runsOutHere", locale)}
                    </span>
                  ) : null}
                </th>
                <td className="py-2.5 pr-3 text-right tabular-nums text-sand-700">
                  {r.in_cents ? rands(r.in_cents) : "—"}
                </td>
                <td className="py-2.5 pr-3 text-right tabular-nums text-sand-700">
                  {r.out_cents ? `−${rands(r.out_cents)}` : "—"}
                </td>
                <td
                  className={`py-2.5 pr-3 text-right tabular-nums ${
                    r.net_cents < 0 ? "text-status-warn" : "text-sand-700"
                  }`}
                >
                  {rands(r.net_cents)}
                </td>
                <td
                  className={`py-2.5 text-right font-semibold tabular-nums ${
                    under ? "text-status-overdue" : "text-sand-900"
                  }`}
                >
                  {rands(shown)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The dates a bucket actually covers, in words.
 *
 * `overdue` has no start and `later` has no end, so neither gets a range. Near the end of
 * a month "this month" can close BEFORE it opens — next week has already swallowed what
 * was left of it — which is correct and means the window is empty; saying so is better
 * than printing a range that reads backwards.
 */
function BucketWindow({ row, locale }: { row: CashflowBucket; locale: Lang }) {
  if (row.bucket === "overdue") return <>{t("cash.windowNow", locale)}</>;
  if (row.bucket === "later") {
    return row.from_date ? (
      <>{t("cash.windowFrom", locale).replace("{date}", shortDate(row.from_date, locale))}</>
    ) : null;
  }
  if (!row.from_date || !row.to_date) return null;
  if (row.from_date > row.to_date) return <>{t("cash.windowEmpty", locale)}</>;
  return (
    <>
      {shortDate(row.from_date, locale)} – {shortDate(row.to_date, locale)}
    </>
  );
}
