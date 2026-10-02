"use client";

import { useEffect, useRef, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { t, type Lang } from "@/lib/i18n";
import { errorMessage } from "@/lib/errors";
import { parseRandsToCents } from "@/lib/money";

/**
 * Uploader for job-card quote / invoice / photo attachments. Recording an invoice with
 * an amount also creates an `invoice` cost entry server-side (FR-8.2, FR-8.4, FR-4.5).
 * Posts multipart form data to /api/jobcards/media, then refreshes the server component
 * so the new attachment / cost appears.
 */
type MediaKind = "photo" | "quote" | "invoice";
type PendingMediaCapture = { capture: string; signature: string };
type MediaDraft = { kind: MediaKind; amount: string; inclVat: boolean; note: string; pending: PendingMediaCapture[] };
export function JobCardMedia({ jobCardId, actorId, locale = "en", allowedKinds = ["photo"], canRecordAmount = false }: {
  jobCardId: string; actorId: string; locale?: Lang; allowedKinds?: MediaKind[]; canRecordAmount?: boolean;
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
    const formEl = e.currentTarget;
    const fd = new FormData(formEl);
    fd.set("job_card_id", jobCardId);
    fd.set("kind", kind);
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const file = fd.get("file");
      if (!(file instanceof File) || file.size === 0) return;
      // File objects cannot survive a remount. Compare the selected file's bytes
      // and metadata plus invoice details before recovering an uncertain receipt.
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const signature = JSON.stringify({ kind, name: file.name, mime: file.type, size: file.size, sha256,
        amount: kind === "invoice" && canRecordAmount ? parseRandsToCents(amount) : null,
        inclVat: kind === "invoice" && canRecordAmount && inclVat,
        note: kind === "invoice" && canRecordAmount ? note.trim() : "" });
      let receipt = pending.current.find((entry) => entry.signature === signature);
      if (!receipt) {
        receipt = { capture: crypto.randomUUID(), signature };
        pending.current.push(receipt);
      }
      // Save before starting the upload: a lost response or closed dialog must
      // retain the same capture. Changed files/amounts keep separate receipts.
      try { localStorage.setItem(draftKey, JSON.stringify({ kind, amount, inclVat, note, pending: pending.current })); }
      catch { /* Keep the in-memory receipt if device storage is unavailable. */ }
      setHasPendingCapture(true);
      const captureId = receipt.capture;
      fd.set("capture_id", captureId);
      const res = await fetch("/api/jobcards/media", { method: "POST", body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(errorMessage(body.error ?? "save-failed", locale) ?? t("jobcards.mediaError", locale));
        return;
      }
      formEl.reset();
      pending.current = pending.current.filter((entry) => entry.capture !== captureId);
      setHasPendingCapture(pending.current.length > 0);
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

      <label className="text-xs font-medium text-sand-600" htmlFor="jc-media-file">{t("jobcards.file", locale)}</label>
      <input
        id="jc-media-file"
        name="file"
        type="file"
        required
        disabled={busy || !loaded}
        accept={kind === "photo" ? "image/*" : "image/*,application/pdf"}
        capture={kind === "photo" ? "environment" : undefined}
        className="block w-full text-sm text-sand-600 file:mr-3 file:rounded-lg file:border-0 file:bg-sand-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-sand-700"
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
