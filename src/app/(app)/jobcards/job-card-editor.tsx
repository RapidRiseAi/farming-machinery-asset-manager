"use client";

import { useEffect, useRef, useState } from "react";
import { t, type Locale } from "@/lib/i18n";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/submit-button";
import { saveJobCard } from "./actions";

const STATUSES = ["reported", "open", "in_progress", "waiting_parts", "completed"];

type Draft = {
  status: string; date_in: string; date_out: string; meter_reading: string;
  reported_problem: string; diagnosis: string; work_performed: string; recommendations: string;
};

export function JobCardEditor({
  id,
  meterType,
  locale,
  initial,
}: {
  id: string;
  meterType: string;
  locale: Locale;
  initial: Draft;
}) {
  const key = `farmgear:jobcard-draft:${id}`;
  const [form, setForm] = useState<Draft>(initial);
  const [restore, setRestore] = useState<Draft | null>(null);
  const first = useRef(true);

  // On mount: offer to restore a newer local draft that differs from the server row.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const saved = JSON.parse(raw) as Draft;
      if (JSON.stringify(saved) !== JSON.stringify(initial)) setRestore(saved);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced autosave to localStorage (survives a dropped connection — Scope §7).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const h = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(form));
      } catch {
        /* ignore */
      }
    }, 500);
    return () => clearTimeout(h);
  }, [form, key]);

  const set = (k: keyof Draft, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="flex flex-col gap-3">
      {restore ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-due/40 bg-amber-50 px-3 py-2 text-sm">
          <span className="text-sand-800">{t("jobcards.draftFound", locale)}</span>
          <span className="flex gap-2">
            <button
              type="button"
              onClick={() => { setForm(restore); setRestore(null); }}
              className="focus-ring rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white"
            >
              {t("jobcards.restore", locale)}
            </button>
            <button
              type="button"
              onClick={() => { localStorage.removeItem(key); setRestore(null); }}
              className="focus-ring rounded-md border border-sand-300 px-3 py-1 text-xs"
            >
              {t("jobcards.discard", locale)}
            </button>
          </span>
        </div>
      ) : null}

      <form action={saveJobCard} onSubmit={() => { try { localStorage.removeItem(key); } catch { /* ignore */ } }} className="flex flex-col gap-3">
        <input type="hidden" name="id" value={id} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t("machines.status", locale)} htmlFor="jc-status">
            <Select id="jc-status" name="status" value={form.status} onChange={(e) => set("status", e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{t(`jobStatus.${s}`, locale)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("jobcards.dateIn", locale)} htmlFor="jc-datein">
            <Input id="jc-datein" name="date_in" type="date" value={form.date_in} onChange={(e) => set("date_in", e.target.value)} />
          </Field>
          <Field label={t("jobcards.dateOut", locale)} htmlFor="jc-dateout">
            <Input id="jc-dateout" name="date_out" type="date" value={form.date_out} onChange={(e) => set("date_out", e.target.value)} />
          </Field>
        </div>
        <Field label={`${t("jobcards.meterReading", locale)}${meterType !== "none" ? ` (${meterType})` : ""}`} htmlFor="jc-meter">
          <Input id="jc-meter" name="meter_reading" type="number" inputMode="decimal" step="0.1" value={form.meter_reading} onChange={(e) => set("meter_reading", e.target.value)} />
        </Field>
        <Field label={t("jobcards.reportedProblem", locale)} htmlFor="jc-reported">
          <Textarea id="jc-reported" name="reported_problem" rows={2} value={form.reported_problem} onChange={(e) => set("reported_problem", e.target.value)} />
        </Field>
        <Field label={t("jobcards.diagnosis", locale)} htmlFor="jc-diag">
          <Textarea id="jc-diag" name="diagnosis" rows={2} value={form.diagnosis} onChange={(e) => set("diagnosis", e.target.value)} />
        </Field>
        <Field label={t("jobcards.workPerformed", locale)} htmlFor="jc-work">
          <Textarea id="jc-work" name="work_performed" rows={2} value={form.work_performed} onChange={(e) => set("work_performed", e.target.value)} />
        </Field>
        <Field label={t("jobcards.recommendations", locale)} htmlFor="jc-rec" hint={t("jobcards.recommendationsHint", locale)}>
          <Textarea id="jc-rec" name="recommendations" rows={2} value={form.recommendations} onChange={(e) => set("recommendations", e.target.value)} />
        </Field>
        <SubmitButton variant="secondary" className="self-start">{t("jobcards.save", locale)}</SubmitButton>
      </form>
    </div>
  );
}
