import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { telHref, waHref, mailtoHref } from "@/lib/contact";
import { typeLabel } from "@/lib/machine-options";
import {
  WORK_STATUSES, workStatusLabel, workKindLabel, workStatusTone, workStatusStep,
  workPriorityLabel, workPriorityTone,
} from "@/lib/work";
import { WorkRequestMedia } from "@/components/work-request-media";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import {
  ChevronLeftIcon, PhoneIcon, ChatIcon, MailIcon, JobCardsIcon, MachinesIcon,
} from "@/components/ui/icons";
import {
  updateWorkRequestStatus, addWorkRequestNote, setWorkRequestQuote,
  setWorkRequestInvoice, convertToJobCard,
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
  const locale = profile.language;
  const canWork = ["owner", "manager", "mechanic", "workshop"].includes(profile.role);

  const supabase = await createClient();
  const { data } = await supabase
    .from("work_requests")
    .select("id, farm_id, machine_id, workshop_id, kind, status, priority, title, description, quote_amount_cents, invoice_amount_cents, vat_rate_bps, job_card_id, created_at, updated_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const wr = data as WorkRequest | null;
  if (!wr) notFound();

  const [machineRes, wsRes, evRes, attRes, userRes] = await Promise.all([
    supabase.from("machines").select("id, name, type, meter_type, current_reading, status").eq("id", wr.machine_id).maybeSingle(),
    wr.workshop_id ? supabase.from("workshops").select("id, name, kind, phone, whatsapp, email, area").eq("id", wr.workshop_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("work_request_events").select("id, from_status, to_status, note, by_user, created_at").eq("work_request_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("attachments").select("id, kind, storage_path, url, created_at").eq("parent_type", "work_request").eq("parent_id", id).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("users").select("id, name").is("deleted_at", null),
  ]);
  const machine = machineRes.data as Machine | null;
  const workshop = wsRes.data as Workshop | null;
  const events = (evRes.data as Event[] | null) ?? [];
  const attachments = (attRes.data as Attachment[] | null) ?? [];
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
  const inputCls = "rounded-lg border border-sand-300 px-3 py-2 text-sm";

  // Contextual quick-advance buttons (the select below covers every transition).
  const quicks: { status: string; label: string }[] = [];
  if (curStep < workStatusStep("viewed")) quicks.push({ status: "viewed", label: t("work.markViewed", locale) });
  if (wr.status === "quoted") quicks.push({ status: "accepted", label: t("work.acceptQuote", locale) });
  if (curStep >= workStatusStep("accepted") && curStep < workStatusStep("in_progress")) quicks.push({ status: "in_progress", label: t("work.startWork", locale) });
  if (curStep >= workStatusStep("in_progress") && curStep < workStatusStep("completed")) quicks.push({ status: "completed", label: t("work.markCompleted", locale) });
  if (!isClosed && curStep >= workStatusStep("completed")) quicks.push({ status: "closed", label: t("work.close", locale) });

  return (
    <div className="flex flex-col gap-4">
      <Link href="/work" className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-sm text-sand-500">
        <ChevronLeftIcon className="text-[1rem]" />
        {t("work.title", locale)}
      </Link>

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t(savedMsg[sp.saved] ?? "ui.saved", locale) : undefined} />

      {/* Header: request + status */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-sand-900">
                {wr.title || workKindLabel(wr.kind, locale)}
              </h1>
              <Badge tone={workStatusTone(wr.status)}>{workStatusLabel(wr.status, locale)}</Badge>
              {wr.priority !== "normal" ? <Badge tone={workPriorityTone(wr.priority)}>{workPriorityLabel(wr.priority, locale)}</Badge> : null}
            </div>
            <p className="mt-1 text-sm text-sand-500">
              {workKindLabel(wr.kind, locale)} · {t("work.created", locale)} {wr.created_at.slice(0, 10)}
            </p>
            {wr.description ? <p className="mt-2 text-sm text-sand-700">{wr.description}</p> : null}
          </div>
        </div>

        {/* Lifecycle stepper */}
        <div className="mt-4 overflow-x-auto">
          <ol className="flex min-w-max items-center gap-1 text-xs">
            {WORK_STATUSES.map((st, i) => {
              const done = i < curStep;
              const active = i === curStep;
              return (
                <li key={st} className="flex items-center gap-1">
                  <span
                    className={`whitespace-nowrap rounded-full px-2.5 py-1 font-medium ${
                      active ? "bg-brand-600 text-white" : done ? "bg-brand-100 text-brand-700" : "bg-sand-100 text-sand-400"
                    }`}
                  >
                    {workStatusLabel(st, locale)}
                  </span>
                  {i < WORK_STATUSES.length - 1 ? <span className="text-sand-300">›</span> : null}
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
              <Link href={`/machines/${machine.id}`} className="focus-ring flex items-center gap-3 rounded-lg ring-2 ring-brand-200 bg-brand-50/40 p-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white text-[1.4rem] text-brand-700 ring-1 ring-sand-200">
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

          {/* Status + progress (crew + contractor) */}
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
              <form action={updateWorkRequestStatus} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="id" value={wr.id} />
                <Field label={t("work.status", locale)} htmlFor="status">
                  <Select id="status" name="status" defaultValue={wr.status}>
                    {WORK_STATUSES.map((st) => (
                      <option key={st} value={st}>{workStatusLabel(st, locale)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("work.note", locale)} htmlFor="status_note" className="flex-1">
                  <Input id="status_note" name="note" placeholder={t("work.notePlaceholder", locale)} />
                </Field>
                <SubmitButton variant="primary" size="sm">{t("work.update", locale)}</SubmitButton>
              </form>

              {/* Progress note (no status change) */}
              <form action={addWorkRequestNote} className="mt-3 flex flex-wrap items-end gap-2 border-t border-sand-100 pt-3">
                <input type="hidden" name="id" value={wr.id} />
                <Field label={t("work.addNote", locale)} htmlFor="progress_note" className="flex-1">
                  <Input id="progress_note" name="note" placeholder={t("work.notePlaceholder", locale)} />
                </Field>
                <SubmitButton variant="secondary" size="sm">{t("work.addNote", locale)}</SubmitButton>
              </form>
            </Card>
          ) : null}

          {/* Quote / invoice + proof upload */}
          {canWork ? (
            <Card>
              <CardHeader><CardTitle>{t("work.quoteInvoice", locale)}</CardTitle></CardHeader>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-sand-400">{t("work.quote", locale)}</p>
                  <p className="mt-0.5 text-lg font-bold tabular-nums text-sand-900">
                    {wr.quote_amount_cents != null ? rands(wr.quote_amount_cents) : "—"}
                  </p>
                  <form action={setWorkRequestQuote} className="mt-2 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="id" value={wr.id} />
                    <input name="amount" inputMode="decimal" placeholder="R" className={`${inputCls} w-28`} />
                    <label className="flex items-center gap-1 text-xs text-sand-600">
                      <input type="checkbox" name="incl_vat" value="1" className="h-4 w-4 rounded border-sand-300" /> {t("work.inclVat", locale)}
                    </label>
                    <SubmitButton variant="secondary" size="sm">{t("work.recordQuote", locale)}</SubmitButton>
                  </form>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-sand-400">{t("work.invoice", locale)}</p>
                  <p className="mt-0.5 text-lg font-bold tabular-nums text-sand-900">
                    {wr.invoice_amount_cents != null ? rands(wr.invoice_amount_cents) : "—"}
                  </p>
                  <p className="text-xs text-sand-400">{t("work.invoiceToTco", locale)}</p>
                  <form action={setWorkRequestInvoice} className="mt-2 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="id" value={wr.id} />
                    <input name="amount" inputMode="decimal" placeholder="R" className={`${inputCls} w-28`} />
                    <label className="flex items-center gap-1 text-xs text-sand-600">
                      <input type="checkbox" name="incl_vat" value="1" className="h-4 w-4 rounded border-sand-300" /> {t("work.inclVat", locale)}
                    </label>
                    <SubmitButton variant="primary" size="sm">{t("work.recordInvoice", locale)}</SubmitButton>
                  </form>
                </div>
              </div>
              <div className="mt-4 border-t border-sand-100 pt-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-sand-400">{t("work.uploadProof", locale)}</p>
                <WorkRequestMedia workRequestId={wr.id} locale={locale} />
              </div>
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
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={url} alt={t(`attachmentKind.${a.kind}`, locale)} className="h-full w-full object-cover" />
                            ) : (
                              <span className="text-sm font-medium text-brand-700">{t(`attachmentKind.${a.kind}`, locale)}</span>
                            )}
                          </div>
                          <p className="px-2 py-1 text-xs text-sand-500">{t(`attachmentKind.${a.kind}`, locale)} · {a.created_at.slice(0, 10)}</p>
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
                        <span className="shrink-0 text-xs tabular-nums text-sand-400">{e.created_at.slice(0, 10)}</span>
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
                      <PhoneIcon className="text-[1.05rem]" /> {t("contact.call", locale)}
                    </a>
                  ) : null}
                  {waHref(workshop.whatsapp ?? workshop.phone, t("contact.waPrefill", locale)) ? (
                    <a href={waHref(workshop.whatsapp ?? workshop.phone, t("contact.waPrefill", locale))!} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                      <ChatIcon className="text-[1.05rem]" /> {t("contact.whatsapp", locale)}
                    </a>
                  ) : null}
                  {mailtoHref(workshop.email) ? (
                    <a href={mailtoHref(workshop.email)!} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                      <MailIcon className="text-[1.05rem]" /> {t("contact.email", locale)}
                    </a>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="text-sm text-sand-500">{t("work.unassigned", locale)}</p>
            )}
          </Card>

          {/* Link to maintenance */}
          <Card>
            <CardHeader><CardTitle>{t("work.jobCard", locale)}</CardTitle></CardHeader>
            {wr.job_card_id ? (
              <Link href={`/jobcards/${wr.job_card_id}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                <JobCardsIcon className="text-[1.05rem]" /> {t("work.openJobCard", locale)}
              </Link>
            ) : canWork ? (
              <>
                <p className="mb-2 text-sm text-sand-500">{t("work.convertHint", locale)}</p>
                <form action={convertToJobCard}>
                  <input type="hidden" name="id" value={wr.id} />
                  <SubmitButton variant="secondary" size="sm" leftIcon={<JobCardsIcon className="text-[1.05rem]" />}>
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
    </div>
  );
}
