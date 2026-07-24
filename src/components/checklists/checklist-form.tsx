"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { t, type Locale } from "@/lib/i18n";
import { compressImage, blobToDataUrl } from "@/lib/image-compress";
import { ratingMax, isChecklistValueEmpty, type ChecklistFieldType } from "@/lib/checklists";
import {
  createChecklistInstance,
  type ChecklistInstanceInput,
  type ChecklistValueInput,
} from "@/app/(app)/machines/[id]/checklists/actions";

export type FormTemplateField = {
  id: string;
  sort_order: number;
  field_type: ChecklistFieldType;
  label: string;
  required: boolean;
  help_text: string | null;
  config: Record<string, unknown> | null;
};

export type FormTemplate = {
  id: string;
  name: string;
  description: string | null;
  fields: FormTemplateField[];
};

/**
 * Checklist fill renderer (mirrors TJ-autovault's inspection-report-form-renderer):
 * pick a template, answer each field by its type (checkbox / text / number / photo /
 * rating / section break), attach an optional per-field note, then save. Photo fields
 * are compressed client-side and ferried to the save action as base64 data URLs.
 */
export function ChecklistForm({
  machineId,
  meterType,
  currentReading,
  templates,
  initialTemplateId,
  locale,
}: {
  machineId: string;
  meterType: string;
  currentReading: number | null;
  templates: FormTemplate[];
  initialTemplateId?: string;
  locale: Locale;
}) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(initialTemplateId ?? templates[0]?.id ?? "");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<Record<string, { dataUrl: string; preview: string }>>({});
  const [fieldNotes, setFieldNotes] = useState<Record<string, string>>({});
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
  const [meterReading, setMeterReading] = useState<string>(currentReading != null ? String(currentReading) : "");
  const [overallNotes, setOverallNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const template = useMemo(() => templates.find((tpl) => tpl.id === templateId), [templateId, templates]);
  const fields = useMemo(() => [...(template?.fields ?? [])].sort((a, b) => a.sort_order - b.sort_order), [template]);

  const inputCls = "rounded-lg border border-sand-300 px-3 py-2 text-sm";

  async function onPhoto(fieldId: string, file: File | undefined) {
    if (!file) return;
    try {
      const blob = await compressImage(file);
      const dataUrl = await blobToDataUrl(blob);
      const preview = URL.createObjectURL(blob);
      setPhotos((cur) => ({ ...cur, [fieldId]: { dataUrl, preview } }));
    } catch {
      setError(t("checklists.photoFailed", locale));
    }
  }

  // Serialize a field's answer to value_text for the save payload.
  function valueText(field: FormTemplateField): string | null {
    if (field.field_type === "checkbox") return answers[field.id] === "true" ? "true" : "false";
    if (field.field_type === "photo" || field.field_type === "section_break") return null;
    const v = answers[field.id];
    return v != null && v.trim() !== "" ? v.trim() : null;
  }

  async function save(status: "draft" | "completed") {
    setError(null);
    if (!template) {
      setError(t("checklists.pickTemplate", locale));
      return;
    }
    if (status === "completed") {
      for (const f of fields) {
        if (!f.required) continue;
        const vt = valueText(f);
        if (isChecklistValueEmpty(f.field_type, vt, Boolean(photos[f.id]))) {
          setError(t("checklists.fieldRequired", locale).replace("{field}", f.label));
          return;
        }
      }
    }

    const values: ChecklistValueInput[] = fields.map((f, i) => ({
      template_field_id: f.id,
      sort_order: i,
      field_type: f.field_type,
      label: f.label,
      value_text: valueText(f),
      notes: fieldNotes[f.id]?.trim() || null,
      photo_data_url: f.field_type === "photo" ? (photos[f.id]?.dataUrl ?? null) : null,
    }));

    const payload: ChecklistInstanceInput = {
      machine_id: machineId,
      template_id: template.id,
      template_name: template.name,
      status,
      meter_reading: meterReading.trim() !== "" && Number.isFinite(Number(meterReading)) ? Number(meterReading) : null,
      notes: overallNotes.trim() || null,
      values,
    };

    setSubmitting(true);
    try {
      const res = await createChecklistInstance(payload);
      if (res?.error) {
        setError(res.error);
        setSubmitting(false);
        return;
      }
      router.refresh();
    } catch {
      setError(t("checklists.saveFailed", locale));
      setSubmitting(false);
    }
  }

  if (templates.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-sand-300 p-4 text-sm text-sand-600">
        {t("checklists.noTemplatesForMachine", locale)}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="block text-sm font-medium text-sand-700">
        {t("checklists.template", locale)}
        <select className={`mt-1 w-full ${inputCls}`} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
          ))}
        </select>
      </label>
      {template?.description ? <p className="text-sm text-sand-500">{template.description}</p> : null}

      {fields.length === 0 ? (
        <p className="rounded-lg border border-dashed border-sand-300 p-4 text-sm text-sand-600">{t("checklists.templateNoFields", locale)}</p>
      ) : null}

      <div className="flex flex-col gap-4">
        {fields.map((field) => {
          if (field.field_type === "section_break") {
            return (
              <div key={field.id} className="border-l-4 border-brand-500 bg-sand-50 px-3 py-2">
                <p className="text-sm font-semibold uppercase tracking-wide text-sand-700">{field.label}</p>
              </div>
            );
          }
          const noteOpen = openNotes[field.id] || (fieldNotes[field.id] ?? "").trim() !== "";
          return (
            <div key={field.id} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-sand-800">
                  {field.label}
                  {field.required ? <span className="text-status-overdue"> *</span> : null}
                </span>
                <button
                  type="button"
                  className="focus-ring rounded-md border border-sand-300 px-2 py-0.5 text-xs text-sand-600"
                  onClick={() => setOpenNotes((cur) => ({ ...cur, [field.id]: !noteOpen }))}
                >
                  {noteOpen ? t("checklists.hideNote", locale) : t("checklists.addNote", locale)}
                </button>
              </div>
              {field.help_text ? <p className="text-xs text-sand-500">{field.help_text}</p> : null}

              {field.field_type === "checkbox" ? (
                <label className="flex items-center gap-2 text-sm text-sand-700">
                  <input
                    type="checkbox"
                    className="h-5 w-5 rounded border-sand-300"
                    checked={answers[field.id] === "true"}
                    onChange={(e) => setAnswers((cur) => ({ ...cur, [field.id]: e.target.checked ? "true" : "false" }))}
                  />
                  {answers[field.id] === "true" ? t("common.yes", locale) : t("common.no", locale)}
                </label>
              ) : null}

              {field.field_type === "text" ? (
                <textarea
                  className={`w-full ${inputCls}`}
                  rows={2}
                  value={answers[field.id] ?? ""}
                  onChange={(e) => setAnswers((cur) => ({ ...cur, [field.id]: e.target.value }))}
                  spellCheck
                  autoCapitalize="sentences"
                />
              ) : null}

              {field.field_type === "number" ? (
                <input
                  type="number"
                  inputMode="decimal"
                  className={`w-full ${inputCls}`}
                  value={answers[field.id] ?? ""}
                  onChange={(e) => setAnswers((cur) => ({ ...cur, [field.id]: e.target.value }))}
                />
              ) : null}

              {field.field_type === "rating" ? (
                <div className="flex flex-wrap gap-1.5">
                  {Array.from({ length: ratingMax(field.config) }, (_, n) => n + 1).map((n) => {
                    const active = Number(answers[field.id]) === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={active}
                        className={`focus-ring h-9 w-9 rounded-lg border text-sm font-semibold ${active ? "border-brand-600 bg-brand-600 text-white" : "border-sand-300 text-sand-700 hover:bg-sand-50"}`}
                        onClick={() => setAnswers((cur) => ({ ...cur, [field.id]: String(n) }))}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {field.field_type === "photo" ? (
                <div className="flex items-center gap-3">
                  {photos[field.id] ? (
                    <span className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={photos[field.id].preview} alt={field.label} className="h-20 w-20 rounded-lg object-cover ring-1 ring-sand-200" />
                      <button
                        type="button"
                        aria-label={t("checklists.removePhoto", locale)}
                        className="focus-ring absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-sand-800 text-xs text-white"
                        onClick={() => setPhotos((cur) => { const n = { ...cur }; delete n[field.id]; return n; })}
                      >
                        ✕
                      </button>
                    </span>
                  ) : null}
                  <label className="focus-ring inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-sand-300 px-3 py-1.5 text-sm font-medium text-sand-700 hover:bg-sand-50">
                    {photos[field.id] ? t("checklists.retakePhoto", locale) : t("checklists.takePhoto", locale)}
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="sr-only"
                      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void onPhoto(field.id, f); }}
                    />
                  </label>
                </div>
              ) : null}

              {noteOpen ? (
                <textarea
                  className={`w-full ${inputCls}`}
                  rows={2}
                  placeholder={t("checklists.notePlaceholder", locale)}
                  value={fieldNotes[field.id] ?? ""}
                  onChange={(e) => setFieldNotes((cur) => ({ ...cur, [field.id]: e.target.value }))}
                  spellCheck
                  autoCapitalize="sentences"
                />
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-3 border-t border-sand-100 pt-3 sm:grid-cols-2">
        {meterType !== "none" ? (
          <label className="block text-sm font-medium text-sand-700">
            {t("checklists.meterReading", locale)} ({meterType})
            <input
              type="number"
              inputMode="decimal"
              className={`mt-1 w-full ${inputCls}`}
              value={meterReading}
              onChange={(e) => setMeterReading(e.target.value)}
            />
          </label>
        ) : null}
        <label className="block text-sm font-medium text-sand-700 sm:col-span-2">
          {t("checklists.overallNotes", locale)}
          <textarea
            className={`mt-1 w-full ${inputCls}`}
            rows={2}
            value={overallNotes}
            onChange={(e) => setOverallNotes(e.target.value)}
            spellCheck
            autoCapitalize="sentences"
          />
        </label>
      </div>

      {error ? <p className="text-sm text-status-overdue">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={submitting}
          onClick={() => void save("completed")}
          className="focus-ring rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {submitting ? t("checklists.saving", locale) : t("checklists.saveChecklist", locale)}
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => void save("draft")}
          className="focus-ring rounded-lg border border-sand-300 px-4 py-2 text-sm font-medium text-sand-700 hover:bg-sand-50 disabled:opacity-50"
        >
          {t("checklists.saveDraft", locale)}
        </button>
      </div>
    </div>
  );
}
