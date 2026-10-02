"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DialogActions } from "@/components/ui/dialog-form";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { t, type Lang } from "@/lib/i18n";
import { applyServiceKit } from "./actions";

export function ServiceKitForm({ jobId, farmId, actorId, kits, locale }: {
  jobId: string; farmId: string; actorId: string; kits: { id: string; name: string }[]; locale: Lang;
}) {
  const [capture, setCapture] = useState("");
  const [kitId, setKitId] = useState("");
  const key = `fleetwise:kit-draft:${actorId}:${jobId}`;
  const acknowledged = useSearchParams().get("kit_token");
  useEffect(() => {
    let token = crypto.randomUUID();
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.capture === acknowledged) { localStorage.removeItem(key); setKitId(""); }
        else { if (typeof saved.capture === "string") token = saved.capture; if (typeof saved.kitId === "string") setKitId(saved.kitId); }
      }
    } catch { /* Device storage is optional. */ }
    setCapture(token);
  }, [key, acknowledged]);
  useEffect(() => {
    if (!capture) return;
    try { localStorage.setItem(key, JSON.stringify({ capture, kitId })); } catch { /* The online save still works. */ }
  }, [key, capture, kitId]);
  return <form action={applyServiceKit} className="flex flex-col gap-3">
    <input type="hidden" name="job_card_id" value={jobId} /><input type="hidden" name="farm_id" value={farmId} />
    <input type="hidden" name="capture_id" value={capture} />
    <Field label={t("jobcards.applyKit", locale)} htmlFor="apply-kit"><Select id="apply-kit" name="service_kit_id" value={kitId} onChange={(event) => { setKitId(event.target.value); setCapture(crypto.randomUUID()); }} required>
      <option value="" disabled>{t("jobcards.workflow.chooseKit", locale)}</option>
      {kits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name}</option>)}
    </Select></Field>
    <DialogActions cancelLabel={t("common.cancel", locale)}><SubmitButton variant="primary" disabled={!capture || !kitId}>{t("jobcards.applyKitButton", locale)}</SubmitButton></DialogActions>
  </form>;
}
