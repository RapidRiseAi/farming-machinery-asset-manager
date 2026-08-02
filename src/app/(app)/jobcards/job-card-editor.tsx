"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { t, type Locale } from "@/lib/i18n";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/submit-button";
import { CheckIcon } from "@/components/ui/icons";
import { cn } from "@/components/ui/cn";
import { saveJobCard } from "./actions";

/** Same five values, same column, same server action — just visible instead of hidden. */
const STATUSES = ["reported", "open", "in_progress", "waiting_parts", "completed"] as const;

type Draft = {
  status: string; date_in: string; date_out: string; meter_reading: string;
  reported_problem: string; diagnosis: string; work_performed: string; recommendations: string;
};

/** Shows the save state honestly — the page autosaved to the device every 500ms and
 *  never said so, while a Save button sat there implying the opposite. */
function SaveBar({ dirty, locale }: { dirty: boolean; locale: Locale }) {
  const { pending } = useFormStatus();
  return (
    <div className="sticky bottom-0 -mx-4 mt-1 flex items-center justify-between gap-3 border-t border-sand-200 bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-b-xl">
      <span className="flex items-center gap-1.5 text-sm">
        {dirty || pending ? (
          <span className="font-medium text-status-due">{t("jobcards.unsaved", locale)}</span>
        ) : (
          <span className="flex items-center gap-1.5 text-sand-500">
            <CheckIcon className="text-[1.05rem] text-status-ok" />
            {t("jobcards.savedAgo", locale).replace("{when}", t("format.today", locale).toLowerCase())}
          </span>
        )}
      </span>
      <SubmitButton variant="primary">{t("jobcards.saveNow", locale)}</SubmitButton>
    </div>
  );
}

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
  const [restored, setRestored] = useState(false);
  const first = useRef(true);

  // Draft recovery is silent and automatic. It used to be an amber warning banner with
  // Restore / Discard as ~24px buttons — error styling, on a phone, for the one moment
  // the app is saving your bacon.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const saved = JSON.parse(raw) as Draft;
      if (JSON.stringify(saved) !== JSON.stringify(initial)) {
        setForm(saved);
        setRestored(true);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced draft to the device (survives a dropped connection — Scope §7).
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
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);
  const currentIdx = STATUSES.indexOf(form.status as (typeof STATUSES)[number]);

  return (
    <form
      action={saveJobCard}
      onSubmit={() => { try { localStorage.removeItem(key); } catch { /* ignore */ } }}
      className="flex flex-col gap-5"
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={form.status} />

      {restored ? (
        <p className="text-sm text-sand-500" role="status">{t("jobcards.draftRestored", locale)}</p>
      ) : null}

      {/* Where this job is — five states that used to be hidden inside a <Select> of
          database values you had to open to learn where the job stood. */}
      <div>
        <h2 className="text-sm font-semibold text-sand-800">{t("jobcards.whereThisJobIs", locale)}</h2>
        <div className="-mx-1 mt-2 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {STATUSES.map((s, i) => {
            const active = form.status === s;
            const done = i < currentIdx;
            return (
              <button
                key={s}
                type="button"
                aria-pressed={active}
                onClick={() => set("status", s)}
                className={cn(
                  "focus-ring inline-flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-sm font-medium transition-colors",
                  active
                    ? "border-brand-600 bg-brand-600 text-white shadow-xs"
                    : done
                      ? "border-brand-200 bg-brand-50 text-brand-800"
                      : "border-sand-200 bg-white text-sand-600 hover:bg-sand-50",
                )}
              >
                {done ? <CheckIcon className="text-[1rem]" /> : null}
                {t(`jobStatus.${s}`, locale)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Dates + meter. "Hours when it came in" is the reading the completion step needs,
          so it is named for what it is rather than "Meter reading". */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={t("jobcards.cameIn", locale)} htmlFor="jc-datein">
          <Input id="jc-datein" name="date_in" type="date" value={form.date_in} onChange={(e) => set("date_in", e.target.value)} />
        </Field>
        <Field label={t("jobcards.wentOut", locale)} htmlFor="jc-dateout">
          <Input id="jc-dateout" name="date_out" type="date" value={form.date_out} onChange={(e) => set("date_out", e.target.value)} />
        </Field>
        <Field
          label={meterType === "km" ? t("jobcards.hoursWhenIn", locale) : t("jobcards.hoursWhenIn", locale)}
          htmlFor="jc-meter"
          hint={meterType !== "none" ? t(`format.unit.${meterType}`, locale) : undefined}
        >
          <Input id="jc-meter" name="meter_reading" type="number" inputMode="decimal" step="0.1" value={form.meter_reading} onChange={(e) => set("meter_reading", e.target.value)} />
        </Field>
      </div>

      {/* Three plain questions. These were "Reported problem / Diagnosis / Work
          performed / Recommendations" — four rows={2} boxes of equal weight, half of
          them jargon, for a mechanic on a phone in a workshop. */}
      <div className="flex flex-col gap-4">
        <Field label={t("jobcards.qWrong", locale)} htmlFor="jc-reported" hint={t("jobcards.qWrongHint", locale)}>
          <Textarea id="jc-reported" name="reported_problem" rows={3} value={form.reported_problem} onChange={(e) => set("reported_problem", e.target.value)} />
        </Field>
        <Field label={t("jobcards.qFound", locale)} htmlFor="jc-diag" hint={t("jobcards.qFoundHint", locale)}>
          <Textarea id="jc-diag" name="diagnosis" rows={3} value={form.diagnosis} onChange={(e) => set("diagnosis", e.target.value)} />
        </Field>
        <Field label={t("jobcards.qDid", locale)} htmlFor="jc-work" hint={t("jobcards.qDidHint", locale)}>
          <Textarea id="jc-work" name="work_performed" rows={4} value={form.work_performed} onChange={(e) => set("work_performed", e.target.value)} />
        </Field>
        <Field label={t("jobcards.qWatch", locale)} htmlFor="jc-rec" hint={t("jobcards.qWatchHint", locale)}>
          <Textarea id="jc-rec" name="recommendations" rows={2} value={form.recommendations} onChange={(e) => set("recommendations", e.target.value)} />
        </Field>
      </div>

      <SaveBar dirty={dirty} locale={locale} />
    </form>
  );
}
