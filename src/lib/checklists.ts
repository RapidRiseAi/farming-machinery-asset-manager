// Shared checklist model + helpers (feature F11). Pure TypeScript, no server-only
// imports, so it is safe in both server pages and client islands (the template
// builder + the fill renderer), keeping the SQL field-type model and the UI in step.

import { t, type Lang } from "@/lib/i18n";

/** The field types a checklist template supports (matches the SQL check in 0290). */
export const CHECKLIST_FIELD_TYPES = [
  "checkbox",
  "text",
  "number",
  "photo",
  "rating",
  "section_break",
] as const;

export type ChecklistFieldType = (typeof CHECKLIST_FIELD_TYPES)[number];

export function isChecklistFieldType(v: string): v is ChecklistFieldType {
  return (CHECKLIST_FIELD_TYPES as readonly string[]).includes(v);
}

export const DEFAULT_RATING_MAX = 5;

/** The 1..N scale of a rating field (defaults to 5). */
export function ratingMax(config: Record<string, unknown> | null | undefined): number {
  const n = Number(config?.max);
  return Number.isFinite(n) && n >= 2 && n <= 10 ? Math.round(n) : DEFAULT_RATING_MAX;
}

/** Translated label for a field type (checklistField.* keys). */
export function fieldTypeLabel(ft: ChecklistFieldType, locale: Lang): string {
  return t(`checklistField.${ft}`, locale);
}

/**
 * Render a stored value_text for display (read-only saved view). Photo values live in
 * the attachment, so they render null here; section breaks have no value.
 */
export function formatChecklistValue(
  fieldType: ChecklistFieldType,
  valueText: string | null,
  locale: Lang,
): string {
  if (fieldType === "section_break" || fieldType === "photo") return "";
  if (valueText == null || valueText === "") return "-";
  if (fieldType === "checkbox") {
    return valueText === "true"
      ? t("common.yes", locale)
      : valueText === "false"
        ? t("common.no", locale)
        : "-";
  }
  if (fieldType === "rating") return valueText;
  return valueText;
}

/** True when a required, non-layout field has no answer (used to gate submit). */
export function isChecklistValueEmpty(
  fieldType: ChecklistFieldType,
  valueText: string | null,
  hasPhoto: boolean,
): boolean {
  if (fieldType === "section_break") return false;
  if (fieldType === "photo") return !hasPhoto;
  return valueText == null || valueText.trim() === "";
}
