"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { todayLocal } from "@/lib/format";
import { Field, TextField, SelectField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { supplierFileHash } from "@/lib/supplier-document-upload";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";

/**
 * "I already made this in my own system" (F14b).
 *
 * The path that keeps a partner independent of our invoicing: they attach the PDF their
 * accounting package produced and type the total off it. Available on every partner
 * product, the paid step up is BUILDING documents here, not attaching ones made
 * elsewhere.
 *
 * The total is asked VAT-inclusive because that is the figure printed on the document in
 * front of them; the server stores the ex-VAT split so it adds up like everything else.
 *
 * A secondary trigger in the page header, not a form open at the bottom of the list: the
 * screen shows what IS, a button asks for what is NEW. The form posts to an API route
 * (a file upload) rather than a server action, so it closes by navigating to the new
 * document, and an error keeps it open with the message beside the button that sent it.
 */
export function UploadDocument({
  locale,
  actorId,
  parties,
  isPartner,
  work,
}: {
  locale: Lang;
  actorId: string;
  /** Farms a partner may bill, or partners a farm may record a document from. */
  parties: { id: string; name: string }[];
  isPartner: boolean;
  /** A supplied document belongs to this request, rather than an unrelated bill. */
  work?: { id: string; farmId: string; machineId: string; workshopId: string; kind: "quote" | "invoice" };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ signature: string; capture: string } | null>(null);
  const fileId = useId();

  if (parties.length === 0) return null;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const form = new FormData(e.currentTarget);
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) { setError(t("doc.uploadError.missing_file", locale)); return; }
      const fingerprint = await supplierFileHash(new Uint8Array(await file.arrayBuffer()));
      const signature = actorId + JSON.stringify([...form.entries()].filter(([key]) => key !== "file")) + fingerprint;
      const receiptKey = `fleetwise:supplier-upload:${actorId}:${work?.id ?? (isPartner ? "provider" : "receiver")}`;
      let capture = pending.current?.signature === signature ? pending.current.capture : crypto.randomUUID();
      try {
        const previous = JSON.parse(sessionStorage.getItem(receiptKey) ?? "null") as { signature: string; capture: string } | null;
        if (previous?.signature === signature) capture = previous.capture;
        sessionStorage.setItem(receiptKey, JSON.stringify({ signature, capture }));
      } catch { /* Upload remains usable when browser storage is unavailable. */ }
      pending.current = { signature, capture };
      form.set("capture_id", capture);
      const res = await fetch("/api/documents/upload", { method: "POST", body: form });
      const body = (await res.json()) as { ok?: boolean; id?: string; error?: string };
      if (!res.ok || !body.ok) {
        const uploadMessages: Record<string, string> = {
          missing_file: "doc.uploadError.missing_file", missing_total: "doc.uploadError.missing_total",
          missing_fields: "doc.uploadError.missing_fields", upload_failed: "doc.uploadError.upload_failed",
        };
        setError(body.error && uploadMessages[body.error]
          ? t(uploadMessages[body.error], locale)
          : errorMessage(body.error, locale) ?? t("doc.uploadError.failed", locale));
        return;
      }
      try { sessionStorage.removeItem(receiptKey); } catch { /* Optional browser storage. */ }
      pending.current = null;
      router.push(`/documents/${body.id}`);
    } catch {
      setError(t("doc.uploadError.failed", locale));
    } finally {
      setBusy(false);
    }
  }

  // Work detail supplies its own context-specific dialog; standalone uploads open here.
  const form = (
      <form onSubmit={submit}>
        <DialogFields>
        {work ? <>
          <input type="hidden" name="farm_id" value={work.farmId} />
          <input type="hidden" name="workshop_id" value={work.workshopId} />
          <input type="hidden" name="machine_id" value={work.machineId} />
          <input type="hidden" name="work_request_id" value={work.id} />
          <input type="hidden" name="kind" value={work.kind} />
        </> : <SelectField
          name={isPartner ? "farm_id" : "workshop_id"}
          label={t(isPartner ? "doc.newCustomer" : "doc.from", locale)}
          fieldClassName="sm:col-span-2"
          required
        >
          {parties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </SelectField>}

          {!work ? <SelectField name="kind" label={t("doc.newKind", locale)} defaultValue="invoice">
            <option value="invoice">{t("doc.kindInvoice", locale)}</option>
            <option value="quote">{t("doc.kindQuote", locale)}</option>
          </SelectField> : null}
          <TextField
            name="total"
            inputMode="decimal"
            label={t("doc.uploadTotal", locale)}
            hint={t("doc.uploadTotalHint", locale)}
            required
          />

          <TextField name="number" label={t("doc.supplierNumber", locale)} hint={t("doc.supplierNumberHint", locale)} maxLength={120} required />
          <TextField name="subject" label={t("doc.newSubject", locale)} fieldClassName="sm:col-span-2" />

          <TextField name="issue_date" type="date" label={t("doc.issued", locale)} defaultValue={todayLocal()} />
          <TextField name="due_date" type="date" label={t("doc.dueBy", locale)} />

          <Field
            label={t("doc.uploadFile", locale)}
            htmlFor={fileId}
            hint={t("doc.uploadFileHint", locale)}
            className="sm:col-span-2"
          >
            <Input id={fileId} name="file" type="file" accept="application/pdf,image/*" required />
          </Field>

          {error ? (
            <p role="alert" className="text-sm text-status-overdue sm:col-span-2">
              {error}
            </p>
          ) : null}
        </DialogFields>

        <DialogActions cancelLabel={t("common.cancel", locale)}>
          <Button type="submit" loading={busy}>
            {busy ? t("doc.uploading", locale) : t("doc.uploadSubmit", locale)}
          </Button>
        </DialogActions>
      </form>
  );
  if (work) return form;
  return (
    <DialogForm
      trigger={t("doc.uploadTrigger", locale)}
      triggerVariant="secondary"
      title={t(isPartner ? "doc.uploadTitle" : "doc.receivedUploadTitle", locale)}
      description={t(isPartner ? "doc.uploadBody" : "doc.receivedUploadBody", locale)}
      closeLabel={t("ui.close", locale)}
    >
      {form}
    </DialogForm>
  );
}
