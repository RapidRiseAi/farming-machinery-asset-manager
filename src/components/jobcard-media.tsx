"use client";

import { useEffect, useRef, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { t, type Lang } from "@/lib/i18n";
import { errorMessage } from "@/lib/errors";
import { parseRandsToCents } from "@/lib/money";
import { ReportPending } from "@/components/ui/pending-guard";
import { fetchWithTimeout } from "@/lib/fetch-timeout";
import { UploadField } from "@/components/upload/upload-field";

/**
 * Uploader for job-card quote / invoice / photo attachments. Recording an invoice with
 * an amount also creates an `invoice` cost entry server-side (FR-8.2, FR-8.4, FR-4.5).
 * The file goes straight to Storage first (UploadField, the upload pipeline: a photo is
 * reduced unless the original is kept, a PDF never), then the form posts its upload id and
 * the invoice details to /api/jobcards/media, which judges the file and records it with
 * the receipt and cost atomically, then refreshes the server component.
 */
type MediaKind = "photo" | "quote" | "invoice";
type PendingMediaCapture = { capture: string; signature: string };
type MediaDraft = { kind: MediaKind; amount: string; inclVat: boolean; note: string; pending: PendingMediaCapture[] };
export function JobCardMedia({ jobCardId, farmId, actorId, locale = "en", allowedKinds = ["photo"], canRecordAmount = false }: {
  jobCardId: string; farmId: string; actorId: string; locale?: Lang; allowedKinds?: MediaKind[]; canRecordAmount?: boolean;
}) {
  const router = useRouter();
  const [selectedKind, setKind] = useState<MediaKind>(allowedKinds[0] ?? "photo");
  const kind = allowedKinds.includes(selectedKind) ? selectedKind : allowedKinds[0] ?? "photo";
  const pending = useRef<PendingMediaCapture[]>([]);
  const draftKey = `fleetwise:job-media-draft:${actorId}:${jobCardId}`;
  const kindsKey = allowedKinds.join(",");
  const [amount, setAmount] = useState("");
  const [inclVat, setInclVat] = useState(false);
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [hasPendingCapture, setHasPendingCapture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The upload control is remounted (a fresh upload) after each save and on a kind change.
  const [round, setRound] = useState(0);

  useEffect(() => {
    pending.current = [];
    setAmount(""); setInclVat(false); setNote("");
    try {
      const raw = localStorage.getItem(draftKey);
      const draft: Partial<MediaDraft> = raw ? JSON.parse(raw) : {};
      if (draft.kind && kindsKey.split(",").includes(draft.kind)) setKind(draft.kind);
      if (typeof draft.amount === "string") setAmount(draft.amount);
      if (typeof draft.inclVat === "boolean") setInclVat(draft.inclVat);
      if (typeof draft.note === "string") setNote(draft.note);
      if (Array.isArray(draft.pending)) pending.current = draft.pending.filter((entry) =>
        entry && typeof entry.capture === "string" && /^[0-9a-f-]{36}$/i.test(entry.capture)
        && typeof entry.signature === "string");
    } catch { /* Device storage is optional; in-memory retries remain available. */ }
    setHasPendingCapture(pending.current.length > 0);
    setLoaded(true);
  }, [draftKey, kindsKey]);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(draftKey, JSON.stringify({ kind, amount, inclVat, note, pending: pending.current })); }
    catch { /* Device storage is optional. */ }
  }, [draftKey, loaded, kind, amount, inclVat, note]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Already uploading: a second submit would upload the same file again.
    if (busy) return;
    const formEl = e.currentTarget;
    const fd = new FormData(formEl);
    fd.set("job_card_id", jobCardId);
    fd.set("kind", kind);
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      // The file is already in Storage; its upload id is the capture, so a repeated save (a
      // lost answer, a closed dialog) records it once.
      const captureId = String(fd.get("upload_intent_id") ?? "");
      if (!captureId) { setErr(t("upload.stillSending", locale)); return; }
      setHasPendingCapture(true);
      const res = await fetchWithTimeout("/api/jobcards/media", { method: "POST", body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(errorMessage(body.error ?? "save-failed", locale) ?? t("jobcards.mediaError", locale));
        return;
      }
      formEl.reset();
      pending.current = pending.current.filter((entry) => entry.capture !== captureId);
      setHasPendingCapture(false);
      setRound((n) => n + 1);
      setAmount(""); setInclVat(false); setNote("");
      try { localStorage.setItem(draftKey, JSON.stringify({ kind, amount: "", inclVat: false, note: "", pending: pending.current })); }
      catch { /* The server acknowledgement still clears the in-memory receipt. */ }
      setSaved(true);
      router.refresh();
    } catch {
      setErr(t("jobcards.mediaError", locale));
    } finally {
      setBusy(false);
    }
  }

  const inputCls = "focus-ring w-full rounded-lg border border-sand-300 px-3 py-2 text-sm";

  return (
    <form onSubmit={onSubmit} onChange={() => setSaved(false)} className="flex flex-col gap-2">
      <ReportPending pending={busy} />
      {kind === "invoice" ? <p className="text-sm text-sand-600">{t("jobcards.supplierInvoiceHelp", locale)}</p> : null}
      {hasPendingCapture ? <p role="status" className="text-sm text-sand-600">{t("jobcards.mediaRetryHint", locale)}</p> : null}
      <div className="flex flex-wrap gap-1">
        {allowedKinds.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            disabled={busy}
            className={`focus-ring min-h-[44px] rounded-full px-3 py-1.5 text-sm font-medium ${kind === k ? "bg-brand-600 text-white" : "bg-sand-100 text-sand-700 hover:bg-sand-200"}`}
          >
            {t(`jobcards.kind_${k}`, locale)}
          </button>
        ))}
      </div>

      {kind === "invoice" && canRecordAmount ? (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-sand-600" htmlFor="invoice_amount">{t("jobcards.invoiceAmount", locale)}</label>
          <input id="invoice_amount" name="invoice_amount" type="number" min="0" inputMode="decimal" step="0.01" placeholder="0.00" required value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy} className={inputCls} />
          <label className="flex items-center gap-2 text-sm text-sand-600">
            <input type="checkbox" name="incl_vat" value="1" checked={inclVat} onChange={(event) => setInclVat(event.target.checked)} disabled={busy} className="h-4 w-4 rounded border-sand-300" />
            {t("jobcards.inclVat", locale)}
          </label>
          <label className="text-xs font-medium text-sand-600" htmlFor="jc-invoice-note">{t("jobcards.invoiceNote", locale)}</label>
          <input id="jc-invoice-note" name="note" value={note} onChange={(event) => setNote(event.target.value)} disabled={busy} className={inputCls} />
        </div>
      ) : null}

      <UploadField
        key={`${kind}:${round}`}
        locale={locale}
        label={t("jobcards.file", locale)}
        accept={kind === "photo" ? "photo" : "document"}
        capture={kind === "photo"}
        uploadLabel={kind}
        finish="caller"
        scope={`jobcard:${jobCardId}:${kind}:${round}`}
        target={loaded ? { kind: "job_card", id: jobCardId, farmId } : null}
        disabled={busy}
      />

      {err ? <p role="alert" className="text-sm text-status-overdue">{err}</p> : null}
      {saved ? <p role="status" className="text-sm text-status-ok">{t("ui.saved", locale)}</p> : null}

      <button
        type="submit"
        disabled={busy || !loaded}
        className={buttonVariants({ variant: "primary" })}
      >
        {busy ? t("jobcards.uploading", locale) : kind === "invoice" ? t("jobcards.recordInvoice", locale) : t("jobcards.uploadFile", locale)}
      </button>
    </form>
  );
}
