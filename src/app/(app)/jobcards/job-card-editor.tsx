"use client";

import { useEffect, useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/submit-button";
import { DialogActions, DialogFields } from "@/components/ui/dialog-form";
import { Button } from "@/components/ui/button";
import { saveJobCard } from "./actions";

export type JobDraft = {
  date_in: string; date_out: string; meter_reading: string;
  reported_problem: string; diagnosis: string; work_performed: string; recommendations: string;
};

export function JobCardEditor({
  id, actorId, updatedAt, meterType, locale, initial, section,
}: {
  id: string;
  actorId: string;
  updatedAt: string;
  meterType: string;
  locale: Lang;
  initial: JobDraft;
  section: "intake" | "work" | "handover";
}) {
  const key = `fleetwise:jobcard-draft:${actorId}:${id}:${section}`;
  const baseline = JSON.stringify(initial);
  const [form, setForm] = useState(initial);
  const [restored, setRestored] = useState(false);
  const [conflictingDraft, setConflictingDraft] = useState<JobDraft | null>(null);

  useEffect(() => {
    setForm(JSON.parse(baseline) as JobDraft);
    setRestored(false);
    setConflictingDraft(null);
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const saved = JSON.parse(raw) as { baseline?: string; updatedAt?: string; fields?: JobDraft };
      if (!saved.fields) {
        localStorage.removeItem(key);
        return;
      }
      const current = JSON.parse(baseline) as JobDraft;
      const fields: (keyof JobDraft)[] = section === "intake" ? ["date_in", "reported_problem"] : section === "work" ? ["diagnosis", "work_performed", "recommendations"] : ["date_out", "meter_reading"];
      // Clear only once this section's submitted values are visible on the server.
      if (fields.every((field) => saved.fields![field] === current[field])) {
        localStorage.removeItem(key);
        return;
      }
      if (saved.baseline !== baseline) {
        setConflictingDraft(saved.fields);
        return;
      }
      setForm(saved.fields);
      setRestored(true);
    } catch { /* Device storage may be unavailable. */ }
  }, [baseline, key, section, updatedAt]);

  const set = (field: keyof JobDraft, value: string) => {
    const next = { ...form, [field]: value };
    setForm(next);
    try {
      localStorage.setItem(key, JSON.stringify({ baseline, updatedAt, fields: next }));
    } catch { /* Saving to the server remains available. */ }
  };
  const dirty = JSON.stringify(form) !== baseline;

  return (
    <form action={saveJobCard} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="section" value={section} />
      <input type="hidden" name="updated_at" value={updatedAt} />
      {restored ? <p role="status" className="text-sm text-sand-600">{t("jobcards.draftRestored", locale)}</p> : null}
      {conflictingDraft ? <div className="rounded-lg border border-sand-200 p-3"><p className="mb-2 text-sm text-sand-600">{t("jobcards.workflow.draftConflict", locale)}</p><div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" size="sm" onClick={() => { setForm(conflictingDraft); setConflictingDraft(null); setRestored(true); }}>{t("jobcards.workflow.useDraft", locale)}</Button><Button type="button" variant="ghost" size="sm" onClick={() => { try { localStorage.removeItem(key); } catch { /* ignore */ } setConflictingDraft(null); }}>{t("jobcards.workflow.keepSaved", locale)}</Button></div></div> : null}
      <DialogFields columns={1}>
        {section === "intake" ? (
          <>
            <Field label={t("jobcards.cameIn", locale)} htmlFor="jc-datein">
              <Input id="jc-datein" name="date_in" type="date" required value={form.date_in} onChange={(e) => set("date_in", e.target.value)} />
            </Field>
            <Field label={t("jobcards.qWrong", locale)} htmlFor="jc-reported" hint={t("jobcards.qWrongHint", locale)}>
              <Textarea id="jc-reported" name="reported_problem" rows={4} value={form.reported_problem} onChange={(e) => set("reported_problem", e.target.value)} />
            </Field>
          </>
        ) : section === "work" ? (
          <>
            <Field label={t("jobcards.qFound", locale)} htmlFor="jc-diag" hint={t("jobcards.qFoundHint", locale)}>
              <Textarea id="jc-diag" name="diagnosis" rows={3} value={form.diagnosis} onChange={(e) => set("diagnosis", e.target.value)} />
            </Field>
            <Field label={t("jobcards.qDid", locale)} htmlFor="jc-work" hint={t("jobcards.qDidHint", locale)}>
              <Textarea id="jc-work" name="work_performed" rows={4} value={form.work_performed} onChange={(e) => set("work_performed", e.target.value)} />
            </Field>
            <Field label={t("jobcards.qWatch", locale)} htmlFor="jc-rec" hint={t("jobcards.qWatchHint", locale)}>
              <Textarea id="jc-rec" name="recommendations" rows={2} value={form.recommendations} onChange={(e) => set("recommendations", e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label={t("jobcards.wentOut", locale)} htmlFor="jc-dateout">
              <Input id="jc-dateout" name="date_out" type="date" min={form.date_in || undefined} value={form.date_out} onChange={(e) => set("date_out", e.target.value)} />
            </Field>
            {meterType !== "none" ? (
              <Field label={t("jobcards.meterReading", locale)} htmlFor="jc-meter" hint={t(`format.unit.${meterType}`, locale)}>
                <Input id="jc-meter" name="meter_reading" type="number" min="0" inputMode="decimal" step="0.1" value={form.meter_reading} onChange={(e) => set("meter_reading", e.target.value)} />
              </Field>
            ) : null}
          </>
        )}
      </DialogFields>
      <DialogActions cancelLabel={t("common.cancel", locale)} note={dirty ? t("jobcards.unsaved", locale) : undefined}>
        <SubmitButton variant="primary" disabled={!!conflictingDraft}>{t("jobcards.saveNow", locale)}</SubmitButton>
      </DialogActions>
    </form>
  );
}
