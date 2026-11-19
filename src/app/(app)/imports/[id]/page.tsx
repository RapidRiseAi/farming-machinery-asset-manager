import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentFarmId, effectiveFarmRole, homePathFor, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { readAll } from "@/lib/supabase/read-all";
import { must } from "@/lib/supabase/must";
import { errorMessage } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { t, type Lang } from "@/lib/i18n";
import { issueField, sortIssues } from "@/lib/import-staging";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { Fact, FactList } from "@/components/ui/facts";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { Disclosure } from "@/components/ui/disclosure";
import { Pager } from "@/components/ui/pager";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { BatchStatus, type BatchStatusValue } from "../batch-status";
import { bulkDecideImport, cancelImport, confirmImport, decideImportRow } from "../actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type Batch = { id: string; source: "sheet" | "document"; file_name: string | null; status: BatchStatusValue; written: number | null; skipped: number | null; pages: number | null };
type Row = {
  id: string;
  row_no: number;
  page: number | null;
  raw: { asset?: string; date?: string; reading?: string; unit?: string; source_text?: string };
  machine_id: string | null;
  reading_date: string | null;
  reading: number | null;
  issues: string[];
  decision: "pending" | "accept" | "skip";
  confirmed_values: boolean;
  written_reading: string | null;
};
type Machine = { id: string; name: string; meter_type: string | null };

function RowDecision({ row, locale }: { row: Row; locale: Lang }) {
  if (row.written_reading) return <StatusBadge tone="ok" shape="check" label={t("imports.decision.written", locale)} />;
  if (row.decision === "accept") {
    return <StatusBadge tone="ok" shape="check" label={t(row.confirmed_values ? "imports.decision.checked" : "imports.decision.accepted", locale)} />;
  }
  if (row.decision === "skip") return <StatusBadge tone="neutral" shape="dash" label={t("imports.decision.skipped", locale)} />;
  return <StatusBadge tone={row.issues.length ? "warning" : "neutral"} shape={row.issues.length ? "triangle" : "ring"} label={t("imports.decision.waiting", locale)} />;
}

/** The hidden fields every decision form carries. */
function RowIds({ batch, row }: { batch: string; row: string }) {
  return (
    <>
      <input type="hidden" name="batch_id" value={batch} />
      <input type="hidden" name="row_id" value={row} />
    </>
  );
}

/**
 * One import's review (task B5). Each row shows what was read, what would be written and every
 * problem the database named. A row with a problem is accepted only through "Check and accept",
 * where each doubtful value starts EMPTY and must be typed or chosen: nothing uncertain is written
 * because a button was pressed.
 */
