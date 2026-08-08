import { t, type Lang } from "@/lib/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { rands } from "@/lib/money";
import { dateTime } from "@/lib/format";

export type Revision = {
  id: string;
  version: number;
  reason: string;
  total_cents_before: number;
  total_cents_after: number | null;
  edited_at: string;
  editor_name: string | null;
  snapshot: { document?: Record<string, unknown>; lines?: Record<string, unknown>[] } | null;
};

/**
 * Every version this document has had.
 *
 * The point of allowing an issued document to be edited is that the edit is never
 * invisible, so this panel is not an extra — it is the other half of the feature, and it
 * shows to the CUSTOMER as well as to the partner. Somebody who was sent an invoice for
 * R4 105 and later sees R3 800 can read here what changed, when, who did it and why.
 *
 * Each row names the money movement rather than making the reader diff two numbers, and
 * the old line items are there underneath for the case where the total is the same but
 * the description was wrong.
 */
export function RevisionHistory({ revisions, locale }: { revisions: Revision[]; locale: Lang }) {
  if (revisions.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("revise.historyTitle", locale)}</CardTitle>
      </CardHeader>
      <p className="mb-3 text-sm text-sand-600">{t("revise.historyIntro", locale)}</p>

      <ol className="flex flex-col gap-3">
        {[...revisions].sort((a, b) => b.version - a.version).map((r) => {
          const before = r.total_cents_before;
          const after = r.total_cents_after;
          const moved = after != null && after !== before;
          const lines = (r.snapshot?.lines ?? []) as Record<string, unknown>[];

          return (
            <li key={r.id} className="rounded-lg border border-sand-200 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="font-medium text-sand-900">
                  {t("revise.versionN", locale).replace("{n}", String(r.version))}
                </p>
                <p className="text-sm text-sand-500">
                  {dateTime(r.edited_at, locale)}
                  {r.editor_name ? ` · ${r.editor_name}` : ""}
                </p>
              </div>

              <p className="mt-1 text-sand-800">{r.reason}</p>

              {moved ? (
                <p className="mt-1.5 text-sm tabular-nums text-sand-700">
                  <span className="line-through text-sand-500">{rands(before)}</span>
                  {" → "}
                  <span className="font-semibold text-sand-900">{rands(after)}</span>
                </p>
              ) : (
                <p className="mt-1.5 text-sm text-sand-500">
                  {t("revise.sameTotal", locale).replace("{amount}", rands(before))}
                </p>
              )}

              {lines.length > 0 ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm font-medium text-sand-700">
                    {t("revise.whatItSaid", locale)}
                  </summary>
                  <ul className="mt-1.5 flex flex-col gap-1 text-sm text-sand-600">
                    {lines.map((l, i) => (
                      <li key={i} className="flex items-baseline justify-between gap-3">
                        <span>
                          {String(l.description ?? "")}
                          {l.part_no ? ` (${String(l.part_no)})` : ""}
                          {" × "}
                          {String(l.qty ?? "")}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {rands(Number(l.line_total_cents ?? 0))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
