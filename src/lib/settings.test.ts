import test from "node:test";
import assert from "node:assert/strict";

import {
  BILLING_FIELDS,
  OWNED_FIELD,
  SETTING_BOOLEANS,
  SETTING_NUMBERS,
  formOwnsBilling,
  mergeSettings,
  ownedKeys,
} from "./settings";

/** A real FormData, so these tests exercise the same interface the action passes in. */
function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

/** What a configured farm looks like: nothing at its default. */
const CONFIGURED = {
  due_soon_hours: 40,
  due_soon_days: 21,
  stale_reading_days: 7,
  vat_rate_bps: 1400,
  quiet_hours_start: 19,
  quiet_hours_end: 6,
  fuel_anomaly_pct: 33,
  fuel_anomaly_min_history: 9,
  warranty_lead_days: 60,
  warranty_hours_lead: 99,
  licence_lead_days: 45,
  aarto_nomination_lead_days: 7,
  repair_replace_pct: 75,
  utilisation_hours_per_day: 12,
  utilisation_km_per_day: 350,
  approval_required: true,
  cost_visible_to_operators: true,
  default_language: "en",
};

test("a partial form changes only what it declares", () => {
  const merged = mergeSettings(
    CONFIGURED,
    form({
      [OWNED_FIELD]: "quiet_hours_start quiet_hours_end",
      quiet_hours_start: "22",
      quiet_hours_end: "4",
    }),
  );

  assert.equal(merged.quiet_hours_start, 22);
  assert.equal(merged.quiet_hours_end, 4);

  // The point of the whole module: every other key survives untouched. Before the
  // merge these came back as defaults, which is a farm's configuration quietly erased.
  for (const [key, value] of Object.entries(CONFIGURED)) {
    if (key === "quiet_hours_start" || key === "quiet_hours_end") continue;
    assert.equal(merged[key], value, `${key} should have been carried over`);
  }
});

test("an undeclared boolean is not read from the form at all", () => {
  // `approval_required` is stored true. A form editing quiet hours contains no such
  // checkbox, so it posts nothing for it, which must NOT be read as "unchecked".
  const merged = mergeSettings(
    CONFIGURED,
    form({ [OWNED_FIELD]: "quiet_hours_start", quiet_hours_start: "21" }),
  );
  assert.equal(merged.approval_required, true);
  assert.equal(merged.cost_visible_to_operators, true);
});

test("a declared boolean reads false when its checkbox is absent", () => {
  // Same absence, opposite meaning, because this form owns the key: unticking a box
  // and saving has to be able to turn a setting off.
  const merged = mergeSettings(
    CONFIGURED,
    form({ [OWNED_FIELD]: "approval_required cost_visible_to_operators" }),
  );
  assert.equal(merged.approval_required, false);
  assert.equal(merged.cost_visible_to_operators, false);
});

test("a declared boolean reads true when its checkbox is ticked", () => {
  const merged = mergeSettings(
    { ...CONFIGURED, approval_required: false },
    form({ [OWNED_FIELD]: "approval_required", approval_required: "on" }),
  );
  assert.equal(merged.approval_required, true);
});

test("a form that declares nothing still owns every key", () => {
  // The old whole-form post. Every checkbox it omits reads false and the language it
  // omits reads "af", because it owns those keys.
  const merged = mergeSettings(CONFIGURED, form({ due_soon_hours: "30" }));
  assert.equal(merged.due_soon_hours, 30);
  assert.equal(merged.approval_required, SETTING_BOOLEANS.approval_required);

  /*
   * An omitted `<select>` keeps the stored language, where the old code reset it to
   * "af". Same reasoning as the number below, and the same unreachability: the select
   * was always in the one form, so it always posted a value.
   *
   * The asymmetry with the checkbox above is deliberate, not an oversight. An owned
   * checkbox that is absent MUST read false, because that is the only signal a browser
   * sends for "unticked" and otherwise a setting could never be turned off. A select
   * has no such silence: present means it posts a value, so absent can only mean the
   * form did not contain it, and keeping what is stored is then the safe reading.
   */
  assert.equal(merged.default_language, "en");

  /*
   * A number it omits keeps what is STORED (21), where the old `intOr` produced 0.
   *
   * Not a behaviour change in practice, because the whole-form post carried all
   * fifteen numbers on every save, so this branch was unreachable from the UI. It is
   * worth stating because the old default was also never what it looked like:
   * `Number(String(fd.get(k) ?? ""))` is `Number("")`, which is 0, and 0 is finite, so
   * `intOr(fd, k, 14)` returned 0 for a missing key and 14 only for a non-numeric
   * string. Keeping the stored value is the one option that cannot silently
   * re-configure a farm, so that is what this does in both paths.
   */
  assert.equal(merged.due_soon_days, 21);
});

