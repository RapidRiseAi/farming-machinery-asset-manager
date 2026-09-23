/**
 * Which fields does a submitted form actually own?
 *
 * == The problem, once, instead of once per screen =============================
 * Several server actions in this product rebuild a whole row or a whole settings blob
 * out of one `FormData`, substituting a default for anything absent. That is correct
 * while ONE form on ONE screen posts every field together, and it becomes silent data
 * loss the moment a screen edits one group at a time in a dialog.
 *
 * `/settings` was the first: saving quiet hours would have reset the farm's VAT rate,
 * its service thresholds and its language. `/contractor/settings` is the same shape and
 * worse, because the columns it would have reset are the ones that appear on a
 * contractor's tax invoices: `vat_registered`, `default_vat_rate_bps`, the quote and
 * invoice and credit-note number prefixes, and the letterhead colours.
 *
 * So a partial form states what it is responsible for, in a hidden `__fields`, and an
 * action consults nothing else. A form that says nothing owns everything, which is the
 * old whole-form behaviour, unchanged, for anything still posting that way.
 */

/** The hidden field a partial form uses to declare the keys it is responsible for. */
export const OWNED_FIELD = "__fields";

/** Just enough of FormData to be callable from a test without one. */
export type FormLike = {
  has(key: string): boolean;
  get(key: string): FormDataEntryValue | null;
};

/**
 * The keys a form claims to own, or `null` when it claims all of them.
 *
 * `null` and `[]` are deliberately different answers: absent means "I am the whole
 * form", empty means "I own none of these", which is what a form that only writes
 * columns outside this set posts.
 */
export function ownedKeys(form: FormLike): string[] | null {
  if (!form.has(OWNED_FIELD)) return null;
  return String(form.get(OWNED_FIELD) ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
}

/** Does this form own `key`? True for a whole-form post. */
export function owns(form: FormLike, key: string): boolean {
  const declared = ownedKeys(form);
  return declared === null || declared.includes(key);
}

/** Does this form own any of `keys`? Use it to decide whether a write should run at all. */
export function ownsAny(form: FormLike, keys: readonly string[]): boolean {
  const declared = ownedKeys(form);
  if (declared === null) return keys.some((k) => form.has(k));
  return keys.some((k) => declared.includes(k));
}

/**
 * Build an update object holding only the columns this form owns.
 *
 * `spec` maps a column to how to read it. A column the form does not own is left OUT of
 * the result entirely, rather than set to a default, so the database keeps what it has.
 * That is the whole point: an omitted key and a key set to its default are the same
 * thing to `.update()` only if you never cared what was there before.
 */
export function ownedUpdate<T extends Record<string, unknown>>(
  form: FormLike,
  spec: { [K in keyof T]: () => T[K] },
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(spec) as (keyof T)[]) {
    if (owns(form, String(key))) out[key] = spec[key]();
  }
  return out;
}
