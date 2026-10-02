import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile, effectiveFarmRole } from "@/lib/auth";
import { canViewFarmCosts } from "@/lib/cost-visibility";
import { createClient } from "@/lib/supabase/server";
import { canEditJobWork, canReviewJob, canReturnJob, needsJobMeter } from "@/lib/jobcard-workflow";
import { rands } from "@/lib/money";
import { meterReading, shortDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { errorMessage } from "@/lib/errors";
import { Photo } from "@/components/ui/photo";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { ChevronLeftIcon, TrashIcon, LockIcon, SquareIcon, CheckIcon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { JobStatus } from "@/components/ui/status";
import { SubmitButton } from "@/components/ui/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { DialogActions, DialogForm } from "@/components/ui/dialog-form";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/ui/field";
import { Disclosure } from "@/components/ui/disclosure";
import { WarrantyPanel } from "@/components/jobcards/warranty-panel";
import { JobCardMedia } from "@/components/jobcard-media";
import { removeLine, toggleServiceLine, assignJobWorker } from "../actions";
import { LineEntry, type CataloguePart } from "../line-entry";
import { JobCardEditor, type JobDraft } from "../job-card-editor";
import { LifecycleActions } from "../lifecycle-actions";
import { ServiceKitForm } from "../service-kit-form";
import { IntakeAcknowledgement } from "@/components/jobcards/intake-acknowledgement";

type JobCard = {
  id: string; farm_id: string; machine_id: string; type: string; status: string;
  work_mode: string; workshop_id: string | null; external_provider_name: string | null; updated_at: string;
  review_note: string | null; completion_effects_recorded: boolean;
  mechanic_user_id: string | null;
  date_in: string | null; date_out: string | null; meter_reading: number | null;
  reported_problem: string | null; diagnosis: string | null; work_performed: string | null; recommendations: string | null;
  parts_total_cents: number; labour_total_cents: number; other_total_cents: number; total_cents: number;
  vat_rate_bps: number; locked: boolean; approved_at: string | null;
};
type Line = {
  id: string; updated_at: string; kind: string; description: string | null; part_no: string | null;
  qty: number | null; unit_cost_cents: number | null; hours: number | null; rate_cents: number | null; total_cents: number;
};

export default async function JobCardDetail({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; line_token?: string }>;
}) {
  const profile = await requireProfile();
  const { id } = await params;
  const sp = await searchParams;
  const locale = profile.lang;
  const supabase = await createClient();
  const { data, error } = await supabase.from("job_cards_visible").select("*").eq("id", id).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  const jc = data as JobCard | null;
  if (!jc) notFound();
  const [costsVisible, farmRole] = await Promise.all([canViewFarmCosts(supabase, jc.farm_id), effectiveFarmRole(jc.farm_id, profile)]);
  const resourceRole = profile.role === "workshop" ? "workshop" : farmRole;
  const canWork = canEditJobWork(jc, resourceRole, profile.workshop_id);
  const canApprove = canReviewJob(resourceRole);
  const external = jc.work_mode === "external" || !!jc.workshop_id;
  const working = jc.status === "in_progress" || jc.status === "waiting_parts";
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);

  const [machineRes, lineRes, planRes, coverRes, attachRes, invoiceRes, catalogueRes, kitRes, workRes, providerRes, teamRes, membershipRes] = await Promise.all([
    supabase.from("machines").select("name, type, meter_type").eq("id", jc.machine_id).maybeSingle(),
    supabase.from("job_card_lines_visible").select("id, updated_at, kind, description, part_no, qty, unit_cost_cents, hours, rate_cents, total_cents").eq("job_card_id", id).is("deleted_at", null).order("created_at"),
    supabase.from("service_plan_lines").select("id, task, status").eq("machine_id", jc.machine_id).is("deleted_at", null),
    supabase.from("job_card_service_lines").select("service_plan_line_id").eq("job_card_id", id),
    supabase.from("attachments").select("id, kind, storage_path").eq("parent_type", "job_card").eq("parent_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    costsVisible ? supabase.from("cost_entries").select("id, amount_cents, note, occurred_on").eq("source_type", "job_card").eq("source_id", id).eq("type", "invoice").is("deleted_at", null).order("occurred_on", { ascending: false }) : Promise.resolve({ data: [], error: null }),
    supabase.from("parts_catalogue_visible").select("id, part_no, description, typical_cost_cents").or(`farm_id.is.null,farm_id.eq.${jc.farm_id}`).is("deleted_at", null).order("part_no"),
    supabase.from("service_kits").select("id, name, machine_id, machine_type, service_kit_items(id)").eq("farm_id", jc.farm_id).or(`machine_id.eq.${jc.machine_id},machine_id.is.null`).is("deleted_at", null).is("service_kit_items.deleted_at", null).order("created_at"),
    supabase.from("work_requests_visible").select("id, status, invoice_amount_cents").eq("job_card_id", id).is("deleted_at", null).limit(1).maybeSingle(),
    jc.workshop_id ? supabase.from("workshops").select("name").eq("id", jc.workshop_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    !external ? supabase.from("users").select("id,name,role,farm_id").eq("active", true).is("deleted_at", null).order("name") : Promise.resolve({ data: [], error: null }),
    !external ? supabase.from("user_farm_memberships").select("user_id,role").eq("farm_id", jc.farm_id).eq("active", true).is("deleted_at", null) : Promise.resolve({ data: [], error: null }),
  ]);
  const machine = machineRes.data as { name: string; type: string; meter_type: string } | null;
  const lines = (lineRes.data as Line[] | null) ?? [];
  const planLines = (planRes.data as { id: string; task: string; status: string }[] | null) ?? [];
  const covered = new Set(((coverRes.data as { service_plan_line_id: string }[] | null) ?? []).map((c) => c.service_plan_line_id));
  const catalogue = (catalogueRes.data as CataloguePart[] | null) ?? [];
  const kits = ((kitRes.data as { id: string; name: string; machine_id: string | null; machine_type: string | null; service_kit_items: { id: string }[] | null }[] | null) ?? [])
    .filter((k) => (k.machine_id === jc.machine_id || k.machine_type === machine?.type) && (k.service_kit_items ?? []).length > 0);
  const invoices = (invoiceRes.data as { id: string; amount_cents: number; note: string | null; occurred_on: string }[] | null) ?? [];
  const workRequest = workRes.data as { id: string; status: string; invoice_amount_cents: number | null } | null;
  const supplierTotal = workRequest?.invoice_amount_cents ?? (invoices.length ? invoices.reduce((sum, invoice) => sum + invoice.amount_cents, 0) : null);
  const canReturn = canReturnJob(jc, workRequest?.status ?? null, invoices.length > 0 || (attachRes.data ?? []).some((a) => a.kind === "invoice"));
  const provider = (providerRes.data as { name: string } | null)?.name ?? jc.external_provider_name;
  const attachments = await Promise.all(((attachRes.data as { id: string; kind: string; storage_path: string | null }[] | null) ?? [])
    .filter((a) => costsVisible || a.kind === "photo")
    .map(async (a) => {
      const signed = a.storage_path ? await supabase.storage.from("jobcard-photos").createSignedUrl(a.storage_path, 3600) : null;
      return { ...a, url: signed?.data?.signedUrl ?? null };
    }));
  const loadError = [lineRes, planRes, coverRes, attachRes, invoiceRes, catalogueRes, kitRes, workRes, providerRes, teamRes, membershipRes].find((result) => result.error)?.error;
  const membershipRoles = new Map((membershipRes.data ?? []).map((m) => [m.user_id, m.role]));
  const team = (teamRes.data ?? []).filter((person) => person.role !== "workshop" && ["owner", "manager", "mechanic"].includes(membershipRoles.get(person.id) ?? (person.farm_id === jc.farm_id ? person.role : "")));
  const assignee = (teamRes.data ?? []).find((person) => person.id === jc.mechanic_user_id)?.name;
  const initial: JobDraft = {
    date_in: jc.date_in ?? "", date_out: jc.date_out ?? "", meter_reading: jc.meter_reading != null ? String(jc.meter_reading) : "",
    reported_problem: jc.reported_problem ?? "", diagnosis: jc.diagnosis ?? "", work_performed: jc.work_performed ?? "", recommendations: jc.recommendations ?? "",
  };
  const editDialog = (section: "intake" | "work" | "handover") => (
    <DialogForm trigger={t(`jobcards.workflow.edit_${section}`, locale)} title={t(`jobcards.workflow.edit_${section}`, locale)} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel} size="md">
      <JobCardEditor id={id} actorId={profile.id} updatedAt={jc.updated_at} section={section} meterType={machine?.meter_type ?? "none"} locale={locale} initial={initial} />
    </DialogForm>
  );
  const lineDetail = (line: Line) => line.kind === "part"
    ? `${line.qty ?? 0}${costsVisible ? ` × ${rands(line.unit_cost_cents)}` : ""}`
    : line.kind === "labour" ? `${line.hours ?? 0}h${costsVisible ? ` × ${rands(line.rate_cents)}` : ""}` : costsVisible ? rands(line.unit_cost_cents) : "";
  const workflowHint = jc.locked ? "approvedHint" : jc.status === "completed" ? (canReturn ? "reviewHint" : jc.completion_effects_recorded ? "billedReview" : "historicalReview") : jc.status === "waiting_parts" ? "waitingHint" : jc.status === "in_progress" ? "workingHint" : "intakeHint";
  const assignedContractor = !!jc.workshop_id && profile.workshop_id === jc.workshop_id && profile.role === "workshop";
  const canInvoice = external && costsVisible && ["completed", "approved"].includes(jc.status) && (canApprove || assignedContractor);
  const canRecordAmount = canInvoice && !workRequest && (assignedContractor || !jc.workshop_id);
  const canMedia = canWork || canInvoice;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <IntakeAcknowledgement actorId={profile.id} />
      <Link href="/jobcards" className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-sm text-sand-500"><ChevronLeftIcon />{t("jobcards.back", locale)}</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-sand-500">{t("jobcards.workflow.jobCard", locale)} #{jc.id.slice(0, 8)}</p>
          <h1 className="text-2xl font-bold tracking-tight text-ink">{machine?.name ?? t("jobcards.title", locale)}</h1>
          <div className="mt-2 flex flex-wrap gap-2"><Badge tone="neutral">{t(`jobType.${jc.type}`, locale)}</Badge><Badge tone="neutral">{t(external ? "jobcards.workflow.external" : "jobcards.workflow.internal", locale)}</Badge><JobStatus value={jc.status} locale={locale} /></div>
          <Link href={`/machines/${jc.machine_id}`} className="focus-ring mt-2 inline-flex min-h-[44px] items-center rounded text-sm font-medium text-brand-ink hover:underline">{t("jobcards.openMachine", locale)} →</Link>
        </div>
        <a href={`/jobcards/${id}/pdf`} className={buttonVariants({ variant: "secondary" })}>{t("common.print", locale)}</a>
      </div>
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="error" message={loadError ? t("jobcards.workflow.loadError", locale) : undefined} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      <Card>
        <CardHeader><CardTitle>{t("jobcards.workflow.nextStep", locale)}</CardTitle></CardHeader>
        {provider ? <p className="mb-2 font-medium text-sand-900">{t("work.contractor", locale)}: {provider}</p> : null}
        <p className="mb-3 text-sm text-sand-600">{t(`jobcards.workflow.${workflowHint}`, locale)}</p>
        {jc.review_note && !["completed", "approved"].includes(jc.status) ? <div className="mb-3 rounded-lg border border-sand-200 bg-sand-50 p-3"><p className="text-sm font-semibold text-sand-900">{t("jobcards.workflow.correctionsRequested", locale)}</p><p className="mt-1 whitespace-pre-wrap text-sm text-sand-700">{jc.review_note}</p></div> : null}
        <p className="mb-3 text-sm text-sand-600">{t(external ? jc.workshop_id ? "jobcards.workflow.providerOwnsWork" : "jobcards.workflow.outsideOwnsInvoice" : "jobcards.workflow.noInvoice", locale)}</p>
        {workRequest ? <Link href={`/work/${workRequest.id}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>{t("jobcards.workflow.openRequest", locale)}</Link> : null}
        {jc.locked ? <p className="mt-2 text-sm text-brand-ink"><LockIcon /> {t("jobcards.lockedBanner", locale)} {jc.approved_at ? shortDate(jc.approved_at, locale) : ""}</p> : (
          <LifecycleActions id={id} status={jc.status} updatedAt={jc.updated_at} meterReading={jc.meter_reading} meterRequired={needsJobMeter(jc.type, machine?.meter_type ?? "none")} hasWorkPerformed={!!jc.work_performed?.trim()} needsServiceSelection={jc.type === "scheduled_service" && planLines.length > 0 && !planLines.some((line) => covered.has(line.id))} canWork={canWork} canApprove={canApprove} canReturn={canReturn} correctionHistoryAvailable={jc.completion_effects_recorded} locale={locale} />
        )}
      </Card>

      <Card>
        <CardHeader action={canWork ? editDialog("intake") : undefined}><CardTitle>{t("jobcards.workflow.intake", locale)}</CardTitle></CardHeader>
        <p className="text-sm text-sand-500">{t("jobcards.cameIn", locale)}: {jc.date_in ?? "-"}</p>
        <p className="mt-2 whitespace-pre-wrap text-sm text-sand-900">{jc.reported_problem || t("jobcards.workflow.noProblem", locale)}</p>
        {!external ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-sand-100 pt-3"><p className="text-sm text-sand-600">{t("jobcards.workflow.assignedWorker", locale)}: {assignee ?? t("jobcards.workflow.unassigned", locale)}</p>{canWork && canApprove ? <DialogForm trigger={t("jobcards.workflow.assignWorker", locale)} triggerVariant="secondary" triggerSize="sm" title={t("jobcards.workflow.assignWorker", locale)} closeLabel={closeLabel} size="md"><form action={assignJobWorker} className="flex flex-col gap-4"><input type="hidden" name="id" value={id} /><input type="hidden" name="updated_at" value={jc.updated_at} /><Field label={t("jobcards.workflow.assignedWorker", locale)} htmlFor="job-assignee"><Select id="job-assignee" name="mechanic_user_id" defaultValue={jc.mechanic_user_id ?? ""}><option value="">{t("jobcards.workflow.unassigned", locale)}</option>{team.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</Select></Field><DialogActions cancelLabel={cancelLabel}><SubmitButton variant="primary">{t("jobcards.saveNow", locale)}</SubmitButton></DialogActions></form></DialogForm> : null}</div> : null}
      </Card>

      <Card>
        <CardHeader action={canWork && working ? editDialog("work") : undefined}><CardTitle>{t("jobcards.workflow.workRecord", locale)}</CardTitle></CardHeader>
        <dl className="flex flex-col gap-3 text-sm">
          <div><dt className="text-sand-500">{t("jobcards.diagnosis", locale)}</dt><dd className="whitespace-pre-wrap text-sand-900">{jc.diagnosis || "-"}</dd></div>
          <div><dt className="text-sand-500">{t("jobcards.workPerformed", locale)}</dt><dd className="whitespace-pre-wrap text-sand-900">{jc.work_performed || "-"}</dd></div>
          {jc.recommendations ? <div><dt className="text-sand-500">{t("jobcards.recommendations", locale)}</dt><dd className="whitespace-pre-wrap text-sand-900">{jc.recommendations}</dd></div> : null}
        </dl>
        {!working && canWork ? <p className="mt-3 text-sm text-sand-500">{t("jobcards.workflow.startBeforeWork", locale)}</p> : null}
      </Card>

      <Card>
        <CardHeader action={canWork && working ? (
          <DialogForm trigger={t("jobcards.workflow.addLine", locale)} title={t("jobcards.workflow.addLine", locale)} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel} size="md">
            <LineEntry actorId={profile.id} jobCardId={id} farmId={jc.farm_id} vatRateBps={jc.vat_rate_bps} locale={locale} catalogue={catalogue} costsVisible={costsVisible} />
          </DialogForm>
        ) : undefined}><CardTitle>{t("jobcards.partsAndLabour", locale)}</CardTitle></CardHeader>
        {lines.length === 0 ? <p className="text-sm text-sand-500">{t("jobcards.noLines", locale)}</p> : (
          <ul className="divide-y divide-sand-100 text-sm">{lines.map((line) => (
            <li key={line.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0"><p className="font-medium text-sand-900">{line.description || line.part_no || t(`jobcards.${line.kind}Kind`, locale)}</p><p className="text-sand-500">{lineDetail(line)}</p></div>
              <div className="flex shrink-0 items-center gap-2">{costsVisible ? <span className="font-medium tabular-nums">{rands(line.total_cents)}</span> : null}
                {canWork && working ? <DialogForm trigger={t("common.edit", locale)} triggerVariant="ghost" triggerSize="sm" title={t("jobcards.workflow.editLine", locale)} closeLabel={closeLabel} size="md"><LineEntry actorId={profile.id} jobCardId={id} farmId={jc.farm_id} vatRateBps={jc.vat_rate_bps} locale={locale} catalogue={catalogue} costsVisible={costsVisible} line={line} /></DialogForm> : null}
                {canWork && working ? <ConfirmDialog action={removeLine} triggerVariant="ghost" triggerSize="sm" triggerIcon={<TrashIcon />} triggerLabel={t("jobcards.remove", locale)} title={t("confirm.removeLineTitle", locale).replace("{line}", line.description || line.part_no || "-")} confirmLabel={t("confirm.removeLineYes", locale)} cancelLabel={t("confirm.keepIt", locale)} closeLabel={closeLabel}><input type="hidden" name="line_id" value={line.id} /><input type="hidden" name="line_updated_at" value={line.updated_at} /><input type="hidden" name="job_card_id" value={id} /></ConfirmDialog> : null}
              </div>
            </li>
          ))}</ul>
        )}
        {canWork && working && costsVisible && kits.length > 0 ? <div className="mt-3"><DialogForm trigger={t("jobcards.applyKit", locale)} title={t("jobcards.applyKit", locale)} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel} size="md"><ServiceKitForm jobId={id} farmId={jc.farm_id} actorId={profile.id} kits={kits} locale={locale} /></DialogForm></div> : null}
        {costsVisible ? <div className="mt-4 border-t border-sand-100 pt-3"><p className="text-sm text-sand-600">{t(external ? "jobcards.thisJobSoFar" : "jobcards.workflow.internalCost", locale)}</p><p className="text-2xl font-bold tabular-nums text-sand-950">{rands(jc.total_cents)}</p><p className="mt-1 text-xs text-sand-500">{t("jobcards.exVatNote", locale)}</p></div> : null}
      </Card>

      {external && costsVisible && supplierTotal != null ? <Card><CardTitle>{t("jobcards.workflow.supplierTotal", locale)}</CardTitle><p className="mt-2 text-2xl font-bold tabular-nums">{rands(supplierTotal)}</p><p className="mt-1 text-sm text-sand-600">{t("jobcards.workflow.supplierTotalHint", locale)}</p></Card> : null}

      {jc.type === "scheduled_service" && planLines.length > 0 ? <Card><CardHeader><CardTitle>{t("jobcards.serviceLinesCovered", locale)}</CardTitle></CardHeader><p className="mb-2 text-sm text-sand-500">{t("jobcards.serviceLinesHint", locale)}</p><ul className="flex flex-col gap-1 text-sm">{planLines.filter((line) => canWork || covered.has(line.id)).map((line) => <li key={line.id}>{canWork && working ? <form action={toggleServiceLine}><input type="hidden" name="job_card_id" value={id} /><input type="hidden" name="farm_id" value={jc.farm_id} /><input type="hidden" name="service_plan_line_id" value={line.id} /><input type="hidden" name="on" value={covered.has(line.id) ? "0" : "1"} /><button type="submit" aria-pressed={covered.has(line.id)} className="focus-ring flex min-h-[44px] w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-sand-50">{covered.has(line.id) ? <CheckIcon className="text-status-ok" /> : <SquareIcon className="text-sand-500" />}<span>{line.task}</span></button></form> : <p className="py-2">{covered.has(line.id) ? <CheckIcon /> : null} {line.task}</p>}</li>)}</ul></Card> : null}

      <Card><CardHeader action={canWork && working ? editDialog("handover") : undefined}><CardTitle>{t("jobcards.workflow.handover", locale)}</CardTitle></CardHeader><dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-sand-500">{t("jobcards.wentOut", locale)}</dt><dd>{jc.date_out ?? "-"}</dd></div>{machine?.meter_type !== "none" ? <div><dt className="text-sand-500">{t("jobcards.meterReading", locale)}</dt><dd>{jc.meter_reading != null && machine ? meterReading(jc.meter_reading, machine.meter_type, locale) : "-"}</dd></div> : null}</dl></Card>

      <Disclosure summary={t("jobcards.workflow.documents", locale)} meta={String(attachments.length + invoices.length)} defaultOpen={canMedia}>
        {invoices.length > 0 ? <ul className="mb-3 divide-y divide-sand-100 text-sm">{invoices.map((invoice) => <li key={invoice.id} className="flex justify-between gap-3 py-2"><span>{invoice.note || t("jobcards.invoiceRecorded", locale)}<span className="block text-sand-500">{invoice.occurred_on}</span></span><span className="font-medium tabular-nums">{rands(invoice.amount_cents)}</span></li>)}</ul> : null}
        {attachments.length > 0 ? <div className="mb-3 grid grid-cols-3 gap-2">{attachments.map((attachment) => attachment.url ? <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className="focus-ring flex items-center justify-center rounded-lg border border-sand-200 p-2 text-sm font-medium text-brand-ink">{attachment.kind === "photo" ? <Photo src={attachment.url} alt={t("jobcards.attachment", locale)} size="card" className="aspect-square w-full rounded-lg" /> : t(`jobcards.kind_${attachment.kind === "invoice" ? "invoice" : "quote"}`, locale)}</a> : null)}</div> : null}
        {invoices.length === 0 && attachments.length === 0 ? <p className="mb-3 text-sm text-sand-500">{t("jobcards.noMedia", locale)}</p> : null}
        {canMedia ? <DialogForm trigger={t("jobcards.workflow.addDocument", locale)} title={t("jobcards.workflow.addDocument", locale)} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel} size="md"><JobCardMedia actorId={profile.id} jobCardId={id} locale={locale} allowedKinds={canInvoice ? ["invoice"] : external && canWork ? ["photo", "quote"] : ["photo"]} canRecordAmount={canRecordAmount} /></DialogForm> : null}
      </Disclosure>
      <WarrantyPanel jobCardId={id} machineId={jc.machine_id} locale={locale} canManage={canApprove} />
    </div>
  );
}
