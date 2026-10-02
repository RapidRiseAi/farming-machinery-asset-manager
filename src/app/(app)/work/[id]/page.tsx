import Link from "next/link";
import { errorMessage } from "@/lib/errors";
import { Photo } from "@/components/ui/photo";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { DateText } from "@/components/ui/date-text";
import { notFound } from "next/navigation";
import { requireProfile, effectiveFarmRole, checkWorkshopEntitlement } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { telHref, waHref, mailtoHref } from "@/lib/contact";
import { typeLabel } from "@/lib/machine-options";
import {
  WORK_STATUSES, workStatusLabel, workKindLabel, workStatusStep,
  workPriorityLabel, workPriorityTone,
} from "@/lib/work";
import { WorkRequestMedia } from "@/components/work-request-media";
import { UploadDocument } from "@/components/partner/upload-document";
import { IntakeAcknowledgement } from "@/components/jobcards/intake-acknowledgement";
import { canConvertWorkRequest, canRecordWorkAmount, workTransitions } from "@/lib/work-lifecycle";
import { createDocument } from "../../documents/actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { DialogActions, DialogForm } from "@/components/ui/dialog-form";
import { Flash } from "@/components/ui/flash";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import {
  PhoneIcon, ChatIcon, MailIcon, JobCardsIcon, MachinesIcon,
} from "@/components/ui/icons";
import { WorkStatus, PriorityStatus } from "@/components/ui/status";
import {
  updateWorkRequestStatus, addWorkRequestNote, setWorkRequestQuote,
  setWorkRequestInvoice, convertToJobCard, assignWorkRequestProvider,
} from "../actions";

type WorkRequest = {
  id: string; farm_id: string; machine_id: string; workshop_id: string | null;
  kind: string; status: string; priority: string; title: string | null; description: string | null;
  quote_amount_cents: number | null; invoice_amount_cents: number | null; vat_rate_bps: number | null;
  job_card_id: string | null; created_at: string; updated_at: string;
};
type Machine = { id: string; name: string; type: string; meter_type: string; current_reading: number | null; status: string };
type Workshop = { id: string; name: string; kind: string; phone: string | null; whatsapp: string | null; email: string | null; area: string | null };
type Event = { id: string; from_status: string | null; to_status: string; note: string | null; by_user: string | null; created_at: string };
type Attachment = { id: string; kind: string; storage_path: string | null; url: string | null; created_at: string };

const savedMsg: Record<string, string> = {
  "1": "ui.saved", note: "ui.saved", quote: "work.quoteSaved", invoice: "work.invoiceSaved",
};

