"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DialogActions } from "@/components/ui/dialog-form";
import { SubmitButton } from "@/components/ui/submit-button";
import { t, type Lang } from "@/lib/i18n";
import { createWorkRequest } from "./actions";

const draftFields = ["workshop_id", "kind", "priority", "title", "description"] as const;
type RequestDraft = { capture: string; fields: Partial<Record<(typeof draftFields)[number], string>> };

/** Preserve the detailed asset-page request form until its receipt is acknowledged. */
export function WorkRequestIntakeForm({ actorId, machineId, locale, children }: {
  actorId: string; machineId: string; locale: Lang; children: ReactNode;
}) {
  const key = `fleetwise:job-intake-draft:${actorId}:request-${machineId}`;
  const formRef = useRef<HTMLFormElement>(null);
  const [capture, setCapture] = useState("");
  const [restored, setRestored] = useState(false);
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    let token = crypto.randomUUID();
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const saved = JSON.parse(raw) as RequestDraft;
        if (typeof saved.capture === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved.capture) && saved.fields) {
          token = saved.capture;
          for (const name of draftFields) {
            const control = formRef.current?.elements.namedItem(name);
            if (typeof saved.fields[name] === "string" && (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) control.value = saved.fields[name];
          }
          setRestored(true);
        }
      }
    } catch { setStorageError(true); }
    setCapture(token);
  }, [key]);
  const persist = () => {
    if (!capture || !formRef.current) return;
    const form = new FormData(formRef.current);
    const fields = Object.fromEntries(draftFields.map((name) => [name, String(form.get(name) ?? "")]));
    try { localStorage.setItem(key, JSON.stringify({ capture, fields } satisfies RequestDraft)); setStorageError(false); }
    catch { setStorageError(true); }
  };
  const discard = () => {
    formRef.current?.reset();
    setCapture(crypto.randomUUID());
    setRestored(false);
    try { localStorage.removeItem(key); } catch { /* The online request remains available. */ }
  };
  return (
    <form ref={formRef} action={createWorkRequest} onChange={persist} onSubmit={persist}>
      <input type="hidden" name="intake_capture" value={capture} />
      {restored ? <p role="status" className="mb-3 text-sm text-sand-600">{t("jobcards.draftRestored", locale)}</p> : null}
      {storageError ? <p role="status" className="mb-3 text-sm text-status-due">{t("jobcards.workflow.draftStorageUnavailable", locale)}</p> : null}
      <fieldset disabled={!capture} className="min-w-0">{children}</fieldset>
      <DialogActions cancelLabel={t("common.cancel", locale)}>
        <Button type="button" variant="ghost" disabled={!capture} onClick={discard}>{t("jobcards.workflow.discardDraft", locale)}</Button>
        <SubmitButton variant="primary" disabled={!capture}>{t("work.send", locale)}</SubmitButton>
      </DialogActions>
    </form>
  );
}
