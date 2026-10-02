import Link from "next/link";
import type { ReactNode } from "react";
import { errorMessage } from "@/lib/errors";
import { Photo } from "@/components/ui/photo";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { notFound } from "next/navigation";
import { requireProfile, effectiveFarmRole, checkWorkshopEntitlement } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { telHref, waHref, mailtoHref } from "@/lib/contact";
import { workStatusLabel, workKindLabel, workPriorityLabel, workPriorityTone } from "@/lib/work";
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
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { DialogActions, DialogForm } from "@/components/ui/dialog-form";
import { Flash } from "@/components/ui/flash";
import { buttonVariants } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { ActionMenu } from "@/components/ui/action-menu";
import { menuItemClass } from "@/components/ui/menu-item";
import { Fact, FactList } from "@/components/ui/facts";
import { Stepper } from "@/components/ui/stepper";
import { PhoneIcon, ChatIcon, MailIcon, JobCardsIcon } from "@/components/ui/icons";
import { WorkStatus } from "@/components/ui/status";
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

/** Eight statuses, six steps a person recognises: viewed is still "requested". */
const STEP_OF: Record<string, number> = { requested: 0, viewed: 0, quoted: 1, accepted: 2, in_progress: 3, completed: 4, invoiced: 4, closed: 5 };