export default async function WorkRequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  const { id } = await params;
  const sp = await searchParams;
  const locale = profile.lang;
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);

  const supabase = await createClient();
  const { data } = await supabase
    .from("work_requests_visible")
    .select("id, farm_id, machine_id, workshop_id, kind, status, priority, title, description, quote_amount_cents, invoice_amount_cents, vat_rate_bps, job_card_id, created_at, updated_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const wr = data as WorkRequest | null;
  if (!wr) notFound();
  const resourceRole = profile.role === "workshop" ? "workshop" : await effectiveFarmRole(wr.farm_id, profile);
  const isProvider = resourceRole === "workshop" && !!wr.workshop_id && profile.workshop_id === wr.workshop_id;
  const canWork = resourceRole != null && (["owner", "manager", "mechanic"].includes(resourceRole) || isProvider);
  const canApprove = resourceRole === "owner" || resourceRole === "manager";
  const canBuildDocuments = isProvider && (await checkWorkshopEntitlement("build_documents", profile)).allowed;

  const [machineRes, wsRes, evRes, attRes, userRes, docRes, providerRes] = await Promise.all([
    supabase.from("machines").select("id, name, type, meter_type, current_reading, status").eq("id", wr.machine_id).maybeSingle(),
    wr.workshop_id ? supabase.from("workshops").select("id, name, kind, phone, whatsapp, email, area").eq("id", wr.workshop_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("work_request_events").select("id, from_status, to_status, note, by_user, created_at").eq("work_request_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("attachments").select("id, kind, storage_path, url, created_at").eq("parent_type", "work_request").eq("parent_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("users").select("id, name").is("deleted_at", null),
    supabase.from("partner_documents").select("id, kind, status, number, total_cents").eq("work_request_id", id).is("deleted_at", null).neq("status", "void").order("created_at", { ascending: false }),
    !wr.workshop_id && canApprove ? supabase.from("workshop_links").select("workshop_id, workshops(id, name)").eq("farm_id", wr.farm_id).eq("status", "active").is("deleted_at", null) : Promise.resolve({ data: [] }),
  ]);
  const machine = machineRes.data as Machine | null;
  const workshop = wsRes.data as Workshop | null;
  const events = (evRes.data as Event[] | null) ?? [];
  const attachments = (attRes.data as Attachment[] | null) ?? [];
  const documents = (docRes.data ?? []) as { id: string; kind: string; status: string; number: string; total_cents: number }[];
  const providers = ((providerRes.data ?? []) as unknown as { workshop_id: string; workshops: { id: string; name: string } | { id: string; name: string }[] | null }[])
    .map((link) => Array.isArray(link.workshops) ? link.workshops[0] : link.workshops).filter((item): item is { id: string; name: string } => !!item);
  const userName = new Map(((userRes.data as { id: string; name: string }[] | null) ?? []).map((u) => [u.id, u.name]));

  // Batch-sign attachment storage paths (private bucket) → viewable URLs.
  const paths = attachments.map((a) => a.storage_path).filter((p): p is string => !!p);
  const signedByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage.from("jobcard-photos").createSignedUrls(paths, 3600);
    for (const sgn of signed ?? []) {
      if (sgn.path && sgn.signedUrl) signedByPath.set(sgn.path, sgn.signedUrl);
    }
  }
  const attUrl = (a: Attachment) => (a.storage_path ? signedByPath.get(a.storage_path) : null) ?? (a.url && !a.url.startsWith("demo://") ? a.url : null);

  const curStep = workStatusStep(wr.status);
  const isClosed = wr.status === "closed";
  const canQuote = canRecordWorkAmount("quote", wr.status, resourceRole, !!wr.workshop_id) && isProvider;
  const canInvoice = canRecordWorkAmount("invoice", wr.status, resourceRole, !!wr.workshop_id) && isProvider;
  const quickLabels: Record<string, string> = {
    viewed: "work.markViewed",
    accepted: wr.status === "quoted" && !documents.some((doc) => doc.kind === "quote") ? "work.acceptQuote" : "work.authorizeWork",
    in_progress: "work.startWork", completed: "work.markCompleted", closed: "work.acceptCompletion",
  };
  const quicks = workTransitions(wr.status, resourceRole, !!wr.workshop_id)
    // The job card records the work and checks completion; its status syncs here.
    .filter((status) => !(wr.job_card_id && status === "completed"))
    .filter((status) => !(status === "accepted" && documents.some((doc) => doc.kind === "quote" && doc.status === "sent")))
    .map((status) => ({ status, label: t(quickLabels[status], locale) }));
  const amountKinds: ("quote" | "invoice")[] = [
    ...(canQuote && !documents.some((doc) => doc.kind === "quote") ? ["quote" as const] : []),
    ...(canInvoice && !documents.some((doc) => doc.kind === "invoice") ? ["invoice" as const] : []),
  ];
  const stageHint = !wr.workshop_id ? "work.assignHint" : isClosed ? "work.closedHint"
    : ["requested", "viewed", "quoted"].includes(wr.status) ? "work.authorizeHint"
      : ["accepted", "in_progress"].includes(wr.status) ? "work.providerWorkHint" : "work.reviewHint";

  return (
    <PageContainer size="wide">
      <IntakeAcknowledgement actorId={profile.id} />
      <PageHeader
        back={{ href: "/work", label: t("work.title", locale) }}
        title={wr.title || workKindLabel(wr.kind, locale)}
        badge={<><WorkStatus value={wr.status} locale={locale} size="md" />{wr.priority !== "normal" ? <Badge tone={workPriorityTone(wr.priority)}>{workPriorityLabel(wr.priority, locale)}</Badge> : null}</>}
        meta={<>{workKindLabel(wr.kind, locale)} · {t("work.created", locale)} <DateText value={wr.created_at} locale={locale} /></>}
        lead={wr.description || undefined}
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t(savedMsg[sp.saved] ?? "ui.saved", locale) : undefined} />

      <Card>
        {/* Lifecycle stepper */}
        <div className="overflow-x-auto">
          <ol className="flex min-w-max items-center gap-1 text-xs">
            {WORK_STATUSES.map((st, i) => {
              const done = i < curStep;
              const active = i === curStep;
              return (
                <li key={st} className="flex items-center gap-1">
                  <span
                    className={`whitespace-nowrap rounded-full px-2.5 py-1 font-medium ${
                      active ? "bg-brand-600 text-white" : done ? "bg-brand-tint text-brand-ink" : "bg-sand-100 text-sand-400"
                    }`}
                  >
                    {workStatusLabel(st, locale)}
                  </span>
                  {i < WORK_STATUSES.length - 1 ? <span className="text-sand-400">›</span> : null}
                </li>
              );
            })}
          </ol>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Main column */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          {/* Highlighted vehicle */}
          {machine ? (
            <Card>
              <CardHeader><CardTitle>{t("work.vehicle", locale)}</CardTitle></CardHeader>
              <Link href={`/machines/${machine.id}`} className="focus-ring flex items-center gap-3 rounded-lg ring-2 ring-brand-200 bg-brand-tint/40 p-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface text-xl text-brand-ink ring-1 ring-sand-200">
                  <MachinesIcon />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-sand-900">{machine.name}</span>
                  <span className="block text-sm text-sand-500">
                    {typeLabel(machine.type, locale)}
                    {machine.current_reading != null && machine.meter_type !== "none" ? ` · ${machine.current_reading} ${machine.meter_type}` : ""}
                  </span>
                </span>
              </Link>
            </Card>
          ) : null}

          {/* Each side sees only the decisions they are responsible for. */}
          <Card>
            <CardHeader><CardTitle>{t("work.nextStep", locale)}</CardTitle></CardHeader>
            <p className="text-sm text-sand-600">{t(stageHint, locale)}</p>
            {wr.job_card_id && ["accepted", "in_progress"].includes(wr.status) ? (
              <Link href={`/jobcards/${wr.job_card_id}`} className={buttonVariants({ variant: "secondary", size: "sm", className: "mt-3" })}>
                {t("work.openJobCard", locale)}
              </Link>
            ) : null}
          </Card>

          {canWork && !isClosed ? (
            <Card>
              <CardHeader><CardTitle>{t("work.updateStatus", locale)}</CardTitle></CardHeader>
              {quicks.length > 0 ? (
                <div className="mb-3 flex flex-wrap gap-2">
                  {quicks.map((qk) => (
                    <form action={updateWorkRequestStatus} key={qk.status}>
                      <input type="hidden" name="id" value={wr.id} />
                      <input type="hidden" name="status" value={qk.status} />
                      <SubmitButton variant="secondary" size="sm">{qk.label}</SubmitButton>
                    </form>
                  ))}
                </div>
              ) : null}
              {/* Progress note (no status change) */}
              <DialogForm trigger={t("work.addNote", locale)} title={t("work.addNote", locale)} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel} size="md">
                <form action={addWorkRequestNote} className="flex flex-col gap-3">
                  <input type="hidden" name="id" value={wr.id} />
                  <Field label={t("work.addNote", locale)} htmlFor="progress_note">
                    <Input id="progress_note" name="note" placeholder={t("work.notePlaceholder", locale)} required />
                  </Field>
                  <DialogActions cancelLabel={cancelLabel}>
                    <SubmitButton variant="primary">{t("work.addNote", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            </Card>
          ) : null}

          {/* Quote / invoice + proof upload */}
          {canWork ? (
            <Card>
              <CardHeader><CardTitle>{t("work.quoteInvoice", locale)}</CardTitle></CardHeader>
              <p className="mb-3 text-sm text-sand-600">{t("work.providerBillingHint", locale)}</p>
              {documents.length ? (
                <ul className="mb-4 space-y-2">
                  {documents.map((doc) => (
                    <li key={doc.id}>
                      <Link href={`/documents/${doc.id}`} className="focus-ring flex items-center justify-between gap-3 rounded-lg border border-sand-200 p-3 text-sm hover:bg-sand-50">
                        <span>{doc.number} · {t(`docStatus.${doc.status}`, locale)}</span>
                        <span className="font-semibold tabular-nums">{rands(doc.total_cents)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
              {canBuildDocuments && (canQuote || canInvoice)
                && !documents.some((doc) => doc.kind === (canInvoice ? "invoice" : "quote") && !["declined", "cancelled", "expired"].includes(doc.status)) ? (
                <form action={createDocument} className="mb-4">
                  <input type="hidden" name="farm_id" value={wr.farm_id} />
                  <input type="hidden" name="machine_id" value={wr.machine_id} />
                  <input type="hidden" name="work_request_id" value={wr.id} />
                  <input type="hidden" name="kind" value={canInvoice ? "invoice" : "quote"} />
                  <input type="hidden" name="subject" value={wr.title || workKindLabel(wr.kind, locale)} />
                  <SubmitButton variant="primary" size="sm">{t(canInvoice ? "work.createInvoice" : "work.createQuote", locale)}</SubmitButton>
                </form>
              ) : null}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-sand-400">{t("work.quote", locale)}</p>
                  <p className="mt-0.5 text-lg font-bold tabular-nums text-sand-900">
                    {wr.quote_amount_cents != null ? rands(wr.quote_amount_cents) : "-"}
                  </p>
                  {amountKinds.includes("quote") ? <div className="mt-2">
                    <DialogForm trigger={t("work.recordIssuedQuote", locale)} title={t("work.recordIssuedQuote", locale)} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel} size="md">
                      <form action={setWorkRequestQuote} className="flex flex-col gap-3">
                        <input type="hidden" name="id" value={wr.id} />
                        <Field label={t("work.quoteAmountLabel", locale)} htmlFor="quote_amount" hint={t("work.amountHint", locale)}>
                          <Input id="quote_amount" name="amount" inputMode="decimal" required />
                        </Field>
                        <label className="flex min-h-[44px] items-center gap-2 text-sm text-sand-600">
                          <input type="checkbox" name="incl_vat" value="1" className="h-4 w-4 rounded border-sand-300" /> {t("work.inclVat", locale)}
                        </label>
                        <DialogActions cancelLabel={cancelLabel}>
                          <SubmitButton variant="primary">{t("work.recordQuote", locale)}</SubmitButton>
                        </DialogActions>
                      </form>
                    </DialogForm>
                  </div> : null}
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-sand-400">{t("work.invoice", locale)}</p>
                  <p className="mt-0.5 text-lg font-bold tabular-nums text-sand-900">
                    {wr.invoice_amount_cents != null ? rands(wr.invoice_amount_cents) : "-"}
                  </p>
                  <p className="text-xs text-sand-400">{t("work.invoiceToTco", locale)}</p>
                  {amountKinds.includes("invoice") ? <div className="mt-2">
                    <DialogForm trigger={t("work.recordIssuedInvoice", locale)} title={t("work.recordIssuedInvoice", locale)} description={t("work.zeroInvoiceHint", locale)} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel} size="md">
                      <form action={setWorkRequestInvoice} className="flex flex-col gap-3">
                        <input type="hidden" name="id" value={wr.id} />
                        <Field label={t("work.invoiceAmountLabel", locale)} htmlFor="invoice_amount" hint={t("work.amountHint", locale)}>
                          <Input id="invoice_amount" name="amount" inputMode="decimal" required />
                        </Field>
                        <label className="flex min-h-[44px] items-center gap-2 text-sm text-sand-600">
                          <input type="checkbox" name="incl_vat" value="1" className="h-4 w-4 rounded border-sand-300" /> {t("work.inclVat", locale)}
                        </label>
                        <DialogActions cancelLabel={cancelLabel}>
                          <SubmitButton variant="primary">{t("work.recordInvoice", locale)}</SubmitButton>
                        </DialogActions>
                      </form>
                    </DialogForm>
                  </div> : null}
                </div>
              </div>
              {wr.workshop_id && (canApprove || isProvider) && ["requested", "viewed", "quoted", "completed", "invoiced"].includes(wr.status) ? (
                <div className="mt-4 border-t border-sand-100 pt-3">
                  <DialogForm trigger={t("work.fileSupplierDocument", locale)} title={t("work.fileSupplierDocument", locale)} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel}>
                    <UploadDocument locale={locale} actorId={profile.id} isPartner={isProvider}
                      parties={[{ id: wr.workshop_id, name: workshop?.name ?? "" }]}
                      work={{ id: wr.id, farmId: wr.farm_id, machineId: wr.machine_id, workshopId: wr.workshop_id,
                        kind: ["completed", "invoiced"].includes(wr.status) ? "invoice" : "quote" }} />
                  </DialogForm>
                </div>
              ) : null}
              {!isClosed ? <div className="mt-4 border-t border-sand-100 pt-3">
                <DialogForm trigger={t("work.uploadProof", locale)} title={t("work.uploadProof", locale)} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel} size="md">
                  <WorkRequestMedia workRequestId={wr.id} locale={locale} allowedKinds={["photo"]} />
                </DialogForm>
              </div> : null}
            </Card>
          ) : null}

          {/* Attachments */}
          {attachments.length > 0 ? (
            <Card>
              <CardHeader><CardTitle>{t("work.attachments", locale)}</CardTitle></CardHeader>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {attachments.map((a) => {
                  const url = attUrl(a);
                  return (
                    <li key={a.id} className="overflow-hidden rounded-lg border border-sand-200">
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer" className="focus-ring block">
                          <div className="flex h-24 items-center justify-center bg-sand-50">
                            {a.kind === "photo" ? (
                              <Photo src={url} alt={t(`attachmentKind.${a.kind}`, locale)} size="card" className="h-full w-full" />
                            ) : (
                              <span className="text-sm font-medium text-brand-ink">{t(`attachmentKind.${a.kind}`, locale)}</span>
                            )}
                          </div>
                          <p className="px-2 py-1 text-xs text-sand-500">{t(`attachmentKind.${a.kind}`, locale)} · <DateText value={a.created_at} locale={locale} format="day" /></p>
                        </a>
                      ) : (
                        <div className="p-2 text-xs text-sand-400">{t(`attachmentKind.${a.kind}`, locale)}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}

          {/* Timeline */}
          <Card>
            <CardHeader><CardTitle>{t("work.timeline", locale)}</CardTitle></CardHeader>
            {events.length === 0 ? (
              <EmptyState title={t("work.noEvents", locale)} />
            ) : (
              <ol className="flex flex-col">
                {events.map((e) => (
                  <li key={e.id} className="flex gap-3 border-b border-sand-100 py-2.5 last:border-0">
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-brand-400" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium text-sand-900">
                          {e.from_status && e.from_status !== e.to_status
                            ? `${workStatusLabel(e.from_status, locale)} → ${workStatusLabel(e.to_status, locale)}`
                            : workStatusLabel(e.to_status, locale)}
                        </span>
                        <DateText value={e.created_at} locale={locale} format="day" className="shrink-0 text-xs tabular-nums text-sand-400" />
                      </div>
                      {e.note ? <p className="text-sm text-sand-600">{e.note}</p> : null}
                      {e.by_user ? <p className="text-xs text-sand-400">{userName.get(e.by_user) ?? ""}</p> : null}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-4">
          {/* Contractor */}
          <Card>
            <CardHeader><CardTitle>{t("work.contractor", locale)}</CardTitle></CardHeader>
            {workshop ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-sand-900">{workshop.name}</span>
                  <Badge tone="neutral">{t(`partnerKind.${workshop.kind}`, locale)}</Badge>
                </div>
                {workshop.area ? <p className="text-xs text-sand-500">{workshop.area}</p> : null}
                <div className="mt-1 flex flex-wrap gap-2">
                  {telHref(workshop.phone) ? (
                    <a href={telHref(workshop.phone)!} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                      <PhoneIcon className="text-base" /> {t("contact.call", locale)}
                    </a>
                  ) : null}
                  {waHref(workshop.whatsapp ?? workshop.phone, t("contact.waPrefill", locale)) ? (
                    <a href={waHref(workshop.whatsapp ?? workshop.phone, t("contact.waPrefill", locale))!} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                      <ChatIcon className="text-base" /> {t("contact.whatsapp", locale)}
                    </a>
                  ) : null}
                  {mailtoHref(workshop.email) ? (
                    <a href={mailtoHref(workshop.email)!} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                      <MailIcon className="text-base" /> {t("contact.email", locale)}
                    </a>
                  ) : null}
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm text-sand-500">{t("work.unassigned", locale)}</p>
                {canApprove && wr.status === "requested" && providers.length ? (
                  <div className="mt-3">
                    <DialogForm trigger={t("work.assignProvider", locale)} title={t("work.assignProvider", locale)} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel} size="md">
                      <form action={assignWorkRequestProvider} className="flex flex-col gap-3">
                        <input type="hidden" name="id" value={wr.id} />
                        <Field label={t("work.contractor", locale)} htmlFor="assign_provider">
                          <Select id="assign_provider" name="workshop_id" required>
                            {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                          </Select>
                        </Field>
                        <DialogActions cancelLabel={cancelLabel}>
                          <SubmitButton variant="primary">{t("work.assignProvider", locale)}</SubmitButton>
                        </DialogActions>
                      </form>
                    </DialogForm>
                  </div>
                ) : null}
              </>
            )}
          </Card>

          {/* Link to maintenance */}
          <Card>
            <CardHeader><CardTitle>{t("work.jobCard", locale)}</CardTitle></CardHeader>
            {wr.job_card_id ? (
              <Link href={`/jobcards/${wr.job_card_id}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                <JobCardsIcon className="text-base" /> {t("work.openJobCard", locale)}
              </Link>
            ) : canConvertWorkRequest(wr.status, resourceRole, !!wr.workshop_id) ? (
              <>
                <p className="mb-2 text-sm text-sand-500">{t("work.convertHint", locale)}</p>
                <form action={convertToJobCard}>
                  <input type="hidden" name="id" value={wr.id} />
                  <SubmitButton variant="secondary" size="sm" leftIcon={<JobCardsIcon className="text-base" />}>
                    {t("work.convertToJobCard", locale)}
                  </SubmitButton>
                </form>
              </>
            ) : (
              <p className="text-sm text-sand-400">{t("work.none", locale)}</p>
            )}
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}
