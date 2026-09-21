/**
 * What a notification actually SAYS, in both languages.
 *
 * `t()` returns the key it was given when there is no string for it, and a notification is
 * the one surface where that failure is invisible in development: the row is queued by SQL
 * at 03:00 and rendered on somebody else's phone. `pnpm i18n:keys` catches a missing static
 * key; it cannot catch a missing MEMBER of a group whose key is built at runtime from an
 * enum — `credentialType.${p.credential}` is composed from a database value, and a group
 * that is short one value renders `credentialType.medical` to a farmer.
 *
 * That has happened in this codebase: four billing status groups never existed and both
 * screens showed raw Postgres enums from day one. So every enum-keyed group used by this
 * formatter is walked here, value by value, in English and in Afrikaans.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { t } from "@/lib/i18n";
import { formatNotification, notificationTitle, notificationUrl } from "./format";

const LANGS = ["en", "af"] as const;

/** `public.driver_credential_type` — the migration's enum, written out. */
const CREDENTIAL_TYPES = [
  "drivers_licence",
  "prdp",
  "competency",
  "medical",
  "induction",
  "other",
] as const;

/** `public.licence_type` — the vehicle's documents, not the driver's. */
const LICENCE_TYPES = [
  "vehicle_licence",
  "roadworthy",
  "permit",
  "crossborder",
  "insurance",
  "other",
] as const;

test("every credential kind has a name in both languages", () => {
  for (const lang of LANGS) {
    for (const kind of CREDENTIAL_TYPES) {
      const key = `credentialType.${kind}`;
      const label = t(key, lang);
      assert.notEqual(label, key, `${key} renders its own key in ${lang}`);
      assert.ok(label.trim().length > 0, `${key} is blank in ${lang}`);
    }
  }
});

test("every vehicle licence kind still has a name in both languages", () => {
  for (const lang of LANGS) {
    for (const kind of LICENCE_TYPES) {
      const key = `licenceType.${kind}`;
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
  }
});

test("a driver credential reminder names the person and the document, in both languages", () => {
  for (const lang of LANGS) {
    const text = formatNotification(
      "driver_credential_expired",
      { person: "Sipho Ndlovu", credential: "prdp", expiry_date: "2026-08-21" },
      lang,
    );
    assert.ok(text.includes("Sipho Ndlovu"), `the person is missing in ${lang}: ${text}`);
    assert.ok(text.includes("2026-08-21"), `the date is missing in ${lang}: ${text}`);
    assert.ok(text.includes(t("credentialType.prdp", lang)), `the document kind is missing in ${lang}`);
    // The placeholders were all filled. A stray "{person}" on a farmer's phone is the
    // failure mode this whole file exists for.
    assert.ok(!/\{[a-z_]+\}/.test(text), `an unfilled placeholder survived in ${lang}: ${text}`);
  }
});

test("the reminder carries no licence number, because the payload never has one", () => {
  // The engine builds its payload without `number` on purpose — this text is delivered by
  // push and by email and read on a phone somebody else may be holding. If a future change
  // starts putting one in the payload, the formatter must still not print it.
  const text = formatNotification(
    "driver_credential_expiring",
    { person: "Sipho Ndlovu", credential: "drivers_licence", expiry_date: "2026-10-01", number: "L-12345" },
    "en",
  );
  assert.ok(!text.includes("L-12345"), `a licence number reached the inbox: ${text}`);
});

test("the push title says driver documents, and the click goes to the personnel page", () => {
  for (const lang of LANGS) {
    const title = notificationTitle("driver_credential_expired", lang);
    // The family chain falls through to the template name itself when nothing matches,
    // so a missing branch shows "pushTitle.driver_credential_expired" as the push title.
    assert.ok(!title.startsWith("pushTitle."), `the title fell through in ${lang}: ${title}`);
    assert.notEqual(title, notificationTitle("licence_expired", lang),
      "a driver's documents were titled as a vehicle licence renewal");
  }
  // No machine in the payload, so without its own branch this would land on the alert
  // centre and leave the farm to find the page themselves.
  assert.equal(
    notificationUrl("driver_credential_expired", { credential_id: "x", person: "Sipho" }),
    "/team/licences",
  );
});
