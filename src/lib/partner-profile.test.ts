import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PARTNER_PROFILE_COLUMNS, PARTNER_PROFILE_GROUPS } from "./partner-profile";

const groups = Object.entries(PARTNER_PROFILE_GROUPS);
const declared = groups.flatMap(([, cols]) => cols as readonly string[]);

test("every editable column is reachable from exactly one group", () => {
  /*
   * A column in no group cannot be edited at all: no dialog declares it, so no dialog
   * posts it, so the action never writes it. A column in TWO groups is worse, because
   * whichever dialog you save last wins and the other silently overwrites it.
   */
  for (const column of PARTNER_PROFILE_COLUMNS) {
    const owners = groups.filter(([, cols]) => (cols as readonly string[]).includes(column));
    assert.equal(
      owners.length,
      1,
      `${column} is owned by ${owners.length} group(s): ${owners.map(([g]) => g).join(", ") || "none"}`,
    );
  }
});

test("no group names a column the action cannot write", () => {
  // The failure this catches: a misspelled column means the dialog owns nothing by that
  // name, so Save writes nothing and still says "Saved."
  for (const [group, cols] of groups) {
    for (const column of cols as readonly string[]) {
      assert.ok(
        (PARTNER_PROFILE_COLUMNS as readonly string[]).includes(column),
        `group "${group}" names "${column}", which is not an editable profile column`,
      );
    }
  }
});

test("the column list matches what the action actually writes", () => {
  /*
   * Read the action and pull the keys out of its `ownedUpdate` spec. Keeping the list in
   * this module and the spec in the action is a duplication, and this is the assertion
   * that stops them drifting: add a column to the action and forget the list, and it
   * becomes uneditable on a screen that now edits group by group.
   */
  const source = readFileSync(
    join(process.cwd(), "src/app/(app)/contractor/settings/actions.ts"),
    "utf8",
  );
  const spec = source.slice(
    source.indexOf("const patch = ownedUpdate(formData, {"),
    source.indexOf("  const { error } = await supabase"),
  );
  assert.ok(spec.length > 0, "could not find the ownedUpdate spec in the action");

  // Only top-level keys of the spec object: two spaces of extra indent, then `key: () =>`.
  const keys = [...spec.matchAll(/^    ([a-z_]+): \(\) =>/gm)].map((m) => m[1]);
  assert.ok(keys.length > 20, `only found ${keys.length} spec keys, the regex has drifted`);

  assert.deepEqual(
    [...keys].sort(),
    [...PARTNER_PROFILE_COLUMNS].sort(),
    "the action's ownedUpdate spec and PARTNER_PROFILE_COLUMNS disagree",
  );
});

test("every field the screen posts is one the action reads", () => {
  /*
   * The bug this exists for, found the hard way: the action read `vat_percent` and
   * nothing on that screen has ever posted it. `VatRateField` shows a percent box with
   * NO `name` and posts a hidden `vat_rate_bps` in basis points, so the read always fell
   * through to its `?? "15"` default and `default_vat_rate_bps` was written as 1500 on
   * every save no matter what the partner typed. The control was decorative, and the
   * value it failed to store goes onto their tax invoices.
   *
   * Nothing could see it. The names are strings on both sides, so `tsc` is happy, the
   * build compiles, and the screen says "Saved." This walks the form's own `name=`
   * attributes and insists each one is a column the action writes, a field the merge
   * layer owns, or a documented alias.
   */
  const page = readFileSync(
    join(process.cwd(), "src/app/(app)/contractor/settings/page.tsx"),
    "utf8",
  );
  const vatField = readFileSync(join(process.cwd(), "src/components/vat-rate-field.tsx"), "utf8");

  const posted = new Set(
    [...page.matchAll(/name="([a-z_]+)"/g), ...vatField.matchAll(/name="([a-z_]+)"/g)].map(
      (m) => m[1],
    ),
  );
  assert.ok(posted.size > 20, `only found ${posted.size} posted fields, the scan has drifted`);

  // Fields that are not profile columns but are read for a reason.
  const ALLOWED_EXTRAS = new Set([
    "__fields", // which columns this partial form owns (src/lib/partial-form.ts)
    "vat_rate_bps", // VatRateField posts basis points; the action maps it to default_vat_rate_bps
  ]);

  const columns = new Set<string>(PARTNER_PROFILE_COLUMNS);
  for (const field of posted) {
    assert.ok(
      columns.has(field) || ALLOWED_EXTRAS.has(field),
      `the form posts "${field}" and nothing reads it; a field name that matches nothing ` +
        `saves silently and reports success`,
    );
  }

  // And the reverse, which is how the VAT bug survived: the action must not read a
  // field the form never sends.
  assert.ok(posted.has("vat_rate_bps"), "VatRateField no longer posts vat_rate_bps");
});

test("no column is listed twice within one group", () => {
  for (const [group, cols] of groups) {
    const list = cols as readonly string[];
    assert.equal(new Set(list).size, list.length, `group "${group}" repeats a column`);
  }
});

test("the groups cover every column between them", () => {
  assert.equal(new Set(declared).size, PARTNER_PROFILE_COLUMNS.length);
});