export default async function ImportReviewPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; page?: string; show?: string; reused?: string; bulk?: string; n?: string; written?: string; skipped?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();
  const farmId = await currentFarmId(profile);
  if (!farmId) redirect(`${homePathFor(profile.role)}?denied=1`);
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !["owner", "manager", "rr_admin"].includes(role)) redirect(`${homePathFor(profile.role)}?denied=1`);

  const supabase = await createClient();
  // A failed read is an error screen, never "not found".
  const batchData = must(await supabase.from("import_batches")
    .select("id,source,file_name,status,written,skipped,pages").eq("id", id).eq("farm_id", farmId).maybeSingle(), "imports:batch");
  if (!batchData) notFound();
  const batch = batchData as Batch;
  const open = batch.status === "review";

  // Every row's decision and issues (small) for the counts; the full rows one page at a time.
  const all = await readAll<{ decision: Row["decision"]; issues: string[] }>(() =>
    supabase.from("import_rows").select("id,decision,issues").eq("batch_id", id));
  const light = all.data ?? [];
  const waiting = light.filter((r) => r.decision === "pending").length;
  const waitingClean = light.filter((r) => r.decision === "pending" && r.issues.length === 0).length;
  const accepted = light.filter((r) => r.decision === "accept").length;
  const skipped = light.filter((r) => r.decision === "skip").length;

  const showWaiting = sp.show === "waiting";
  const page = Math.max(0, Number.parseInt(sp.page ?? "0", 10) || 0);
  let q = supabase.from("import_rows")
    .select("id,row_no,page,raw,machine_id,reading_date,reading,issues,decision,confirmed_values,written_reading")
    .eq("batch_id", id);
  if (showWaiting) q = q.eq("decision", "pending");
  const { data: rowData, error: rowError } = await q.order("row_no").range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const fetched = (rowData ?? []) as Row[];
  const hasMore = fetched.length > PAGE_SIZE;
  const rows = fetched.slice(0, PAGE_SIZE);

  const { data: machineData, error: machineError } = await supabase.from("machines")
    .select("id,name,meter_type").eq("farm_id", farmId).is("deleted_at", null).order("name");
  const machines = (machineData ?? []) as Machine[];
  const machineName = new Map(machines.map((m) => [m.id, m.name]));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date());

  const loadFailed = !!(all.error || rowError || machineError);
  const href = (p: number) => `/imports/${id}?${showWaiting ? "show=waiting&" : ""}page=${p}`;
  const fmt = (n: number) => new Intl.NumberFormat(locale === "af" ? "af-ZA" : "en-ZA", { maximumFractionDigits: 1 }).format(n);
  const success = sp.written !== undefined
    ? t("imports.done", locale).replace("{written}", sp.written).replace("{skipped}", sp.skipped ?? "0")
    : sp.bulk === "accept_clean" ? t("imports.bulkAccepted", locale).replace("{n}", sp.n ?? "0")
    : sp.bulk === "skip_pending" ? t("imports.bulkSkipped", locale).replace("{n}", sp.n ?? "0")
    : sp.reused ? t("imports.reused", locale) : undefined;

  return (
    <PageContainer size="narrow">
      <PageHeader
        title={batch.file_name ?? t(`imports.source.${batch.source}`, locale)}
        lead={open ? t("imports.reviewLead", locale) : undefined}
        locale={locale}
        back={{ href: "/imports", label: t("imports.title", locale) }}
      />
      <Flash tone="error" message={loadFailed ? errorMessage("load_failed", locale) : errorMessage(sp.error, locale)} />
      <Flash tone="success" message={success} />

      <Card>
        <div className="mb-2 flex items-center justify-between gap-3">
          <CardTitle>{t("imports.summary", locale)}</CardTitle>
          <BatchStatus status={batch.status} locale={locale} />
        </div>
        <FactList>
          <Fact label={t("imports.rows", locale)} value={fmt(light.length)} />
          {batch.pages ? <Fact label={t("imports.pages", locale)} value={fmt(batch.pages)} /> : null}
          {open ? <Fact label={t("imports.waiting", locale)} value={fmt(waiting)} /> : null}
          <Fact label={t(open ? "imports.accepted" : "imports.written", locale)} value={fmt(open ? accepted : batch.written ?? 0)} />
          <Fact label={t("imports.skipped", locale)} value={fmt(open ? skipped : batch.skipped ?? 0)} />
        </FactList>
        {open ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {waitingClean > 0 ? (
              <form action={bulkDecideImport}>
                <input type="hidden" name="batch_id" value={id} />
                <input type="hidden" name="bulk" value="accept_clean" />
                <SubmitButton variant="secondary" size="sm">{t("imports.acceptClean", locale).replace("{n}", fmt(waitingClean))}</SubmitButton>
              </form>
            ) : null}
            {waiting > 0 ? (
              <ConfirmDialog action={bulkDecideImport} triggerLabel={t("imports.skipRest", locale).replace("{n}", fmt(waiting))} triggerVariant="secondary" triggerSize="sm"
                title={t("imports.skipRestTitle", locale)} intro={t("imports.skipRestIntro", locale)}
                confirmLabel={t("imports.skipRestConfirm", locale)} cancelLabel={t("common.cancel", locale)} closeLabel={t("ui.close", locale)}>
                <input type="hidden" name="batch_id" value={id} />
                <input type="hidden" name="bulk" value="skip_pending" />
              </ConfirmDialog>
            ) : null}
            {waiting === 0 ? (
              <ConfirmDialog action={confirmImport} triggerLabel={t("imports.write", locale)} triggerSize="sm"
                title={t("imports.writeTitle", locale)} intro={t("imports.writeIntro", locale).replace("{n}", fmt(accepted))}
                confirmLabel={t("imports.write", locale)} cancelLabel={t("common.cancel", locale)} closeLabel={t("ui.close", locale)}>
                <input type="hidden" name="batch_id" value={id} />
                <RequestIdInput action="imports:confirm" />
              </ConfirmDialog>
            ) : (
              <p className="basis-full text-sm text-sand-600">{t("imports.decideFirst", locale).replace("{n}", fmt(waiting))}</p>
            )}
            <ConfirmDialog action={cancelImport} triggerLabel={t("imports.cancel", locale)} triggerVariant="ghost" triggerSize="sm"
              title={t("imports.cancelTitle", locale)} intro={t("imports.cancelIntro", locale)}
              confirmLabel={t("imports.cancel", locale)} cancelLabel={t("common.back", locale)} closeLabel={t("ui.close", locale)}>
              <input type="hidden" name="batch_id" value={id} />
            </ConfirmDialog>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader action={open ? (
          <Link href={showWaiting ? `/imports/${id}` : `/imports/${id}?show=waiting`} className="text-sm font-medium text-brand-700 underline">
            {t(showWaiting ? "imports.showAll" : "imports.showWaiting", locale)}
          </Link>
        ) : undefined}>
          <CardTitle>{t("imports.rowsTitle", locale)}</CardTitle>
        </CardHeader>
        {rows.length === 0 ? <p className="text-sm text-sand-600">{t("imports.noRows", locale)}</p> : null}
        <ul className="divide-y divide-sand-200">
          {rows.map((r) => {
            const issues = sortIssues(r.issues);
            const doubt = new Set(issues.map(issueField).filter(Boolean));
            const asRead = [r.raw.asset || t("imports.blank", locale), r.raw.date || t("imports.blank", locale),
              `${r.raw.reading || t("imports.blank", locale)}${r.raw.unit ? ` ${r.raw.unit}` : ""}`].join(" · ");
            const toWrite = r.machine_id && r.reading_date && r.reading !== null
              ? `${machineName.get(r.machine_id) ?? t("imports.unknownAsset", locale)} · ${r.reading_date} · ${fmt(r.reading)}`
              : t("imports.notYet", locale);
            return (
              <li key={r.id} id={`row-${r.id}`} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-sand-900">
                    {t("imports.row", locale).replace("{n}", String(r.row_no))}
                    {r.page ? ` · ${t("imports.page", locale).replace("{n}", String(r.page))}` : ""}
                  </span>
                  <RowDecision row={r} locale={locale} />
                </div>
                <FactList>
                  <Fact label={t("imports.asRead", locale)} value={<span className="break-words">{asRead}</span>} />
                  <Fact label={t("imports.toWrite", locale)} value={toWrite} muted={toWrite === t("imports.notYet", locale)} />
                </FactList>
                {batch.source === "document" && r.raw.source_text ? (
                  <Disclosure variant="inline" summary={t("imports.sourceText", locale)}>
                    <p className="whitespace-pre-wrap break-words text-sm text-sand-700">{r.raw.source_text}</p>
                  </Disclosure>
                ) : null}
                {issues.length ? (
                  <ul className="flex flex-wrap gap-1.5" aria-label={t("imports.problems", locale)}>
                    {issues.map((i) => <li key={i}><Badge tone="warning" wrap>{t(`imports.issue.${i}`, locale)}</Badge></li>)}
                  </ul>
                ) : null}
                {open ? (
                  <div className="flex flex-wrap gap-2">
                    {r.decision !== "pending" ? (
                      <form action={decideImportRow}>
                        <RowIds batch={id} row={r.id} />
                        <input type="hidden" name="decision" value="pending" />
                        <SubmitButton variant="ghost" size="sm">{t("imports.undo", locale)}</SubmitButton>
                      </form>
                    ) : (
                      <>
                        {issues.length === 0 ? (
                          <form action={decideImportRow}>
                            <RowIds batch={id} row={r.id} />
                            <input type="hidden" name="decision" value="accept" />
                            <SubmitButton size="sm">{t("imports.accept", locale)}</SubmitButton>
                          </form>
                        ) : (
                          <DialogForm trigger={t("imports.check", locale)} triggerSize="sm" title={t("imports.row", locale).replace("{n}", String(r.row_no))}
                            description={t("imports.checkLead", locale)} closeLabel={t("ui.close", locale)} size="md">
                            <form action={decideImportRow}>
                              <RowIds batch={id} row={r.id} />
                              <input type="hidden" name="decision" value="accept" />
                              <DialogFields columns={1}>
                                <SelectField name="machine_id" label={t("imports.asset", locale)} required
                                  defaultValue={doubt.has("machine") ? "" : r.machine_id ?? ""}
                                  hint={t("imports.asReadValue", locale).replace("{value}", r.raw.asset || t("imports.blank", locale))}>
                                  <option value="">{t("imports.choose", locale)}</option>
                                  {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                                </SelectField>
                                <TextField name="reading_date" type="date" label={t("imports.date", locale)} required max={today}
                                  defaultValue={doubt.has("date") ? "" : r.reading_date ?? ""}
                                  hint={t("imports.asReadValue", locale).replace("{value}", r.raw.date || t("imports.blank", locale))} />
                                <TextField name="reading" inputMode="decimal" label={t("imports.reading", locale)} required
                                  defaultValue={doubt.has("reading") || r.reading === null ? "" : String(r.reading)}
                                  hint={t("imports.asReadValue", locale).replace("{value}", `${r.raw.reading || t("imports.blank", locale)}${r.raw.unit ? ` ${r.raw.unit}` : ""}`)} />
                              </DialogFields>
                              <DialogActions cancelLabel={t("common.cancel", locale)}>
                                <SubmitButton>{t("imports.accept", locale)}</SubmitButton>
                              </DialogActions>
                            </form>
                          </DialogForm>
                        )}
                        <form action={decideImportRow}>
                          <RowIds batch={id} row={r.id} />
                          <input type="hidden" name="decision" value="skip" />
                          <SubmitButton variant="secondary" size="sm">{t("imports.skip", locale)}</SubmitButton>
                        </form>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        <Pager page={page} hasOlder={hasMore} href={href} label={t("ui.pages", locale)}
          newerLabel={t("ui.pageNewer", locale)} olderLabel={t("ui.pageOlder", locale)} />
      </Card>
    </PageContainer>
  );
}
