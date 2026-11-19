/**
 * Customer-defined asset fields (task B5, 20261121100000). The database checks every value
 * again (public.asset_field_set); this module only turns a submitted form into the JSON that
 * function takes, and lays a definition's value out for reading. Values are data: rendered as
 * text by React, never as markup.
 */

export const FIELD_TYPES = ["text", "number", "date", "yes_no", "choice"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_VISIBILITY = ["everyone", "managers"] as const;
export type FieldVisibility = (typeof FIELD_VISIBILITY)[number];

export type FieldDefinition = {
  id: string;
  key: string;
  label: string;
  field_type: FieldType;
  unit: string | null;
  choices: string[];
  required: boolean;
  visibility: FieldVisibility;
  group_label: string | null;
  sort_order: number;
  retired_at: string | null;
};

export type FieldValue = {
  definition_id: string;
  value_text: string | null;
  value_number: number | string | null;
  value_date: string | null;
  value_bool: boolean | null;
};

/** The form name of one field's input on the asset form. */
export const fieldInputName = (definitionId: string) => `field_${definitionId}`;

/** Choices typed one per line or separated by commas; blanks and repeats dropped. */
export function parseChoices(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,]/)) {
    const choice = part.trim();
    if (choice) seen.add(choice);
  }
  return [...seen];
}

/**
 * The submitted asset form as {definition id: value or null} for the active definitions shown.
 * An unticked yes/no box is false; an empty input is null (the database refuses null for a
 * required field and keeps the earlier value of nothing else).
 */
export function valuesFromForm(form: FormData, definitions: readonly FieldDefinition[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of definitions) {
    if (d.retired_at) continue;
    const name = fieldInputName(d.id);
    if (d.field_type === "yes_no") {
      // Only when the form carried the field (a marker input), so a partial form changes nothing.
      if (form.has(`${name}__shown`)) out[d.id] = form.get(name) === "1";
      continue;
    }
    if (!form.has(name)) continue;
    const raw = String(form.get(name) ?? "").trim();
    if (!raw) { out[d.id] = null; continue; }
    out[d.id] = d.field_type === "number" ? Number(raw.replace(",", ".")) : raw;
  }
  return out;
}

/** One value as words for reading: the number with its unit, a date as typed, yes or no. */
export function displayValue(d: FieldDefinition, v: FieldValue | undefined, yes: string, no: string): string | null {
  if (!v) return null;
  switch (d.field_type) {
    case "number": {
      if (v.value_number === null || v.value_number === undefined) return null;
      const n = Number(v.value_number);
      return d.unit ? `${n} ${d.unit}` : String(n);
    }
    case "date": return v.value_date;
    case "yes_no": return v.value_bool === null ? null : v.value_bool ? yes : no;
    default: return v.value_text;
  }
}

/** Definitions in reading order: by group (ungrouped first), then the business's order. */
export function groupDefinitions(definitions: readonly FieldDefinition[]): Array<{ group: string | null; fields: FieldDefinition[] }> {
  const groups = new Map<string | null, FieldDefinition[]>();
  for (const d of [...definitions].sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label))) {
    const key = d.group_label ?? null;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
    .map(([group, fields]) => ({ group, fields }));
}
