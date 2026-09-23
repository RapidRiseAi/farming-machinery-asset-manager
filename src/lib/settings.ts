/**
 * The farm's settings blob, and how a submitted form merges over it.
 *
 * == Why this is not inline in the server action ==============================
 * Because it had a bug waiting in it, and a pure function is the only version of it
 * that can be tested.
 *
 * `updateSettings` rebuilt the WHOLE blob out of one `FormData`, falling back to a
 * hardcoded DEFAULT for anything the form did not carry. That is correct exactly as
 * long as one form on one screen posts all eighteen keys together, which is how
 * `/settings` used to work: twenty-two input boxes and a single Save.
 *
 * The moment the screen shows what the farm is configured to do and edits ONE group at
 * a time, that fallback becomes data loss. Saving quiet hours would have posted two
 * keys and silently reset the other sixteen to their defaults: the farm's VAT rate back
 * to 15%, its service thresholds back to 25 hours, its language back to Afrikaans. No
 * error, no warning, and the screen would then truthfully report the defaults it had
 * just written.
 *
 * So a partial form declares what it owns (`__fields`), and everything it does not
 * declare is carried over from what is already stored. A form that declares nothing is
 * treated as owning everything, which is the old whole-form behaviour, unchanged, for
 * anything still posting that way.
 */

import { OWNED_FIELD, ownedKeys, ownsAny, type FormLike } from "./partial-form";

// Re-exported so existing call sites and tests keep one import.
export { OWNED_FIELD, ownedKeys };
export type { FormLike };

export const SETTING_NUMBERS = {
  due_soon_hours: 25,
  due_soon_days: 14,
  stale_reading_days: 30,
  vat_rate_bps: 1500,
  quiet_hours_start: 20,
  quiet_hours_end: 5,
  fuel_anomaly_pct: 50,
  fuel_anomaly_min_history: 3,
  warranty_lead_days: 30,
  warranty_hours_lead: 50,
  licence_lead_days: 30,
  aarto_nomination_lead_days: 14,
  repair_replace_pct: 60,
  utilisation_hours_per_day: 10,
  utilisation_km_per_day: 200,
} as const;

export const SETTING_BOOLEANS = {
  approval_required: false,
  cost_visible_to_operators: false,
} as const;

/** The billing identity fields, which live in real columns rather than the blob. */
export const BILLING_FIELDS = [
  "trading_name",
  "reg_number",
  "vat_number",
  "billing_address",
  "billing_email",
] as const;

export type FarmSettings = Record<string, number | boolean | string>;

function currentNumber(current: Record<string, unknown>, key: string, dflt: number): number {
  const v = current[key];
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

/**
 * Merge a submitted form over the stored settings.
 *
 * Precedence for each key: the form, if it owns the key and sent a usable value; then
 * what is already stored; then the default. Anything the form does not own is never
 * read from it at all, so a stray field cannot reach past its own group.
 */
export function mergeSettings(
  current: Record<string, unknown> | null | undefined,
  form: FormLike,
): FarmSettings {
  const stored = current ?? {};
  const declared = ownedKeys(form);
  const owns = (key: string) => declared === null || declared.includes(key);

  const out: FarmSettings = {};

  for (const [key, dflt] of Object.entries(SETTING_NUMBERS)) {
    const kept = currentNumber(stored, key, dflt);
    if (!owns(key)) {
      out[key] = kept;
      continue;
    }
    // An owned key that arrived empty or unparseable keeps what is stored rather than
    // dropping to the default: clearing a box should not silently re-configure the farm.
    const raw = String(form.get(key) ?? "").trim();
    const n = Number(raw);
    out[key] = raw !== "" && Number.isFinite(n) ? n : kept;
  }

  for (const [key, dflt] of Object.entries(SETTING_BOOLEANS)) {
    const kept = typeof stored[key] === "boolean" ? (stored[key] as boolean) : dflt;
    // An unchecked checkbox posts NOTHING, which is indistinguishable from a form that
    // does not contain the checkbox at all. That is the whole reason `__fields` exists:
    // ownership is declared, so an owned boolean reads false when absent, and an
    // unowned one is never consulted.
    out[key] = owns(key) ? form.get(key) === "on" : kept;
  }

  const storedLang = stored.default_language === "en" ? "en" : "af";
  out.default_language = owns("default_language")
    ? String(form.get("default_language") ?? storedLang) === "en"
      ? "en"
      : "af"
    : storedLang;

  return out;
}

/**
 * Does this form carry the billing identity?
 *
 * `update_farm_billing` overwrites all five columns from whatever it is handed, so a
 * form that does not own them must not call it. It would blank the farm's VAT number
 * on a screen that was editing quiet hours.
 */
export function formOwnsBilling(form: FormLike): boolean {
  return ownsAny(form, BILLING_FIELDS);
}
