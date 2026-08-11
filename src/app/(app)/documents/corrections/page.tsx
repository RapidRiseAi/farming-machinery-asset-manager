import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { dateTime } from "@/lib/format";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Stat } from "@/components/ui/stat";
import { AllClear } from "@/components/ui/empty-state";
import { PageInfoButton } from "@/components/ui/page-info-button";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  document_id: string;
  version: number;
  reason: string;
  total_cents_before: number;
  total_cents_after: number | null;
  edited_at: string;
  edited_by: string | null;
};

/**
 * Every correction ever made, across every document — its own section, as asked for.
 *
 * The per-document history answers "what happened to THIS invoice". This answers the
 * other question, the one an owner asks when they are not looking at anything in
 * particular: has anyone been quietly changing numbers? So it is ordered by when, not by
 * document, and it leads with the movement rather than the reason — a run of corrections
 * that all reduce a total is a pattern you want to see at a glance.
 *
 * It reads `partner_document_revisions`, which is append-only (0420): UPDATE and DELETE
 * are refused by trigger as well as by RLS, so what is on this page cannot be tidied up
 * afterwards by the person who did it.
 *
 * Visible to the partner for their own documents, and to a farm for documents raised
 * against them — the same rule the documents themselves follow, because a customer being
 * able to see how their invoice changed is the point.
 */
export default async function CorrectionsPage() {
  const profile = await requireProfile();
  if (profile.role === "operator") redirect("/driver?denied=1");
  const locale = profile.lang;

  const supabase = await createClient();
  const { data } = await supabase
    .from("partner_document_revisions")
    .select("id, document_id, version, reason, total_cents_before, total_cents_after, edited_at, edited_by")
    .order("edited_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as Row[];

  // Name the documents and the people. Two lookups, only when there is anything to show.
  const docIds = [...new Set(rows.map((r) => r.document_id))];
  const editorIds = [...new Set(rows.map((r) => r.edited_by).filter((v): v is string => !!v))];
  const [{ data: docs }, { data: editors }] = await Promise.all([
    docIds.length
      ? supabase.from("partner_documents").select("id, number, kind, bill_to_name").in("id", docIds)
      : Promise.resolve({ data: [] }),
    editorIds.length
      ? supabase.from("users").select("id, name").in("id", editorIds)
      : Promise.resolve({ data: [] }),
  ]);
  const docById = new Map(
    ((docs ?? []) as { id: string; number: string; kind: string; bill_to_name: string | null }[])
      .map((d) => [d.id, d]),
  );
  const nameById = new Map(((editors ?? []) as { id: string; name: string }[]).map((u) => [u.id, u.name]));

  const reduced = rows.filter((r) => r.total_cents_after != null && r.total_cents_after < r.total_cents_before);
  const raised = rows.filter((r) => r.total_cents_after != null && r.total_cents_after > r.total_cents_before);

  return (
    <div className="flex flex-col gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("corrections.title", locale)}</h1>
          <PageInfoButton infoKey="corrections" locale={locale} />
        </div>
        <p className="mt-0.5 text-sm text-sand-500">{t("corrections.tagline", locale)}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label={t("corrections.total", locale)} value={rows.length} />
        <Stat label={t("corrections.reduced", locale)} value={reduced.length} tone={reduced.length > 0 ? "due" : "default"} />
        <Stat label={t("corrections.raised", locale)} value={raised.length} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("corrections.everyChange", locale)}</CardTitle>
        </CardHeader>

        {rows.length === 0 ? (
          <AllClear title={t("corrections.emptyTitle", locale)} hint={t("corrections.emptyBody", locale)} />
        ) : (
          <ol className="flex flex-col gap-2">
            {rows.map((r) => {
              const doc = docById.get(r.document_id);
              const before = r.total_cents_before;
              const after = r.total_cents_after;
              const moved = after != null && after !== before;
              const down = after != null && after < before;

              return (
                <li key={r.id} className="rounded-lg border border-sand-200 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {doc ? (
                        <Link
                          href={`/documents/${r.document_id}`}
                          className="focus-ring rounded font-medium text-brand-700 underline-offset-2 hover:underline"
                        >
                          {doc.number}
                        </Link>
                      ) : (
                        <span className="font-medium text-sand-700">{t("corrections.unknownDoc", locale)}</span>
                      )}
                      <Badge tone="neutral">{t("revise.versionN", locale).replace("{n}", String(r.version))}</Badge>
                      {doc?.bill_to_name ? <span className="text-sm text-sand-600">{doc.bill_to_name}</span> : null}
                    </div>
                    <p className="text-sm text-sand-500">
                      {dateTime(r.edited_at, locale)}
                      {r.edited_by && nameById.get(r.edited_by) ? ` · ${nameById.get(r.edited_by)}` : ""}
                    </p>
                  </div>

                  <p className="mt-1 text-sand-800">{r.reason}</p>

                  {moved ? (
                    <p className="mt-1 text-sm tabular-nums">
                      <span className="text-sand-500 line-through">{rands(before)}</span>
                      {" → "}
                      <span className={`font-semibold ${down ? "text-status-due" : "text-sand-900"}`}>
                        {rands(after)}
                      </span>
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-sand-500">
                      {t("revise.sameTotal", locale).replace("{amount}", rands(before))}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </div>
  );
}
