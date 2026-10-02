import Link from "next/link";
import type { ReactNode } from "react";
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
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Flash } from "@/components/ui/flash";
import { SquareIcon, CheckIcon, PlusIcon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { JobStatus } from "@/components/ui/status";
import { SubmitButton } from "@/components/ui/submit-button";
import { DialogActions, DialogForm } from "@/components/ui/dialog-form";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/ui/field";
import { Disclosure } from "@/components/ui/disclosure";
import { ActionMenu } from "@/components/ui/action-menu";
import { menuItemClass } from "@/components/ui/menu-item";
import { Fact, FactList } from "@/components/ui/facts";
import { Stepper } from "@/components/ui/stepper";
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

/** The four stages a person thinks in. Waiting for parts is still "working". */
const STEP_OF: Record<string, number> = { reported: 0, open: 0, in_progress: 1, waiting_parts: 1, completed: 2, approved: 3 };

/** A labelled block of free text: stacked, because a paragraph does not fit beside its label. */
function TextBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-2.5">
      <p className="text-xs font-medium text-sand-500">{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap text-sm text-sand-900">{children}</p>
    </div>
  );
}

/**
 * One job card.
 *
 * == Calm by stage =============================================================
 * The workflow behind this page is detailed (who owns the work, who bills, version
 * checks, drafts, receipts), and the first version of the page showed all of it at once:
 * three badges, two full-width buttons, a "Next step" card of explanatory paragraphs and
 * eight numbered cards, most of them a column of "-" for fields nobody had filled yet.
 *
 * Now the page answers two questions first, in one panel: where is this job, and what do
 * I do next. Then it shows only the sections that mean something at this stage: the work,
 * parts and handover appear once work has started. Every rule is unchanged; the same
 * actions, permissions and dialogs are reached, just from fewer places.
 */
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
  const finished = jc.status === "completed" || jc.status === "approved";
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
  const sectionDialog = (section: "intake" | "work" | "handover", trigger: string, look: "button" | "menuItem" = "button") => (
    <DialogForm trigger={trigger} title={t(`jobcards.workflow.edit_${section}`, locale)} description={machine?.name} triggerLook={look} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel} size="md">
      <JobCardEditor id={id} actorId={profile.id} updatedAt={jc.updated_at} section={section} meterType={machine?.meter_type ?? "none"} locale={locale} initial={initial} />
    </DialogForm>
  );
  const lineDetail = (line: Line) => line.kind === "part"
    ? `${line.qty ?? 0}${costsVisible ? ` × ${rands(line.unit_cost_cents)}` : ""}`
    : line.kind === "labour" ? `${line.hours ?? 0} h${costsVisible ? ` × ${rands(line.rate_cents)}` : ""}` : t("jobcards.otherKind", locale);
  const assignedContractor = !!jc.workshop_id && profile.workshop_id === jc.workshop_id && profile.role === "workshop";
  const canInvoice = external && costsVisible && ["completed", "approved"].includes(jc.status) && (canApprove || assignedContractor);
  const canRecordAmount = canInvoice && !workRequest && (assignedContractor || !jc.workshop_id);
  const canMedia = canWork || canInvoice;
  const canEditWork = canWork && working;
  const meterNeeded = needsJobMeter(jc.type, machine?.meter_type ?? "none");
  const needsServiceSelection = jc.type === "scheduled_service" && planLines.length > 0 && !planLines.some((line) => covered.has(line.id));

  // One sentence, for this person, about what happens next.
  const next = jc.locked || jc.status === "approved"
    ? t("jobview.next.approved", locale).replace("{date}", jc.approved_at ? shortDate(jc.approved_at, locale) : "")
    : jc.status === "completed"
      ? canApprove ? t(canReturn ? "jobview.next.review" : "jobview.next.reviewNoReturn", locale) : t("jobview.next.reviewWait", locale)
      : jc.status === "waiting_parts" ? t("jobview.next.waiting", locale)
        : jc.status === "in_progress" ? t(canWork ? "jobview.next.working" : "jobview.next.workingWait", locale)
          : t(canWork ? "jobview.next.open" : "jobview.next.openWait", locale);

  const steps = [t("jobview.steps.open", locale), t("jobview.steps.working", locale), t("jobview.steps.done", locale), t("jobview.steps.approved", locale)];
  const step = jc.locked ? 3 : (STEP_OF[jc.status] ?? 0);
  const who = external ? (provider ?? t("jobcards.workflow.external", locale)) : t("jobview.ours", locale);
  const hasWorkText = !!(jc.diagnosis?.trim() || jc.work_performed?.trim() || jc.recommendations?.trim());
  const showWork = working || finished || hasWorkText;
  const showParts = working || finished || lines.length > 0;
  const showHandover = working || finished || !!jc.date_out || jc.meter_reading != null;
  const docCount = attachments.length + invoices.length;

  return (
    <PageContainer>
      <IntakeAcknowledgement actorId={profile.id} />
      <PageHeader
        back={{ href: "/jobcards", label: t("jobcards.back", locale) }}
        title={machine?.name ?? t("jobcards.title", locale)}
        meta={<>{t(`jobType.${jc.type}`, locale)} · {who}{jc.date_in ? <> · {t("jobview.cameInOn", locale).replace("{date}", shortDate(jc.date_in, locale))}</> : null}</>}
        badge={<JobStatus value={jc.status} locale={locale} />}
        menu={
          <ActionMenu title={machine?.name ?? t("jobcards.title", locale)} label={t("nav.more", locale)} closeLabel={closeLabel} trigger={t("nav.more", locale)}>
            {canWork ? sectionDialog("intake", t("jobcards.workflow.edit_intake", locale), "menuItem") : null}
            {!external && canWork && canApprove ? (
              <DialogForm trigger={t("jobcards.workflow.assignWorker", locale)} triggerLook="menuItem" title={t("jobcards.workflow.assignWorker", locale)} description={machine?.name} closeLabel={closeLabel} size="md">
                <form action={assignJobWorker} className="flex flex-col gap-4">
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="updated_at" value={jc.updated_at} />
                  <Field label={t("jobcards.workflow.assignedWorker", locale)} htmlFor="job-assignee">
                    <Select id="job-assignee" name="mechanic_user_id" defaultValue={jc.mechanic_user_id ?? ""}>
                      <option value="">{t("jobcards.workflow.unassigned", locale)}</option>
                      {team.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                    </Select>
                  </Field>
                  <DialogActions cancelLabel={cancelLabel}><SubmitButton variant="primary">{t("jobcards.saveNow", locale)}</SubmitButton></DialogActions>
                </form>
              </DialogForm>
            ) : null}
            {workRequest ? <Link href={`/work/${workRequest.id}`} className={menuItemClass()}>{t("jobview.linkedRequest", locale)}</Link> : null}
            <Link href={`/machines/${jc.machine_id}`} className={menuItemClass()}>{t("jobcards.openMachine", locale)}</Link>
            <a href={`/jobcards/${id}/pdf`} className={menuItemClass()}>{t("common.print", locale)}</a>
          </ActionMenu>
        }
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="error" message={loadError ? t("jobcards.workflow.loadError", locale) : undefined} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      {/* Where it is, and what to do next. */}
      <Card className="flex flex-col gap-4">
        <Stepper steps={steps} current={step} label={t("jobview.progress", locale)}
          progressLabel={t("jobview.stepOf", locale).replace("{n}", String(step + 1)).replace("{total}", String(steps.length))} />
        <p className="text-base text-sand-900">{next}</p>
        {jc.review_note && !finished ? (
          <div className="rounded-lg bg-callout-warn-bg px-3 py-2.5">
            <p className="text-sm font-semibold text-sand-900">{t("jobcards.workflow.correctionsRequested", locale)}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-sand-700">{jc.review_note}</p>
          </div>
        ) : null}
        {jc.locked ? null : (
          <LifecycleActions
            id={id} status={jc.status} updatedAt={jc.updated_at} meterReading={jc.meter_reading}
            meterRequired={meterNeeded} hasWorkPerformed={!!jc.work_performed?.trim()} needsServiceSelection={needsServiceSelection}
            canWork={canWork} canApprove={canApprove} canReturn={canReturn} correctionHistoryAvailable={jc.completion_effects_recorded} locale={locale}
            fixWork={canEditWork ? sectionDialog("work", t("jobview.writeUp", locale)) : undefined}
            fixMeter={canEditWork ? sectionDialog("handover", t("jobcards.workflow.edit_handover", locale)) : undefined}
          />
        )}
      </Card>

      {/* The job: what was wrong, and who is on it. */}
      <Card>
        <CardHeader action={canWork ? sectionDialog("intake", t("common.edit", locale)) : undefined}>
          <CardTitle>{t("jobview.section.job", locale)}</CardTitle>
        </CardHeader>
        <TextBlock label={t("jobcards.qWrong", locale)}>
          {jc.reported_problem?.trim() ? jc.reported_problem : <span className="text-sand-500">{t("jobview.noProblem", locale)}</span>}
        </TextBlock>
        <FactList>
          {external ? <Fact label={t("jobview.doneBy", locale)} value={who} /> : (
            <Fact label={t("jobcards.workflow.assignedWorker", locale)} value={assignee ?? t("jobcards.workflow.unassigned", locale)} muted={!assignee} />
          )}
          {jc.date_in ? <Fact label={t("jobcards.cameIn", locale)} value={shortDate(jc.date_in, locale)} /> : null}
        </FactList>
      </Card>

      {/* The work: only once there is work to write about. */}
      {showWork ? (
        <Card>
          <CardHeader action={canEditWork && hasWorkText ? sectionDialog("work", t("common.edit", locale)) : undefined}>
            <CardTitle>{t("jobview.section.work", locale)}</CardTitle>
          </CardHeader>
          {hasWorkText ? (
            <div className="divide-y divide-sand-100">
              {jc.diagnosis?.trim() ? <TextBlock label={t("jobcards.diagnosis", locale)}>{jc.diagnosis}</TextBlock> : null}
              {jc.work_performed?.trim() ? <TextBlock label={t("jobcards.workPerformed", locale)}>{jc.work_performed}</TextBlock> : null}
              {jc.recommendations?.trim() ? <TextBlock label={t("jobcards.recommendations", locale)}>{jc.recommendations}</TextBlock> : null}
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-sand-500">{t("jobview.notYet", locale)}</p>
              {canEditWork ? sectionDialog("work", t("jobview.writeUp", locale)) : null}
            </div>
          )}
        </Card>
      ) : null}

      {/* Parts and labour, with the running total underneath. */}
      {showParts ? (
        <Card>
          <CardHeader action={canEditWork ? (
            <DialogForm trigger={t("jobview.add", locale)} triggerIcon={<PlusIcon />} title={t("jobcards.workflow.addLine", locale)} description={machine?.name} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel} size="md">
              <LineEntry actorId={profile.id} jobCardId={id} farmId={jc.farm_id} vatRateBps={jc.vat_rate_bps} locale={locale} catalogue={catalogue} costsVisible={costsVisible} />
            </DialogForm>
          ) : undefined}>
            <CardTitle>{t("jobview.section.parts", locale)}</CardTitle>
          </CardHeader>
          {lines.length === 0 ? <p className="text-sm text-sand-500">{t("jobcards.noLines", locale)}</p> : (
            <ul className="divide-y divide-sand-100">
              {lines.map((line) => {
                const name = line.description || line.part_no || t(`jobcards.${line.kind}Kind`, locale);
                return (
                  <li key={line.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-sand-900">{name}</p>
                      <p className="text-xs text-sand-500">{lineDetail(line)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {costsVisible ? <span className="text-sm font-medium tabular-nums text-sand-900">{rands(line.total_cents)}</span> : null}
                      {canEditWork ? (
                        <ActionMenu title={name} label={`${t("jobview.lineActions", locale)}: ${name}`} closeLabel={closeLabel}>
                          <DialogForm trigger={t("common.edit", locale)} triggerLook="menuItem" title={t("jobcards.workflow.editLine", locale)} description={name} closeLabel={closeLabel} size="md">
                            <LineEntry actorId={profile.id} jobCardId={id} farmId={jc.farm_id} vatRateBps={jc.vat_rate_bps} locale={locale} catalogue={catalogue} costsVisible={costsVisible} line={line} />
                          </DialogForm>
                          <ConfirmDialog action={removeLine} triggerLook="menuItem" triggerLabel={t("jobcards.remove", locale)} title={t("confirm.removeLineTitle", locale).replace("{line}", name)} confirmLabel={t("confirm.removeLineYes", locale)} cancelLabel={t("confirm.keepIt", locale)} closeLabel={closeLabel}>
                            <input type="hidden" name="line_id" value={line.id} />
                            <input type="hidden" name="line_updated_at" value={line.updated_at} />
                            <input type="hidden" name="job_card_id" value={id} />
                          </ConfirmDialog>
                        </ActionMenu>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {canEditWork && costsVisible && kits.length > 0 ? (
            <div className="mt-2">
              <DialogForm trigger={t("jobview.useKit", locale)} title={t("jobcards.applyKit", locale)} description={machine?.name} triggerVariant="ghost" triggerSize="sm" closeLabel={closeLabel} size="md">
                <ServiceKitForm jobId={id} farmId={jc.farm_id} actorId={profile.id} kits={kits} locale={locale} />
              </DialogForm>
            </div>
          ) : null}
          {costsVisible ? (
            <FactList className="mt-3 border-t border-sand-100 pt-1">
              <Fact
                label={t(external ? "jobcards.thisJobSoFar" : "jobcards.workflow.internalCost", locale)}
                value={<span className="text-lg font-bold tabular-nums">{rands(jc.total_cents)}</span>}
                hint={`${t(external ? "jobview.externalCostHint" : "jobview.internalCostHint", locale)} ${t("jobcards.exVatNote", locale)}`}
              />
              {external && supplierTotal != null ? (
                <Fact label={t("jobcards.workflow.supplierTotal", locale)} value={<span className="text-lg font-bold tabular-nums">{rands(supplierTotal)}</span>} />
              ) : null}
            </FactList>
          ) : null}
        </Card>
      ) : null}

      {/* Which service tasks this job covered. */}
      {jc.type === "scheduled_service" && planLines.length > 0 && (working || finished) ? (
        <Card id="tasks" className="scroll-mt-24">
          <CardHeader><CardTitle>{t("jobview.section.tasks", locale)}</CardTitle></CardHeader>
          <ul className="flex flex-col">
            {planLines.filter((line) => canEditWork || covered.has(line.id)).map((line) => (
              <li key={line.id}>
                {canEditWork ? (
                  <form action={toggleServiceLine}>
                    <input type="hidden" name="job_card_id" value={id} />
                    <input type="hidden" name="farm_id" value={jc.farm_id} />
                    <input type="hidden" name="service_plan_line_id" value={line.id} />
                    <input type="hidden" name="on" value={covered.has(line.id) ? "0" : "1"} />
                    <button type="submit" aria-pressed={covered.has(line.id)} className="focus-ring -mx-2 flex min-h-[48px] w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 text-left text-sm text-sand-900 hover:bg-sand-50 sm:min-h-[44px]">
                      {covered.has(line.id) ? <CheckIcon className="text-lg text-status-ok" /> : <SquareIcon className="text-lg text-sand-400" />}
                      <span>{line.task}</span>
                    </button>
                  </form>
                ) : (
                  <p className="flex min-h-[44px] items-center gap-3 text-sm text-sand-900"><CheckIcon className="text-lg text-status-ok" /> {line.task}</p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Handover: when it went back, and the meter. */}
      {showHandover ? (
        <Card>
          <CardHeader action={canEditWork ? sectionDialog("handover", t("common.edit", locale)) : undefined}>
            <CardTitle>{t("jobview.section.handover", locale)}</CardTitle>
          </CardHeader>
          <FactList>
            <Fact label={t("jobcards.wentOut", locale)} value={jc.date_out ? shortDate(jc.date_out, locale) : t("jobview.notYet", locale)} muted={!jc.date_out} />
            {machine?.meter_type !== "none" ? (
              <Fact label={t("jobcards.meterReading", locale)}
                value={jc.meter_reading != null && machine ? meterReading(jc.meter_reading, machine.meter_type, locale) : t("jobview.notYet", locale)}
                muted={jc.meter_reading == null} />
            ) : null}
          </FactList>
        </Card>
      ) : null}

      <Disclosure summary={t("jobcards.workflow.documents", locale)} meta={docCount ? String(docCount) : undefined} defaultOpen={canInvoice && jc.status === "completed"}>
        {invoices.length > 0 ? (
          <ul className="mb-3 divide-y divide-sand-100 text-sm">
            {invoices.map((invoice) => (
              <li key={invoice.id} className="flex justify-between gap-3 py-2">
                <span>{invoice.note || t("jobcards.invoiceRecorded", locale)}<span className="block text-sand-500">{shortDate(invoice.occurred_on, locale)}</span></span>
                <span className="font-medium tabular-nums">{rands(invoice.amount_cents)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {attachments.length > 0 ? (
          <div className="mb-3 grid grid-cols-3 gap-2">
            {attachments.map((attachment) => attachment.url ? (
              <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className="focus-ring flex items-center justify-center rounded-lg border border-sand-200 p-2 text-sm font-medium text-brand-ink">
                {attachment.kind === "photo" ? <Photo src={attachment.url} alt={t("jobcards.attachment", locale)} size="card" className="aspect-square w-full rounded-lg" /> : t(`jobcards.kind_${attachment.kind === "invoice" ? "invoice" : "quote"}`, locale)}
              </a>
            ) : null)}
          </div>
        ) : null}
        {docCount === 0 ? <p className="mb-3 text-sm text-sand-500">{t("jobcards.noMedia", locale)}</p> : null}
        {canMedia ? (
          <DialogForm trigger={t("jobcards.workflow.addDocument", locale)} title={t("jobcards.workflow.addDocument", locale)} description={machine?.name} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel} size="md">
            <JobCardMedia actorId={profile.id} jobCardId={id} locale={locale} allowedKinds={canInvoice ? ["invoice"] : external && canWork ? ["photo", "quote"] : ["photo"]} canRecordAmount={canRecordAmount} />
          </DialogForm>
        ) : null}
      </Disclosure>
      <WarrantyPanel jobCardId={id} machineId={jc.machine_id} locale={locale} canManage={canApprove} />
    </PageContainer>
  );
}