/**
 * One work request, between a farm and its contractor.
 *
 * It used to open with a sideways-scrolling strip of eight status chips, a vehicle card
 * inside a card, and a "Next step" paragraph explaining the general rules of quoting. Now
 * it says where the request is, what THIS person does next, and states the money. The
 * transitions, permissions and document rules are exactly the ones in work-lifecycle.ts.
 */
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

  const [machineRes, wsRes, evRes, attRes, userRes, docRes, providerRes, farmRes] = await Promise.all([
    supabase.from("machines").select("id, name, type, meter_type, current_reading, status").eq("id", wr.machine_id).maybeSingle(),
    wr.workshop_id ? supabase.from("workshops").select("id, name, kind, phone, whatsapp, email, area").eq("id", wr.workshop_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("work_request_events").select("id, from_status, to_status, note, by_user, created_at").eq("work_request_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("attachments").select("id, kind, storage_path, url, created_at").eq("parent_type", "work_request").eq("parent_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("users").select("id, name").is("deleted_at", null),
    supabase.from("partner_documents").select("id, kind, status, number, total_cents").eq("work_request_id", id).is("deleted_at", null).neq("status", "void").order("created_at", { ascending: false }),
    !wr.workshop_id && canApprove ? supabase.from("workshop_links").select("workshop_id, workshops(id, name)").eq("farm_id", wr.farm_id).eq("status", "active").is("deleted_at", null) : Promise.resolve({ data: [] }),
    isProvider ? supabase.from("farms").select("name").eq("id", wr.farm_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const machine = machineRes.data as Machine | null;
  const workshop = wsRes.data as Workshop | null;
  const events = (evRes.data as Event[] | null) ?? [];
  const attachments = (attRes.data as Attachment[] | null) ?? [];
  const documents = (docRes.data ?? []) as { id: string; kind: string; status: string; number: string; total_cents: number }[];
  const providers = ((providerRes.data ?? []) as unknown as { workshop_id: string; workshops: { id: string; name: string } | { id: string; name: string }[] | null }[])
    .map((link) => Array.isArray(link.workshops) ? link.workshops[0] : link.workshops).filter((item): item is { id: string; name: string } => !!item);
  const userName = new Map(((userRes.data as { id: string; name: string }[] | null) ?? []).map((u) => [u.id, u.name]));
  const farmName = (farmRes.data as { name: string } | null)?.name ?? null;

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
  const canCreateDocument = canBuildDocuments && (canQuote || canInvoice)
    && !documents.some((doc) => doc.kind === (canInvoice ? "invoice" : "quote") && !["declined", "cancelled", "expired"].includes(doc.status));
  const canFileSupplied = !!wr.workshop_id && (canApprove || isProvider) && ["requested", "viewed", "quoted", "completed", "invoiced"].includes(wr.status);
  const canConvert = !wr.job_card_id && canConvertWorkRequest(wr.status, resourceRole, !!wr.workshop_id);
  const canAssign = !wr.workshop_id && canApprove && wr.status === "requested" && providers.length > 0;

  // One sentence, for this person, about what happens next.
  const nextKey = isClosed ? "closed"
    : !wr.workshop_id ? (canApprove ? "assign" : "follow")
      : ["requested", "viewed"].includes(wr.status) ? (isProvider ? "providerQuote" : canApprove ? "farmApprove" : "follow")
        : wr.status === "quoted" ? (canApprove ? "farmQuote" : isProvider ? "waitFarm" : "follow")
          : ["accepted", "in_progress"].includes(wr.status) ? (isProvider ? "providerWork" : "farmWorking")
            : wr.status === "completed" ? (isProvider ? "providerInvoice" : "farmCompleted")
              : canApprove ? "farmClose" : isProvider ? "providerWaitClose" : "follow";

  const steps = ["requested", "quoted", "agreed", "working", "done", "closed"].map((s) => t(`workview.steps.${s}`, locale));
  const step = STEP_OF[wr.status] ?? 0;
  const kind = workKindLabel(wr.kind, locale);
  const counterpart = isProvider ? farmName : workshop?.name ?? t("work.unassigned", locale);
  const title = machine?.name ?? wr.title ?? kind;

  const amountDialog = (which: "quote" | "invoice", look: "button" | "menuItem") => (
    <DialogForm
      key={`amount-${which}`}
      trigger={t(which === "quote" ? "work.recordIssuedQuote" : "work.recordIssuedInvoice", locale)}
      title={t(which === "quote" ? "work.recordIssuedQuote" : "work.recordIssuedInvoice", locale)}
      description={which === "invoice" ? t("work.zeroInvoiceHint", locale) : title}
      triggerLook={look} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel} size="md"
    >
      <form action={which === "quote" ? setWorkRequestQuote : setWorkRequestInvoice} className="flex flex-col gap-3">
        <input type="hidden" name="id" value={wr.id} />
        <Field label={t(which === "quote" ? "work.quoteAmountLabel" : "work.invoiceAmountLabel", locale)} htmlFor={`${which}_amount`} hint={t("work.amountHint", locale)}>
          <Input id={`${which}_amount`} name="amount" inputMode="decimal" required />
        </Field>
        <Checkbox name="incl_vat" value="1" label={t("work.inclVat", locale)} />
        <DialogActions cancelLabel={cancelLabel}>
          <SubmitButton variant="primary">{t(which === "quote" ? "work.recordQuote" : "work.recordInvoice", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  // The ways to put a quote or invoice on this request, the preferred one first.
  type Look = "button" | "menuItem";
  const moneyActions: ((look: Look) => ReactNode)[] = [
    ...(canCreateDocument ? [(look: Look) => (
      <form key="create" action={createDocument}>
        <input type="hidden" name="farm_id" value={wr.farm_id} />
        <input type="hidden" name="machine_id" value={wr.machine_id} />
        <input type="hidden" name="work_request_id" value={wr.id} />
        <input type="hidden" name="kind" value={canInvoice ? "invoice" : "quote"} />
        <input type="hidden" name="subject" value={wr.title || kind} />
        <SubmitButton variant="secondary" size="sm" look={look}>{t(canInvoice ? "work.createInvoice" : "work.createQuote", locale)}</SubmitButton>
      </form>
    )] : []),
    ...(amountKinds.includes("quote") ? [(look: Look) => amountDialog("quote", look)] : []),
    ...(amountKinds.includes("invoice") ? [(look: Look) => amountDialog("invoice", look)] : []),
    ...(canFileSupplied ? [(look: Look) => (
      <DialogForm key="file" trigger={t("work.fileSupplierDocument", locale)} title={t("work.fileSupplierDocument", locale)} description={title} triggerLook={look} triggerVariant="secondary" triggerSize="sm" closeLabel={closeLabel}>
        <UploadDocument locale={locale} actorId={profile.id} isPartner={isProvider}
          parties={[{ id: wr.workshop_id!, name: workshop?.name ?? "" }]}
          work={{ id: wr.id, farmId: wr.farm_id, machineId: wr.machine_id, workshopId: wr.workshop_id!,
            kind: ["completed", "invoiced"].includes(wr.status) ? "invoice" : "quote" }} />
      </DialogForm>
    )] : []),
  ];

  return (
    <PageContainer>
      <IntakeAcknowledgement actorId={profile.id} />
      <PageHeader
        back={{ href: "/work", label: t("work.title", locale) }}
        title={title}
        meta={<>{kind}{wr.title && machine ? ` · ${wr.title}` : ""}{counterpart ? ` · ${counterpart}` : ""} · {t("workview.requestedOn", locale).replace("{date}", shortDate(wr.created_at, locale))}</>}
        badge={<><WorkStatus value={wr.status} locale={locale} />{wr.priority !== "normal" ? <Badge tone={workPriorityTone(wr.priority)}>{workPriorityLabel(wr.priority, locale)}</Badge> : null}</>}
        menu={
          <ActionMenu title={title} label={t("nav.more", locale)} closeLabel={closeLabel} trigger={t("nav.more", locale)}>
            {canAssign ? (
              <DialogForm trigger={t("work.assignProvider", locale)} triggerLook="menuItem" title={t("work.assignProvider", locale)} description={title} closeLabel={closeLabel} size="md">
                <form action={assignWorkRequestProvider} className="flex flex-col gap-3">
                  <input type="hidden" name="id" value={wr.id} />
                  <Field label={t("work.contractor", locale)} htmlFor="assign_provider">
                    <Select id="assign_provider" name="workshop_id" required>
                      {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                    </Select>
                  </Field>
                  <DialogActions cancelLabel={cancelLabel}><SubmitButton variant="primary">{t("work.assignProvider", locale)}</SubmitButton></DialogActions>
                </form>
              </DialogForm>
            ) : null}
            {canWork && !isClosed ? (
              <DialogForm trigger={t("work.addNote", locale)} triggerLook="menuItem" title={t("work.addNote", locale)} description={title} closeLabel={closeLabel} size="md">
                <form action={addWorkRequestNote} className="flex flex-col gap-3">
                  <input type="hidden" name="id" value={wr.id} />
                  <Field label={t("work.addNote", locale)} htmlFor="progress_note">
                    <Input id="progress_note" name="note" placeholder={t("work.notePlaceholder", locale)} required />
                  </Field>
                  <DialogActions cancelLabel={cancelLabel}><SubmitButton variant="primary">{t("work.addNote", locale)}</SubmitButton></DialogActions>
                </form>
              </DialogForm>
            ) : null}
            {canWork && !isClosed ? (
              <DialogForm trigger={t("work.uploadProof", locale)} triggerLook="menuItem" title={t("work.uploadProof", locale)} description={title} closeLabel={closeLabel} size="md">
                <WorkRequestMedia workRequestId={wr.id} locale={locale} allowedKinds={["photo"]} />
              </DialogForm>
            ) : null}
            {wr.job_card_id ? <Link href={`/jobcards/${wr.job_card_id}`} className={menuItemClass()}>{t("work.openJobCard", locale)}</Link> : null}
            <Link href={`/machines/${wr.machine_id}`} className={menuItemClass()}>{t("jobcards.openMachine", locale)}</Link>
          </ActionMenu>
        }
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t(savedMsg[sp.saved] ?? "ui.saved", locale) : undefined} />

      {/* Where it is, and what to do next. */}
      <Card className="flex flex-col gap-4">
        <Stepper steps={steps} current={step} label={t("workview.progress", locale)}
          progressLabel={t("jobview.stepOf", locale).replace("{n}", String(step + 1)).replace("{total}", String(steps.length))} />
        <p className="text-base text-sand-900">{t(`workview.next.${nextKey}`, locale)}</p>
        {(canWork && quicks.length > 0) || canConvert || wr.job_card_id ? (
          <div className="flex flex-wrap items-center gap-2">
            {canWork ? quicks.map((qk, i) => (
              <form action={updateWorkRequestStatus} key={qk.status}>
                <input type="hidden" name="id" value={wr.id} />
                <input type="hidden" name="status" value={qk.status} />
                <SubmitButton variant={i === 0 ? "primary" : "secondary"}>{qk.label}</SubmitButton>
              </form>
            )) : null}
            {canConvert ? (
              <form action={convertToJobCard}>
                <input type="hidden" name="id" value={wr.id} />
                <SubmitButton variant={canWork && quicks.length > 0 ? "secondary" : "primary"} leftIcon={<JobCardsIcon className="text-base" />}>{t("work.convertToJobCard", locale)}</SubmitButton>
              </form>
            ) : null}
            {wr.job_card_id && !isClosed ? (
              <Link href={`/jobcards/${wr.job_card_id}`} className={buttonVariants({ variant: canWork && quicks.length > 0 ? "secondary" : "primary" })}>
                <JobCardsIcon className="text-base" /> {t("work.openJobCard", locale)}
              </Link>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* The request itself, and who it is with. */}
      <Card>
        <CardHeader><CardTitle>{t("workview.section.request", locale)}</CardTitle></CardHeader>
        <p className="whitespace-pre-wrap text-sm text-sand-900">{wr.description?.trim() ? wr.description : <span className="text-sand-500">{t("workview.noDescription", locale)}</span>}</p>
        <FactList className="mt-2">
          {isProvider ? (farmName ? <Fact label={t("workview.farm", locale)} value={farmName} /> : null) : (
            <Fact label={t("work.contractor", locale)} value={workshop ? <>{workshop.name}{workshop.area ? <span className="block text-xs font-normal text-sand-500">{workshop.area}</span> : null}</> : t("work.unassigned", locale)} muted={!workshop} />
          )}
          <Fact label={t("workview.steps.requested", locale)} value={shortDate(wr.created_at, locale)} />
        </FactList>
        {!isProvider && workshop ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {telHref(workshop.phone) ? <a href={telHref(workshop.phone)!} className={buttonVariants({ variant: "secondary", size: "sm" })}><PhoneIcon className="text-base" /> {t("contact.call", locale)}</a> : null}
            {waHref(workshop.whatsapp ?? workshop.phone, t("contact.waPrefill", locale)) ? <a href={waHref(workshop.whatsapp ?? workshop.phone, t("contact.waPrefill", locale))!} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}><ChatIcon className="text-base" /> {t("contact.whatsapp", locale)}</a> : null}
            {mailtoHref(workshop.email) ? <a href={mailtoHref(workshop.email)!} className={buttonVariants({ variant: "secondary", size: "sm" })}><MailIcon className="text-base" /> {t("contact.email", locale)}</a> : null}
          </div>
        ) : null}
      </Card>

      {/* Money, stated. Documents the contractor issued are links. */}
      {canWork ? (
        <Card>
          <CardHeader><CardTitle>{t("workview.section.money", locale)}</CardTitle></CardHeader>
          <FactList>
            <Fact label={t("work.quote", locale)} value={wr.quote_amount_cents != null ? rands(wr.quote_amount_cents) : t("workview.noneYet", locale)} muted={wr.quote_amount_cents == null} />
            <Fact label={t("work.invoice", locale)} value={wr.invoice_amount_cents != null ? rands(wr.invoice_amount_cents) : t("workview.noneYet", locale)} muted={wr.invoice_amount_cents == null} />
          </FactList>
          {documents.length ? (
            <ul className="mt-2 flex flex-col gap-2">
              {documents.map((doc) => (
                <li key={doc.id}>
                  <Link href={`/documents/${doc.id}`} className="focus-ring flex min-h-[48px] items-center justify-between gap-3 rounded-lg border border-sand-200 px-3 text-sm hover:bg-sand-50">
                    <span>{doc.number} · {t(`docStatus.${doc.status}`, locale)}</span>
                    <span className="font-semibold tabular-nums">{rands(doc.total_cents)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          {moneyActions.length > 0 ? (
            // The preferred way is a button; the other ways wait behind one menu.
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {moneyActions[0]("button")}
              {moneyActions.length > 1 ? (
                <ActionMenu title={t("workview.section.money", locale)} label={t("workview.otherWays", locale)} closeLabel={closeLabel} trigger={t("workview.otherWays", locale)}>
                  {moneyActions.slice(1).map((render) => render("menuItem"))}
                </ActionMenu>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      {attachments.length > 0 ? (
        <Disclosure summary={t("work.attachments", locale)} meta={String(attachments.length)}>
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
                      <p className="px-2 py-1 text-xs text-sand-500">{t(`attachmentKind.${a.kind}`, locale)} · {shortDate(a.created_at, locale)}</p>
                    </a>
                  ) : (
                    <div className="p-2 text-xs text-sand-400">{t(`attachmentKind.${a.kind}`, locale)}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Disclosure>
      ) : null}

      {events.length > 0 ? (
        <Disclosure summary={t("work.timeline", locale)} meta={String(events.length)}>
          <ol className="flex flex-col">
            {events.map((e) => (
              <li key={e.id} className="flex gap-3 border-b border-sand-100 py-2.5 last:border-0">
                <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-sand-900">
                      {e.from_status && e.from_status !== e.to_status
                        ? `${workStatusLabel(e.from_status, locale)} → ${workStatusLabel(e.to_status, locale)}`
                        : workStatusLabel(e.to_status, locale)}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-sand-500">{shortDate(e.created_at, locale)}</span>
                  </div>
                  {e.note ? <p className="text-sm text-sand-600">{e.note}</p> : null}
                  {e.by_user ? <p className="text-xs text-sand-500">{userName.get(e.by_user) ?? ""}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        </Disclosure>
      ) : null}
    </PageContainer>
  );
}
