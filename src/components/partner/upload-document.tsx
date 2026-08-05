"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, TextField, SelectField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * "I already made this in my own system" (F14b).
 *
 * The path that keeps a partner independent of our invoicing: they attach the PDF their
 * accounting package produced and type the total off it. Available on every partner
 * product — the paid step up is BUILDING documents here, not attaching ones made
 * elsewhere.
 *
 * The total is asked VAT-inclusive because that is the figure printed on the document in
 * front of them; the server stores the ex-VAT split so it adds up like everything else.
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
    <Card>
      <CardHeader><CardTitle>{t("doc.uploadTitle", locale)}</CardTitle></CardHeader>
      <p className="mb-3 text-sm text-sand-600">{t("doc.uploadBody", locale)}</p>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <SelectField
          name={isPartner ? "farm_id" : "workshop_id"}
          label={t(isPartner ? "doc.newCustomer" : "doc.from", locale)}
          required
        >
          {parties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </SelectField>

        <div className="grid gap-3 sm:grid-cols-2">
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
        </div>

        <TextField name="subject" label={t("doc.newSubject", locale)} />

        <div className="grid gap-3 sm:grid-cols-2">
          <TextField name="issue_date" type="date" label={t("doc.issued", locale)} defaultValue={new Date().toISOString().slice(0, 10)} />
          <TextField name="due_date" type="date" label={t("doc.dueBy", locale)} />
        </div>

        <Field label={t("doc.uploadFile", locale)} htmlFor="doc-file" hint={t("doc.uploadFileHint", locale)}>
          <Input id="doc-file" name="file" type="file" accept="application/pdf,image/*" required />
        </Field>

        <Button type="submit" disabled={busy}>
          {busy ? t("doc.uploading", locale) : t("doc.uploadSubmit", locale)}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-status-overdue">
            {error}
          </p>
        ) : null}
      </form>
    </Card>
  );
}
