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
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Flash } from "@/components/ui/flash";
import {
  PlusIcon, CheckIcon, TrashIcon, ChevronUpIcon, ChevronDownIcon,
} from "@/components/ui/icons";
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
        <Field label={t("checklists.name", locale)} htmlFor="tpl-name">
          <Input
            id="tpl-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck
            autoCapitalize="sentences"
          />
        </Field>
        <Field label={t("checklists.machineType", locale)} htmlFor="tpl-type">
          <Select id="tpl-type" value={machineType} onChange={(e) => setMachineType(e.target.value)}>
            <option value="">{t("checklists.anyType", locale)}</option>
            {MACHINE_TYPES.map((mt) => (
              <option key={mt} value={mt}>
                {typeLabel(mt, locale)}
              </option>
            ))}
          </Select>
        </Field>
        {/* The hint was the placeholder, so it vanished the moment anyone typed. */}
        <Field
          label={t("checklists.description", locale)}
          htmlFor="tpl-desc"
          hint={t("checklists.descriptionHint", locale)}
          className="sm:col-span-2"
        >
          <Input
            id="tpl-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            spellCheck
            autoCapitalize="sentences"
          />
        </Field>
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
              <Field label={t("checklists.fieldType", locale)} htmlFor={`f${index}-type`}>
                <Select
                  id={`f${index}-type`}
                  value={field.field_type}
                  onChange={(e) => patch(index, { field_type: e.target.value as ChecklistFieldType })}
                >
                  {CHECKLIST_FIELD_TYPES.map((ft) => (
                    <option key={ft} value={ft}>
                      {fieldTypeLabel(ft, locale)}
                    </option>
                  ))}
                </Select>
              </Field>
              {/* Every input on this screen was labelled only by its placeholder. */}
              <Field
                label={
                  field.field_type === "section_break"
                    ? t("checklists.sectionHeading", locale)
                    : t("checklists.fieldLabel", locale)
                }
                htmlFor={`f${index}-label`}
              >
                <Input
                  id={`f${index}-label`}
                  value={field.label}
                  onChange={(e) => patch(index, { label: e.target.value })}
                  spellCheck
                  autoCapitalize="sentences"
                />
              </Field>
              {field.field_type !== "section_break" ? (
                <label className="flex min-h-[48px] items-center gap-2 self-end rounded-lg border border-sand-300 px-3 text-sm text-sand-700">
                  <input
                    type="checkbox"
                    className="h-5 w-5 rounded border-sand-300"
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
                <Field label={t("checklists.helpTextHint", locale)} htmlFor={`f${index}-help`}>
                  <Input
                    id={`f${index}-help`}
                    value={field.help_text}
                    onChange={(e) => patch(index, { help_text: e.target.value })}
                    spellCheck
                  />
                </Field>
                {field.field_type === "rating" ? (
                  <Field label={t("checklists.ratingMax", locale)} htmlFor={`f${index}-max`}>
                    <Input
                      id={`f${index}-max`}
                      type="number"
                      min={2}
                      max={10}
                      className="w-24"
                      value={field.rating_max}
                      onChange={(e) => patch(index, { rating_max: Number(e.target.value) || DEFAULT_RATING_MAX })}
                    />
                  </Field>
                ) : null}
              </div>
            ) : null}

            {/* Was three ~26px text-only buttons. Same three actions, at the size the
                thumb this product is built for actually needs, each with its glyph. */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ChevronUpIcon />
                {t("checklists.moveUp", locale)}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={index === fields.length - 1}
                onClick={() => move(index, 1)}
              >
                <ChevronDownIcon />
                {t("checklists.moveDown", locale)}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto text-status-overdue"
                onClick={() => setFields((cur) => cur.filter((_, i) => i !== index))}
              >
                <TrashIcon />
                {t("checklists.removeField", locale)}
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setFields((cur) => [...cur, { ...EMPTY_FIELD }])}
        >
          <PlusIcon />
          {t("checklists.addField", locale)}
        </Button>
      </div>

      {error ? <Flash tone="error" message={error} /> : null}

      {/* Sticky on a phone: the questions list is long, and the way out of a long
          form should not require scrolling back to find it. */}
      <div className="sticky bottom-0 -mx-1 flex items-center gap-3 border-t border-sand-200 bg-white/95 px-1 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:backdrop-blur-none">
        <Button type="button" variant="primary" disabled={saving} onClick={() => void onSave()}>
          <CheckIcon />
          {saving ? t("checklists.saving", locale) : t("checklists.saveTemplate", locale)}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.push("/checklists")}>
          {t("common.cancel", locale)}
        </Button>
      </div>
    </div>
  );
}
