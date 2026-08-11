import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireProfile, currentWorkshop, homePathFor } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { CorrectionPanel, type CreditNoteRef } from "@/components/documents/correction-panel";
import { EmailDocument, type EmailAttempt } from "@/components/documents/email-document";
import { ReviseDocument } from "@/components/documents/revise-document";
import { RevisionHistory, type Revision } from "@/components/documents/revision-history";
import { shortDate, vatPercent } from "@/lib/format";
import { workshopPlanAllows } from "@/lib/contractor-plan";
import { brandingFrom, brandingOf, onBrand } from "@/lib/branding";
import { signedBrandingUrl, signedDocUrl } from "@/lib/partner-media";
import { balanceDueCents, isEditable, type BillTo, type DocKind, type DocStatus, type DocSource, type DocLine } from "@/lib/partner-docs";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, TextField, TextareaField, SelectField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button, buttonVariants } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { Badge } from "@/components/ui/badge";
import { DocStatus as DocStatusBadge } from "@/components/ui/status";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrashIcon, DownloadIcon } from "@/components/ui/icons";
import {
  addDocumentLine, removeDocumentLine, updateDocument, sendDocument,
  convertQuoteToInvoice, acceptDocument, declineDocument, recordPayment,
  removePayment, deleteDraft, recordRefund,
} from "../actions";
import { DeclineQuote } from "@/components/partner/decline-quote";

/**
 * One quote or invoice, as both sides see it (F14c/F14d).
 *
 * The document itself renders identically for the partner and the farmer — same
 * letterhead, same lines, same totals — because a disagreement about what was sent is
 * the one thing a system like this must never cause. What differs is the row of actions
 * beneath it: the partner edits a draft, sends, converts and cancels; the farmer accepts,
 * declines and pays.
 *
 * RLS decides visibility; this page only decides what to offer.
 */

type Doc = BillTo & {
  id: string; farm_id: string | null; partner_client_id: string | null;
  corrects_document_id: string | null; void_reason: string | null; revision: number;
  written_off_reason: string | null;
  workshop_id: string; machine_id: string | null;
  work_request_id: string | null; quote_id: string | null;
  kind: DocKind; status: DocStatus; source: DocSource; number: string; subject: string | null;
  issue_date: string; due_date: string | null;
  subtotal_cents: number; discount_cents: number; vat_cents: number; total_cents: number;
  vat_rate_bps: number; amount_paid_cents: number;
  notes: string | null; terms: string | null; declined_reason: string | null;
  upload_path: string | null; issuer_snapshot: Record<string, unknown> | null;
  sent_at: string | null;
};

type Payment = {
  id: string; amount_cents: number; paid_on: string; method: string | null;
  reference: string | null; note: string | null; is_refund: boolean;
};

/**
 * The codes the server actions redirect with, said as sentences. Anything else — a raw
 * Postgres message from a trigger — still comes through, because a partner seeing the
 * database's own words beats a screen that says nothing happened when something did.
 */
const DOC_ERRORS: Record<string, string> = {
  upgrade: "doc.upgradeNeeded",
  "refund-too-big": "doc.refundTooBig",
  "writeoff-reason": "correct.writeOffReasonMissing",
  "revise-reason": "revise.reasonMissing",
  "revise-empty": "revise.emptyDocument",
  "need-amount": "doc.needAmount",
};

