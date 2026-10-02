"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { todayLocal } from "@/lib/format";
import { Field, TextField, SelectField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
  parties,
  isPartner,
}: {
  locale: Lang;
  /** Farms a partner may bill, or partners a farm may record a document from. */
  parties: { id: string; name: string }[];
  isPartner: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (parties.length === 0) return null;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/documents/upload", { method: "POST", body: new FormData(e.currentTarget) });
      const body = (await res.json()) as { ok?: boolean; id?: string; error?: string };
      if (!res.ok || !body.ok) {
        setError(t(`doc.uploadError.${body.error ?? "failed"}`, locale));
        return;
      }
      router.push(`/documents/${body.id}`);
    } catch {
      setError(t("doc.uploadError.failed", locale));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogForm
      trigger={t("doc.uploadTrigger", locale)}
      triggerVariant="secondary"
      title={t("doc.uploadTitle", locale)}
      description={t("doc.uploadBody", locale)}
      closeLabel={t("ui.close", locale)}
    >
      <form onSubmit={submit}>
        <DialogFields>
          <SelectField
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
          </SelectField>

          <SelectField name="kind" label={t("doc.newKind", locale)} defaultValue="invoice">
            <option value="invoice">{t("doc.kindInvoice", locale)}</option>
            <option value="quote">{t("doc.kindQuote", locale)}</option>
          </SelectField>
          <TextField
            name="total"
            inputMode="decimal"
            label={t("doc.uploadTotal", locale)}
            hint={t("doc.uploadTotalHint", locale)}
            required
          />

          <TextField name="subject" label={t("doc.newSubject", locale)} fieldClassName="sm:col-span-2" />

          <TextField name="issue_date" type="date" label={t("doc.issued", locale)} defaultValue={todayLocal()} />
          <TextField name="due_date" type="date" label={t("doc.dueBy", locale)} />

          <Field
            label={t("doc.uploadFile", locale)}
            htmlFor="doc-file"
            hint={t("doc.uploadFileHint", locale)}
            className="sm:col-span-2"
          >
            <Input id="doc-file" name="file" type="file" accept="application/pdf,image/*" required />
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
    </DialogForm>
  );
}