test("an owned but empty number keeps the stored value, not the default", () => {
  const merged = mergeSettings(
    CONFIGURED,
    form({ [OWNED_FIELD]: "vat_rate_bps", vat_rate_bps: "" }),
  );
  assert.equal(merged.vat_rate_bps, 1400);
});

test("an owned but unparseable number keeps the stored value", () => {
  const merged = mergeSettings(
    CONFIGURED,
    form({ [OWNED_FIELD]: "due_soon_hours", due_soon_hours: "not a number" }),
  );
  assert.equal(merged.due_soon_hours, 40);
});

test("settings absent from storage fall back to defaults", () => {
  // A farm created before a setting existed has no key for it.
  const merged = mergeSettings({}, form({ [OWNED_FIELD]: "due_soon_hours", due_soon_hours: "12" }));
  assert.equal(merged.due_soon_hours, 12);
  assert.equal(merged.repair_replace_pct, SETTING_NUMBERS.repair_replace_pct);
  assert.equal(merged.default_language, "af");
});

test("a null settings blob is treated as empty, not as a crash", () => {
  const merged = mergeSettings(null, form({}));
  assert.equal(merged.due_soon_hours, SETTING_NUMBERS.due_soon_hours);
});

test("language only changes when declared", () => {
  const kept = mergeSettings(CONFIGURED, form({ [OWNED_FIELD]: "due_soon_hours", due_soon_hours: "1" }));
  assert.equal(kept.default_language, "en");

  const changed = mergeSettings(
    CONFIGURED,
    form({ [OWNED_FIELD]: "default_language", default_language: "af" }),
  );
  assert.equal(changed.default_language, "af");
});

test("every stored key round-trips when the form declares an empty list", () => {
  // `__fields=""` means "I own nothing", e.g. a form that only writes billing columns.
  const merged = mergeSettings(CONFIGURED, form({ [OWNED_FIELD]: "" }));
  for (const [key, value] of Object.entries(CONFIGURED)) {
    assert.equal(merged[key], value, `${key} should be untouched`);
  }
});

test("ownedKeys distinguishes absent from empty", () => {
  assert.equal(ownedKeys(form({})), null);
  assert.deepEqual(ownedKeys(form({ [OWNED_FIELD]: "" })), []);
  assert.deepEqual(ownedKeys(form({ [OWNED_FIELD]: "a  b,c" })), ["a", "b", "c"]);
});

test("billing is only written by a form that owns it", () => {
  // The hazard this guards: `update_farm_billing` overwrites all five columns from
  // whatever it is handed, so calling it from a quiet-hours form blanks the VAT number.
  assert.equal(
    formOwnsBilling(form({ [OWNED_FIELD]: "quiet_hours_start", quiet_hours_start: "20" })),
    false,
  );
  assert.equal(
    formOwnsBilling(form({ [OWNED_FIELD]: BILLING_FIELDS.join(" "), trading_name: "X" })),
    true,
  );
  // Legacy whole-form post: judged on what it actually carries.
  assert.equal(formOwnsBilling(form({ trading_name: "X" })), true);
  assert.equal(formOwnsBilling(form({ due_soon_hours: "1" })), false);
});

test("the number and boolean key sets do not overlap", () => {
  const numbers = Object.keys(SETTING_NUMBERS);
  const booleans = Object.keys(SETTING_BOOLEANS);
  for (const b of booleans) assert.ok(!numbers.includes(b), `${b} is in both sets`);
});
