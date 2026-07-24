"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { t, type Locale } from "@/lib/i18n";

/**
 * Uploader for work-request quote / invoice / proof attachments. Recording an invoice
 * with an amount also books an `invoice` cost entry server-side (0311 → TCO, no
 * double-count). Posts multipart form data to /api/work/media, then refreshes the
 * server component so the new attachment / status / cost appear.
 */
export function WorkRequestMedia({ workRequestId, locale = "en" }: { workRequestId: string; locale?: Locale }) {
  const router = useRouter();
  const [kind, setKind] = useState<"photo" | "quote" | "invoice">("invoice");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const fd = new FormData(formEl);
    fd.set("work_request_id", workRequestId);
    fd.set("kind", kind);
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/work/media", { method: "POST", body: fd });
      if (!res.ok) throw new Error(String(res.status));
      formEl.reset();
      router.refresh();
    } catch {
      setErr(t("work.mediaError", locale));
    } finally {
      setBusy(false);
    }
  }

  const inputCls = "focus-ring w-full rounded-lg border border-sand-300 px-3 py-2 text-sm";
  const showAmount = kind === "invoice" || kind === "quote";

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
            {t(`work.kind_${k}`, locale)}
          </button>
        ))}
      </div>

      {showAmount ? (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-sand-600" htmlFor="wr-amount">
            {kind === "invoice" ? t("work.invoiceAmount", locale) : t("work.quoteAmount", locale)}
          </label>
          <input id="wr-amount" name="amount" type="number" inputMode="decimal" step="0.01" placeholder="0.00" className={inputCls} />
          <label className="flex items-center gap-2 text-sm text-sand-600">
            <input type="checkbox" name="incl_vat" value="1" className="h-4 w-4 rounded border-sand-300" />
            {t("work.inclVat", locale)}
          </label>
          <input name="note" placeholder={t("work.notePlaceholder", locale)} className={inputCls} />
        </div>
      ) : null}

      <label className="text-xs font-medium text-sand-600" htmlFor="wr-media-file">{t("work.file", locale)}</label>
      <input
        id="wr-media-file"
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
        {busy ? t("work.uploading", locale) : kind === "invoice" ? t("work.recordInvoice", locale) : kind === "quote" ? t("work.recordQuote", locale) : t("work.uploadFile", locale)}
      </button>
    </form>
  );
}
