"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { t, type Locale } from "@/lib/i18n";

/**
 * Uploader for job-card quote / invoice / photo attachments. Recording an invoice with
 * an amount also creates an `invoice` cost entry server-side (FR-8.2, FR-8.4, FR-4.5).
 * Posts multipart form data to /api/jobcards/media, then refreshes the server component
 * so the new attachment / cost appears.
 */
export function JobCardMedia({ jobCardId, locale = "en" }: { jobCardId: string; locale?: Locale }) {
  const router = useRouter();
  const [kind, setKind] = useState<"photo" | "quote" | "invoice">("invoice");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const fd = new FormData(formEl);
    fd.set("job_card_id", jobCardId);
    fd.set("kind", kind);
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/jobcards/media", { method: "POST", body: fd });
      if (!res.ok) throw new Error(String(res.status));
      formEl.reset();
      router.refresh();
    } catch {
      setErr(t("jobcards.mediaError", locale));
    } finally {
      setBusy(false);
    }
  }

  const inputCls = "focus-ring w-full rounded-lg border border-sand-300 px-3 py-2 text-sm";

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {(["invoice", "quote", "photo"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`focus-ring rounded-full px-3 py-1.5 text-sm font-medium ${kind === k ? "bg-brand-600 text-white" : "bg-sand-100 text-sand-700 hover:bg-sand-200"}`}
          >
            {t(`jobcards.kind_${k}`, locale)}
          </button>
        ))}
      </div>

      {kind === "invoice" ? (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-sand-600" htmlFor="invoice_amount">{t("jobcards.invoiceAmount", locale)}</label>
          <input id="invoice_amount" name="invoice_amount" type="number" inputMode="decimal" step="0.01" placeholder="0.00" className={inputCls} />
          <label className="flex items-center gap-2 text-sm text-sand-600">
            <input type="checkbox" name="incl_vat" value="1" className="h-4 w-4 rounded border-sand-300" />
            {t("jobcards.inclVat", locale)}
          </label>
          <input name="note" placeholder={t("jobcards.invoiceNote", locale)} className={inputCls} />
        </div>
      ) : null}

      <label className="text-xs font-medium text-sand-600" htmlFor="jc-media-file">{t("jobcards.file", locale)}</label>
      <input
        id="jc-media-file"
        name="file"
        type="file"
        accept={kind === "photo" ? "image/*" : "image/*,application/pdf"}
        capture={kind === "photo" ? "environment" : undefined}
        className="block w-full text-sm text-sand-600 file:mr-3 file:rounded-lg file:border-0 file:bg-sand-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-sand-700"
      />

      {err ? <p className="text-sm text-status-overdue">{err}</p> : null}

      <button
        type="submit"
        disabled={busy}
        className="focus-ring inline-flex min-h-[44px] items-center justify-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {busy ? t("jobcards.uploading", locale) : kind === "invoice" ? t("jobcards.recordInvoice", locale) : t("jobcards.uploadFile", locale)}
      </button>
    </form>
  );
}
