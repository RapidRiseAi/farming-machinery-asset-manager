"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, TextField, SelectField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { supplierFileHash } from "@/lib/supplier-document-upload";

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

  const Container = work ? "div" : Card;
  return (
    <Container>
      {!work ? <CardHeader><CardTitle>{t(isPartner ? "doc.uploadTitle" : "doc.receivedUploadTitle", locale)}</CardTitle></CardHeader> : null}
      <p className="mb-3 text-sm text-sand-600">{t(isPartner ? "doc.uploadBody" : "doc.receivedUploadBody", locale)}</p>

      <form onSubmit={submit} className="flex flex-col gap-3">
        {work ? <>
          <input type="hidden" name="farm_id" value={work.farmId} />
          <input type="hidden" name="workshop_id" value={work.workshopId} />
          <input type="hidden" name="machine_id" value={work.machineId} />
          <input type="hidden" name="work_request_id" value={work.id} />
          <input type="hidden" name="kind" value={work.kind} />
        </> : <SelectField
          name={isPartner ? "farm_id" : "workshop_id"}
          label={t(isPartner ? "doc.newCustomer" : "doc.from", locale)}
          required
        >
          {parties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </SelectField>}

        <div className="grid gap-3 sm:grid-cols-2">
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
        </div>

        <TextField name="number" label={t("doc.supplierNumber", locale)} hint={t("doc.supplierNumberHint", locale)} maxLength={120} required />
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
    </Container>
  );
}
