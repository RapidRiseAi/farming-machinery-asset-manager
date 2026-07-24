"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { t, type Locale } from "@/lib/i18n";
import {
  CHECKLIST_FIELD_TYPES,
  fieldTypeLabel,
  DEFAULT_RATING_MAX,
  type ChecklistFieldType,
} from "@/lib/checklists";
import { MACHINE_TYPES, typeLabel } from "@/lib/machine-options";
import { saveChecklistTemplate, type TemplatePayload } from "@/app/(app)/checklists/actions";

type BuilderField = {
  field_type: ChecklistFieldType;
  label: string;
  required: boolean;
  help_text: string;
  rating_max: number;
};

const EMPTY_FIELD: BuilderField = {
  field_type: "checkbox",
  label: "",
  required: false,
  help_text: "",
  rating_max: DEFAULT_RATING_MAX,
};

/**
 * Checklist template builder (mirrors TJ-autovault's inspection-template-builder):
 * name/description/type + an ordered list of fields whose type, label, required flag,
 * help text and (for ratings) scale can be edited, reordered and removed. Saving posts
 * a structured payload to the RLS-bound `saveChecklistTemplate` server action.
 */
export function ChecklistTemplateBuilder({
  mode,
  locale,
  templateId,
  isGlobal = false,
  initialName = "",
  initialDescription = "",
  initialMachineType = "",
  initialFields,
}: {
  mode: "create" | "edit";
  locale: Locale;
  templateId?: string;
  isGlobal?: boolean;
  initialName?: string;
  initialDescription?: string;
  initialMachineType?: string;
  initialFields?: BuilderField[];
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [machineType, setMachineType] = useState(initialMachineType);
  const [fields, setFields] = useState<BuilderField[]>(
    initialFields?.length ? initialFields : [{ ...EMPTY_FIELD }],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputCls = "rounded-lg border border-sand-300 px-3 py-2 text-sm";

  function patch(index: number, next: Partial<BuilderField>) {
    setFields((cur) => cur.map((f, i) => (i === index ? { ...f, ...next } : f)));
  }
  function move(index: number, dir: -1 | 1) {
    setFields((cur) => {
      const next = [...cur];
      const j = index + dir;
      if (j < 0 || j >= next.length) return cur;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }

  async function onSave() {
    setError(null);
    if (!name.trim()) {
      setError(t("checklists.nameRequired", locale));
      return;
    }
    if (fields.length === 0) {
      setError(t("checklists.needField", locale));
      return;
    }
    if (fields.some((f) => !f.label.trim())) {
      setError(t("checklists.everyFieldLabel", locale));
      return;
    }

    const payload: TemplatePayload = {
      id: templateId,
      name: name.trim(),
      description: description.trim() || null,
      machine_type: machineType || null,
      fields: fields.map((f) => ({
        field_type: f.field_type,
        label: f.label.trim(),
        required: f.field_type === "section_break" ? false : f.required,
        help_text: f.field_type === "section_break" ? null : f.help_text.trim() || null,
        config: f.field_type === "rating" ? { max: f.rating_max } : null,
      })),
    };

    setSaving(true);
    try {
      const res = await saveChecklistTemplate(payload);
      if (res?.error) {
        setError(res.error);
        setSaving(false);
        return;
      }
      // On success the action redirects; refresh in case navigation is intercepted.
      router.refresh();
    } catch {
      setError(t("checklists.saveFailed", locale));
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-sand-700">
          {t("checklists.name", locale)}
          <input
            className={`mt-1 w-full ${inputCls}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck
            autoCapitalize="sentences"
          />
        </label>
        <label className="block text-sm font-medium text-sand-700">
          {t("checklists.machineType", locale)}
          <select
            className={`mt-1 w-full ${inputCls}`}
            value={machineType}
            onChange={(e) => setMachineType(e.target.value)}
          >
            <option value="">{t("checklists.anyType", locale)}</option>
            {MACHINE_TYPES.map((mt) => (
              <option key={mt} value={mt}>
                {typeLabel(mt, locale)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-sand-700 sm:col-span-2">
          {t("checklists.description", locale)}
          <input
            className={`mt-1 w-full ${inputCls}`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("checklists.descriptionHint", locale)}
            spellCheck
            autoCapitalize="sentences"
          />
        </label>
      </div>

      {isGlobal ? (
        <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800">
          {t("checklists.globalHint", locale)}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {fields.map((field, index) => (
          <div key={index} className="flex flex-col gap-2 rounded-xl border border-sand-200 bg-sand-50/60 p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr_auto]">
              <select
                className={inputCls}
                value={field.field_type}
                onChange={(e) => patch(index, { field_type: e.target.value as ChecklistFieldType })}
                aria-label={t("checklists.fieldType", locale)}
              >
                {CHECKLIST_FIELD_TYPES.map((ft) => (
                  <option key={ft} value={ft}>
                    {fieldTypeLabel(ft, locale)}
                  </option>
                ))}
              </select>
              <input
                className={inputCls}
                value={field.label}
                onChange={(e) => patch(index, { label: e.target.value })}
                placeholder={
                  field.field_type === "section_break"
                    ? t("checklists.sectionHeading", locale)
                    : t("checklists.fieldLabel", locale)
                }
                spellCheck
                autoCapitalize="sentences"
              />
              {field.field_type !== "section_break" ? (
                <label className="flex items-center gap-2 rounded-lg border border-sand-300 px-3 py-2 text-sm text-sand-700">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-sand-300"
                    checked={field.required}
                    onChange={(e) => patch(index, { required: e.target.checked })}
                  />
                  {t("common.required", locale)}
                </label>
              ) : (
                <span className="hidden sm:block" />
              )}
            </div>

            {field.field_type !== "section_break" ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
                <input
                  className={inputCls}
                  value={field.help_text}
                  onChange={(e) => patch(index, { help_text: e.target.value })}
                  placeholder={t("checklists.helpTextHint", locale)}
                  spellCheck
                />
                {field.field_type === "rating" ? (
                  <label className="flex items-center gap-2 text-sm text-sand-700">
                    {t("checklists.ratingMax", locale)}
                    <input
                      type="number"
                      min={2}
                      max={10}
                      className={`${inputCls} w-20`}
                      value={field.rating_max}
                      onChange={(e) => patch(index, { rating_max: Number(e.target.value) || DEFAULT_RATING_MAX })}
                    />
                  </label>
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="focus-ring rounded-md border border-sand-300 px-2 py-1 text-xs text-sand-700 disabled:opacity-40"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                {t("checklists.moveUp", locale)}
              </button>
              <button
                type="button"
                className="focus-ring rounded-md border border-sand-300 px-2 py-1 text-xs text-sand-700 disabled:opacity-40"
                disabled={index === fields.length - 1}
                onClick={() => move(index, 1)}
              >
                {t("checklists.moveDown", locale)}
              </button>
              <button
                type="button"
                className="focus-ring ml-auto rounded-md px-2 py-1 text-xs text-status-overdue"
                onClick={() => setFields((cur) => cur.filter((_, i) => i !== index))}
              >
                {t("checklists.removeField", locale)}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div>
        <button
          type="button"
          className="focus-ring rounded-lg border border-sand-300 px-3 py-2 text-sm font-medium text-sand-700 hover:bg-sand-50"
          onClick={() => setFields((cur) => [...cur, { ...EMPTY_FIELD }])}
        >
          + {t("checklists.addField", locale)}
        </button>
      </div>

      {error ? <p className="text-sm text-status-overdue">{error}</p> : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={() => void onSave()}
          className="focus-ring rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saving ? t("checklists.saving", locale) : t("checklists.saveTemplate", locale)}
        </button>
        <button
          type="button"
          onClick={() => router.push("/checklists")}
          className="focus-ring rounded-lg px-3 py-2 text-sm font-medium text-sand-600 hover:text-sand-900"
        >
          {t("common.cancel", locale)}
        </button>
      </div>
    </div>
  );
}