function docError(code: string | undefined, locale: Lang): string | undefined {
  if (!code) return undefined;
  return DOC_ERRORS[code] ? t(DOC_ERRORS[code], locale) : code;
}

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  if (profile.role === "operator") redirect(`${homePathFor(profile.role)}?denied=1`);
  const locale = profile.lang;
  const { id } = await params;
  const sp = await searchParams;

  const supabase = await createClient();
  const { data } = await supabase
    .from("partner_documents")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const doc = data as Doc | null;
  if (!doc) notFound();

  const [
    { data: lineData }, { data: payData }, { data: farmData }, { data: shopData },
    { data: machineData }, { data: creditData }, { data: emailData }, { data: revisionData },
  ] = await Promise.all([
      supabase
        .from("partner_document_lines")
        .select("id, sort_order, kind, part_no, description, qty, unit_price_cents, discount_cents, line_total_cents")
        .eq("document_id", id)
        .is("deleted_at", null)
        .order("sort_order"),
      supabase
        .from("partner_payments")
        .select("id, amount_cents, paid_on, method, reference, note, is_refund")
        .eq("document_id", id)
        .is("deleted_at", null)
        .order("paid_on", { ascending: false }),
      doc.farm_id
        ? supabase.from("farms").select("id, name").eq("id", doc.farm_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from("workshops").select("id, name, trading_name, phone, whatsapp, email").eq("id", doc.workshop_id).maybeSingle(),
      doc.machine_id
        ? supabase.from("machines").select("id, name, reg_no").eq("id", doc.machine_id).maybeSingle()
        : Promise.resolve({ data: null }),
      // Credit notes raised against this invoice, and what we have emailed. Both read
      // through RLS, so a farmer sees the corrections to their own invoice and a partner
      // sees theirs.
      supabase
        .from("partner_documents")
        .select("id, number, total_cents, status")
        .eq("corrects_document_id", id)
        .is("deleted_at", null)
        .order("issue_date"),
      supabase
        .from("document_emails")
        .select("id, to_email, status, error, created_at")
        .eq("document_id", id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(10),
      // Every earlier version. Read through RLS, so the customer sees how an invoice they
      // were sent has changed — which is the other half of allowing it to change at all.
      supabase
        .from("partner_document_revisions")
        .select("id, version, reason, total_cents_before, total_cents_after, edited_at, snapshot, edited_by")
        .eq("document_id", id)
        .order("version", { ascending: false }),
    ]);

  const lines = (lineData ?? []) as DocLine[];
  const payments = (payData ?? []) as Payment[];
  const farm = farmData as { id: string; name: string } | null;
  const shop = shopData as { id: string; name: string; trading_name: string | null; phone: string | null; whatsapp: string | null; email: string | null } | null;
  const machine = machineData as { id: string; name: string; reg_no: string | null } | null;
  const creditNotes = (creditData ?? []) as CreditNoteRef[];
  const emailHistory = (emailData ?? []) as EmailAttempt[];

  // Name the editor where we can. One extra query, only when there is history to show.
  const revisionRows = (revisionData ?? []) as (Omit<Revision, "editor_name"> & { edited_by: string | null })[];
  const editorIds = [...new Set(revisionRows.map((r) => r.edited_by).filter((v): v is string => !!v))];
  const editorName = new Map<string, string>();
  if (editorIds.length > 0) {
    const { data: editors } = await supabase.from("users").select("id, name").in("id", editorIds);
    for (const u of (editors ?? []) as { id: string; name: string }[]) editorName.set(u.id, u.name);
  }
  const revisions: Revision[] = revisionRows.map((r) => ({
    ...r,
    editor_name: r.edited_by ? (editorName.get(r.edited_by) ?? null) : null,
  }));

  const isPartner = profile.role === "workshop";
  const isFarmDecider = profile.role === "owner" || profile.role === "manager";
  const { workshop, plan } = await currentWorkshop(profile);
  const canBuild = isPartner && plan != null && workshopPlanAllows(plan, "build_documents");
  const canPay = !isPartner || (plan != null && workshopPlanAllows(plan, "record_payments"));

  // The letterhead frozen at send time, falling back to the partner's current one for a
  // draft (which has no snapshot yet).
  const brand = brandingOf(
    doc.issuer_snapshot as never,
    brandingFrom(isPartner ? workshop : { id: shop?.id ?? "", name: shop?.name ?? "", trading_name: shop?.trading_name }),
  );
  const logoUrl = await signedBrandingUrl(brand.logo_path ?? null);
  const fileUrl = await signedDocUrl(doc.upload_path);

  const editable = isPartner && isEditable(doc) && canBuild;
  const balance = balanceDueCents(doc);
  /** Paid MORE than the invoice — usually because a credit note landed after payment. */
  const inCreditCents = Math.max(0, (doc.amount_paid_cents || 0) - doc.total_cents);
  const primary = brand.brand_primary ?? "#166534";
  const kindLabel = t(doc.kind === "invoice" ? "doc.kindInvoice" : "doc.kindQuote", locale);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/documents" className="focus-ring rounded text-sm text-brand-700 hover:underline">
          ← {t("doc.title", locale)}
        </Link>
        <DocStatusBadge value={doc.status} locale={locale} size="md" className="ml-auto" />
      </div>

      <Flash tone="error" message={docError(sp.error, locale)} />
      <Flash tone="success" message={sp.saved || sp.added || sp.paid ? t("ui.saved", locale) : undefined} />
      <Flash tone="success" message={sp.sent ? t("doc.sentFlash", locale) : undefined} />
      <Flash tone="success" message={sp.accepted ? t("doc.acceptedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.converted ? t("doc.convertedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.revised ? t("revise.savedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.refunded ? t("doc.refundedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.written_off ? t("doc.writtenOffFlash", locale) : undefined} />

      {/* ── The document ─────────────────────────────────────────── */}
      <article className="overflow-hidden rounded-xl border border-sand-200 bg-white shadow-soft print:border-0 print:shadow-none">
        <header className="flex flex-wrap items-center gap-3 px-4 py-4" style={{ backgroundColor: primary, color: onBrand(primary) }}>
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a signed Storage URL, not a static asset
            <img src={logoUrl} alt="" className="h-11 w-11 rounded bg-white/90 object-contain p-0.5" />
          ) : null}
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{brand.name}</p>
            <p className="truncate text-xs opacity-90">
              {[brand.reg_number, brand.vat_number ? `${t("partnerSettings.vatNo", locale)} ${brand.vat_number}` : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className="ml-auto text-right">
            <p className="text-xs font-semibold uppercase tracking-wide opacity-90">{kindLabel}</p>
            <p className="font-mono text-lg font-bold tabular-nums">{doc.number}</p>
          </div>
        </header>

        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          <div className="text-sm">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sand-500">{t("doc.billTo", locale)}</p>
            <p className="font-medium text-sand-900">{farm?.name}</p>
            {machine ? (
              <p className="text-sand-600">
                {machine.name}
                {machine.reg_no ? ` · ${machine.reg_no}` : ""}
              </p>
            ) : null}
            {doc.subject ? <p className="mt-1 text-sand-700">{doc.subject}</p> : null}
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:text-right">
            <dt className="text-sand-500">{t("doc.issued", locale)}</dt>
            <dd className="tabular-nums text-sand-800">{shortDate(doc.issue_date, locale)}</dd>
            {doc.due_date ? (
              <>
                <dt className="text-sand-500">{t(doc.kind === "quote" ? "doc.validUntil" : "doc.dueBy", locale)}</dt>
                <dd className="tabular-nums text-sand-800">{shortDate(doc.due_date, locale)}</dd>
              </>
            ) : null}
          </dl>
        </div>

        {/* Lines — or, for an uploaded document, the file itself. */}
        {doc.source === "uploaded" ? (
          <div className="border-t border-sand-100 px-4 py-4">
            <p className="text-sm text-sand-600">{t("doc.uploadedBody", locale)}</p>
            {fileUrl ? (
              <a href={fileUrl} target="_blank" rel="noreferrer" className={`${buttonVariants({ variant: "secondary", size: "sm" })} mt-3`}>
                <DownloadIcon /> {t("doc.openFile", locale)}
              </a>
            ) : null}
          </div>
        ) : lines.length > 0 ? (
          <div className="overflow-x-auto border-t border-sand-100">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b border-sand-100 text-left text-xs uppercase tracking-wide text-sand-500">
                  <th className="px-4 py-2 font-semibold">{t("doc.lineDescription", locale)}</th>
                  <th className="px-2 py-2 text-right font-semibold">{t("doc.lineQty", locale)}</th>
                  <th className="px-2 py-2 text-right font-semibold">{t("doc.lineUnit", locale)}</th>
                  <th className="px-4 py-2 text-right font-semibold">{t("doc.lineTotal", locale)}</th>
                  {editable ? <th className="px-2 py-2"><span className="sr-only">{t("common.remove", locale)}</span></th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-50">
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-2">
                      <span className="text-sand-900">{l.description}</span>
                      {l.part_no ? <span className="block text-xs text-sand-500">{l.part_no}</span> : null}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-sand-700">{l.qty}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-sand-700">{rands(l.unit_price_cents)}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-sand-900">{rands(l.line_total_cents)}</td>
                    {editable ? (
                      <td className="px-2 py-2 text-right">
                        <ConfirmDialog
                          action={removeDocumentLine}
                          triggerLabel={t("common.remove", locale)}
                          triggerIcon={<TrashIcon />}
                          triggerVariant="ghost"
                          triggerSize="sm"
                          title={t("doc.removeLine", locale)}
                          intro={l.description}
                          confirmLabel={t("common.remove", locale)}
                          cancelLabel={t("common.cancel", locale)}
                          closeLabel={t("ui.close", locale)}
                        >
                          <input type="hidden" name="document_id" value={doc.id} />
                          <input type="hidden" name="line_id" value={l.id ?? ""} />
                        </ConfirmDialog>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="border-t border-sand-100 px-4 py-4 text-sm text-sand-500">{t("doc.noLines", locale)}</p>
        )}

        {/* Totals — ex-VAT, VAT, then the number the farmer actually pays. */}
        <div className="border-t border-sand-100 px-4 py-4">
          <dl className="ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm">
            <dt className="text-sand-500">{doc.vat_rate_bps > 0 ? t("doc.subtotal", locale) : t("doc.subtotalNoVat", locale)}</dt>
            <dd className="text-right tabular-nums text-sand-800">{rands(doc.subtotal_cents)}</dd>
            {doc.discount_cents > 0 ? (
              <>
                <dt className="text-sand-500">{t("doc.discount", locale)}</dt>
                <dd className="text-right tabular-nums text-sand-800">−{rands(doc.discount_cents)}</dd>
              </>
            ) : null}
            {/* A partner who is not VAT registered issues no VAT line at all — showing
                "VAT 0%" would still be a claim about tax they do not charge. */}
            {doc.vat_rate_bps > 0 ? (
              <>
                <dt className="text-sand-500">
                  {t("doc.vat", locale)} ({vatPercent(doc.vat_rate_bps)})
                </dt>
                <dd className="text-right tabular-nums text-sand-800">{rands(doc.vat_cents)}</dd>
              </>
            ) : null}
            <dt className="mt-1 border-t border-sand-200 pt-1 font-semibold text-sand-900">{t("doc.total", locale)}</dt>
            <dd className="mt-1 border-t border-sand-200 pt-1 text-right text-lg font-bold tabular-nums text-sand-900">
              {rands(doc.total_cents)}
            </dd>
            {doc.kind === "invoice" && doc.amount_paid_cents > 0 ? (
              <>
                <dt className="text-sand-500">{t("doc.paidSoFar", locale)}</dt>
                <dd className="text-right tabular-nums text-status-ok">−{rands(doc.amount_paid_cents)}</dd>
                <dt className="font-semibold text-sand-900">{t("doc.balanceDue", locale)}</dt>
                <dd className="text-right font-bold tabular-nums text-sand-900">{rands(balance)}</dd>
              </>
            ) : null}
          </dl>
        </div>

        {(doc.notes || brand.bank_name || doc.terms || brand.footer) && (
          <footer className="flex flex-col gap-3 border-t border-sand-100 bg-sand-50/60 px-4 py-4 text-sm">
            {doc.notes ? <p className="whitespace-pre-line text-sand-700">{doc.notes}</p> : null}
            {doc.kind === "invoice" && brand.bank_name ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sand-500">{t("doc.howToPay", locale)}</p>
                <p className="text-sand-700">
                  {[brand.bank_account_name, brand.bank_name, brand.bank_account_number, brand.bank_branch_code]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="text-sand-500">
                  {t("doc.useReference", locale)} <span className="font-mono font-medium text-sand-700">{doc.number}</span>
                </p>
              </div>
            ) : null}
            {doc.terms ? <p className="whitespace-pre-line text-xs text-sand-500">{doc.terms}</p> : null}
            {brand.footer ? <p className="text-xs text-sand-400">{brand.footer}</p> : null}
          </footer>
        )}
      </article>

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <a href={`/api/documents/${doc.id}/pdf`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <DownloadIcon /> {t("doc.downloadPdf", locale)}
        </a>
        {doc.work_request_id ? (
          <Link href={`/work/${doc.work_request_id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            {t("doc.viewWorkRequest", locale)}
          </Link>
        ) : null}
        {doc.quote_id ? (
          <Link href={`/documents/${doc.quote_id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            {t("doc.viewQuote", locale)}
          </Link>
        ) : null}
      </div>

      {/* ── The partner's workspace ───────────────────────────────── */}
      {editable ? (
        <>
          <Card>
            <CardHeader><CardTitle>{t("doc.addLine", locale)}</CardTitle></CardHeader>
            <form action={addDocumentLine} className="flex flex-col gap-3">
              <input type="hidden" name="document_id" value={doc.id} />
              <TextField name="description" label={t("doc.lineDescription", locale)} required />
              <div className="grid gap-3 sm:grid-cols-3">
                <SelectField name="kind" label={t("doc.lineKind", locale)} defaultValue="part">
                  <option value="part">{t("lineKind.part", locale)}</option>
                  <option value="labour">{t("lineKind.labour", locale)}</option>
                  <option value="other">{t("lineKind.other", locale)}</option>
                </SelectField>
                <TextField name="part_no" label={t("doc.linePartNo", locale)} />
                <TextField name="qty" type="number" step="0.01" min="0" label={t("doc.lineQty", locale)} defaultValue="1" />
              </div>
              <TextField name="unit_price" inputMode="decimal" label={t("doc.lineUnitRands", locale)} required />
              <label className="flex items-center gap-3 text-sm text-sand-700">
                <input type="checkbox" name="incl_vat" className="h-5 w-5 rounded border-sand-300 text-brand-600" />
                {t("doc.priceInclVat", locale)}
              </label>
              <SubmitButton>{t("doc.addLine", locale)}</SubmitButton>
            </form>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t("doc.details", locale)}</CardTitle></CardHeader>
            <form action={updateDocument} className="flex flex-col gap-3">
              <input type="hidden" name="document_id" value={doc.id} />
              <TextField name="subject" label={t("doc.newSubject", locale)} defaultValue={doc.subject ?? ""} />
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField name="issue_date" type="date" label={t("doc.issued", locale)} defaultValue={doc.issue_date} />
                <TextField
                  name="due_date"
                  type="date"
                  label={t(doc.kind === "quote" ? "doc.validUntil" : "doc.dueBy", locale)}
                  defaultValue={doc.due_date ?? ""}
                />
              </div>
              <TextField name="discount" inputMode="decimal" label={t("doc.discountRands", locale)} defaultValue={doc.discount_cents ? String(doc.discount_cents / 100) : ""} />
              <TextareaField name="notes" rows={3} label={t("doc.notes", locale)} hint={t("doc.notesHint", locale)} defaultValue={doc.notes ?? ""} />
              <TextareaField name="terms" rows={3} label={t("doc.terms", locale)} defaultValue={doc.terms ?? ""} />
              <SubmitButton variant="secondary">{t("common.save", locale)}</SubmitButton>
            </form>
          </Card>

          <div className="flex flex-wrap items-center gap-2">
            <form action={sendDocument}>
              <input type="hidden" name="document_id" value={doc.id} />
              <SubmitButton>{t(doc.kind === "quote" ? "doc.sendQuote" : "doc.sendInvoice", locale)}</SubmitButton>
            </form>
            <ConfirmDialog
              action={deleteDraft}
              triggerLabel={t("doc.deleteDraft", locale)}
              triggerIcon={<TrashIcon />}
              triggerVariant="ghost"
              triggerSize="sm"
              title={t("doc.deleteDraftTitle", locale)}
              intro={t("doc.deleteDraftBody", locale)}
              confirmLabel={t("doc.deleteDraft", locale)}
              cancelLabel={t("common.cancel", locale)}
              closeLabel={t("ui.close", locale)}
            >
              <input type="hidden" name="document_id" value={doc.id} />
            </ConfirmDialog>
          </div>
          <p className="text-sm text-sand-500">{t("doc.sendExplains", locale)}</p>
        </>
      ) : null}

      {isPartner && doc.status !== "draft" ? (
        <div className="flex flex-wrap items-center gap-2">
          {doc.kind === "quote" && doc.status === "accepted" && canBuild ? (
            <form action={convertQuoteToInvoice}>
              <input type="hidden" name="document_id" value={doc.id} />
              <SubmitButton>{t("doc.convertToInvoice", locale)}</SubmitButton>
            </form>
          ) : null}
        </div>
      ) : null}

      {/* Emailing it is the point of sending it — before this, "send" set a status and
          the customer had to log in to find out they had been invoiced. */}
      {doc.status !== "draft" ? (
        <EmailDocument
          documentId={doc.id}
          defaultTo={doc.bill_to_email ?? ""}
          customerName={doc.bill_to_name ?? ""}
          history={emailHistory}
          locale={locale}
        />
      ) : null}

      {/* Correcting it in place, keeping the version it replaced. Offered before the
          credit-note route because for a customer who pays off a monthly statement, one
          corrected line reads better than three lines that net to the same number. */}
      {isPartner && canBuild && doc.status !== "draft" && doc.status !== "void" && doc.source === "built" ? (
        <ReviseDocument
          documentId={doc.id}
          number={doc.number}
          lines={lines.map((l) => ({
            kind: l.kind,
            part_no: l.part_no,
            description: l.description,
            qty: l.qty,
            unit_price_cents: l.unit_price_cents,
          }))}
          vatRateBps={doc.vat_rate_bps}
          totalCents={doc.total_cents}
          amountPaidCents={doc.amount_paid_cents}
          revision={doc.revision ?? 1}
          locale={locale}
        />
      ) : null}

      <RevisionHistory revisions={revisions} locale={locale} />

      {isPartner ? (
        <CorrectionPanel
          doc={{
            id: doc.id,
            kind: doc.kind,
            status: doc.status,
            number: doc.number,
            total_cents: doc.total_cents,
            void_reason: doc.void_reason ?? null,
            written_off_reason: doc.written_off_reason ?? null,
            balance_cents: balance,
          }}
          credits={creditNotes}
          locale={locale}
        />
      ) : null}

      {/* ── The farmer's decision ─────────────────────────────────── */}
      {isFarmDecider && doc.kind === "quote" && doc.status === "sent" ? (
        <Card>
          <CardHeader><CardTitle>{t("doc.decideTitle", locale)}</CardTitle></CardHeader>
          <p className="mb-3 text-sm text-sand-600">
            {t("doc.decideBody", locale)} <span className="font-semibold text-sand-900">{rands(doc.total_cents)}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <ConfirmDialog
              action={acceptDocument}
              triggerLabel={t("doc.accept", locale)}
              triggerVariant="primary"
              title={t("doc.acceptTitle", locale)}
              intro={t("doc.acceptBody", locale)}
              facts={[
                { label: t("doc.total", locale), value: rands(doc.total_cents) },
                { label: t("doc.from", locale), value: brand.name },
              ]}
              confirmLabel={t("doc.accept", locale)}
              cancelLabel={t("common.cancel", locale)}
              closeLabel={t("ui.close", locale)}
              tone="brand"
            >
              <input type="hidden" name="document_id" value={doc.id} />
            </ConfirmDialog>
            <DeclineQuote locale={locale} documentId={doc.id} action={declineDocument} />
          </div>
        </Card>
      ) : null}

      {doc.status === "declined" && doc.declined_reason ? (
        <Card>
          <CardHeader><CardTitle>{t("doc.declinedTitle", locale)}</CardTitle></CardHeader>
          <p className="text-sm text-sand-700">{doc.declined_reason}</p>
        </Card>
      ) : null}

      {/* ── Payments ─────────────────────────────────────────────── */}
      {doc.kind === "invoice" && doc.status !== "draft" ? (
        <Card>
          <CardHeader><CardTitle>{t("doc.payments", locale)}</CardTitle></CardHeader>
          {payments.length > 0 ? (
            <ul className="mb-3 flex flex-col divide-y divide-sand-100 text-sm">
              {payments.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="font-medium tabular-nums text-sand-900">
                    {p.is_refund ? `− ${rands(Math.abs(p.amount_cents))}` : rands(p.amount_cents)}
                  </span>
                  {p.is_refund ? <Badge tone="warning">{t("doc.refundBadge", locale)}</Badge> : null}
                  <span className="text-sand-500">{shortDate(p.paid_on, locale)}</span>
                  {p.method ? <Badge tone="neutral">{p.method}</Badge> : null}
                  {p.reference ? <span className="font-mono text-xs text-sand-500">{p.reference}</span> : null}
                  {canPay ? (
                    <span className="ml-auto">
                      <ConfirmDialog
                        action={removePayment}
                        triggerLabel={t("common.remove", locale)}
                        triggerIcon={<TrashIcon />}
                        triggerVariant="ghost"
                        triggerSize="sm"
                        title={t("doc.removePayment", locale)}
                        intro={rands(p.amount_cents)}
                        confirmLabel={t("common.remove", locale)}
                        cancelLabel={t("common.cancel", locale)}
                        closeLabel={t("ui.close", locale)}
                      >
                        <input type="hidden" name="document_id" value={doc.id} />
                        <input type="hidden" name="payment_id" value={p.id} />
                      </ConfirmDialog>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-3 text-sm text-sand-500">{t("doc.noPayments", locale)}</p>
          )}

          {balance > 0 && canPay ? (
            <form action={recordPayment} className="flex flex-col gap-3">
              <input type="hidden" name="document_id" value={doc.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  name="amount"
                  inputMode="decimal"
                  label={t("doc.paymentAmount", locale)}
                  hint={`${t("doc.balanceDue", locale)}: ${rands(balance)}`}
                  defaultValue={String(balance / 100)}
                  required
                />
                <TextField name="paid_on" type="date" label={t("doc.paidOn", locale)} defaultValue={new Date().toISOString().slice(0, 10)} />
                <SelectField name="method" label={t("doc.paymentMethod", locale)} defaultValue="eft">
                  <option value="eft">{t("doc.methodEft", locale)}</option>
                  <option value="cash">{t("doc.methodCash", locale)}</option>
                  <option value="card">{t("doc.methodCard", locale)}</option>
                  <option value="other">{t("doc.methodOther", locale)}</option>
                </SelectField>
                <TextField name="reference" label={t("doc.paymentReference", locale)} defaultValue={doc.number} />
              </div>
              <SubmitButton variant="secondary">{t("doc.recordPayment", locale)}</SubmitButton>
            </form>
          ) : null}

          {/* Money going back. A credit note lowers what they owe; if they had already
              paid, the cash still has to leave — and until this existed the statement
              showed a customer refunded in full a year ago sitting in credit for ever. */}
          {isPartner && canPay && doc.amount_paid_cents > 0 ? (
            <div className="mt-3 border-t border-sand-100 pt-3">
              <p className="text-sm font-medium text-sand-900">{t("doc.refundTitle", locale)}</p>
              <p className="mt-0.5 text-sm text-sand-600">
                {inCreditCents > 0
                  ? `${t("doc.refundInCredit", locale)} ${rands(inCreditCents)}`
                  : t("doc.refundHint", locale)}
              </p>
              <ConfirmDialog
                action={recordRefund}
                triggerLabel={t("doc.recordRefund", locale)}
                triggerVariant="ghost"
                triggerSize="sm"
                triggerClassName="mt-2"
                title={t("doc.refundTitle", locale)}
                intro={t("doc.refundBody", locale)}
                facts={[{ label: t("doc.paidSoFar", locale), value: rands(doc.amount_paid_cents) }]}
                confirmLabel={t("doc.recordRefund", locale)}
                cancelLabel={t("common.cancel", locale)}
                closeLabel={t("ui.close", locale)}
              >
                <input type="hidden" name="document_id" value={doc.id} />
                <Field label={t("doc.refundAmount", locale)} htmlFor="refund_amount">
                  <Input
                    id="refund_amount"
                    name="amount"
                    inputMode="decimal"
                    required
                    defaultValue={inCreditCents > 0 ? String(inCreditCents / 100) : ""}
                  />
                </Field>
                <Field label={t("doc.refundPaidOn", locale)} htmlFor="refund_paid_on">
                  <Input id="refund_paid_on" name="paid_on" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
                </Field>
                <Field label={t("doc.refundWhy", locale)} htmlFor="refund_note">
                  <Input id="refund_note" name="note" maxLength={200} />
                </Field>
              </ConfirmDialog>
            </div>
          ) : null}

          {isPartner && !canPay ? <p className="text-sm text-sand-500">{t("doc.paymentsUpgrade", locale)}</p> : null}
        </Card>
      ) : null}
    </div>
  );
}
