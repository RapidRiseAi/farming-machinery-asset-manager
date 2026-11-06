/**
 * FLEETWISE is for any fleet. Before an account's type is known (signed out, in emails, for
 * contractors and Rapid Rise) nothing may read as if it were for farms, and once it is known
 * each kind of company reads its own words. A new string that says "farm" fails here, on
 * purpose: write {{org}}, or add it to the list below with a reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import en from "./en.json" with { type: "json" };
import af from "./af.json" with { type: "json" };
import enPro from "./en.professional.json" with { type: "json" };
import afPro from "./af.professional.json" with { type: "json" };
import { companyOf, companyTypes, langOf, localeOf, t, toneOf, wordsFor, type Lang } from "./index";

type Tree = { [key: string]: string | Tree };

function strings(tree: Tree, prefix = ""): [string, string][] {
  return Object.entries(tree).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === "string" ? ([[key, v]] as [string, string][]) : strings(v, key);
  });
}

/** Names of things, not the product talking about itself. */
const ALLOWED = new Set(["companyType.farm"]);

/** {farm} is a placeholder for the customer's own name; the words around it are what count. */
const withoutPlaceholders = (s: string) => s.replace(/\{[A-Za-z]+\}/g, "");

test("nothing universal says farm or farmer", () => {
  const found = [...strings(en as Tree), ...strings(enPro as Tree)]
    .filter(([k]) => !ALLOWED.has(k))
    .filter(([, v]) => /\bfarm(s|er|ers)?\b/i.test(withoutPlaceholders(wordsFor(v, "en"))));
  assert.deepEqual(found, []);
});

test("nothing universal says plaas or boer in Afrikaans", () => {
  const found = [...strings(af as Tree), ...strings(afPro as Tree)]
    .filter(([k]) => !ALLOWED.has(k))
    .map(([k, v]) => [k, withoutPlaceholders(wordsFor(v, "af"))] as const)
    // "plaas" is also "to place", and these are the forms that mean it.
    .map(([k, v]) => [k, v.replace(/\b(in plaas van|in plaas daarvan|plaaslik\w*|plaasvind\w*|geplaas|te plaas)\b/gi, "")] as const)
    .filter(([, v]) => /\bplaas\b|\bplase\b|\bboere?\b|plaas(eienaar|bestuurder|kantoor|data|rekords)/i.test(v));
  assert.deepEqual(found, []);
});

test("every word is filled in, in every language and for every company", () => {
  const langs: Lang[] = [
    "en", "af", "en-pro", "af-pro",
    ...companyTypes.flatMap((c) => [langOf("en", "friendly", c), langOf("af", "professional", c)]),
  ];
  for (const lang of langs) {
    const dictionary = localeOf(lang) === "af" ? af : en;
    for (const [key] of strings(dictionary as Tree)) {
      assert.doesNotMatch(t(key, lang), /\{\{/, `${key} in ${lang}`);
    }
  }
});

test("each kind of company reads its own words", () => {
  const says = (company: (typeof companyTypes)[number]) => t("nav.groupFarm", langOf("en", "friendly", company));
  assert.equal(says("farm"), "Farm");
  assert.equal(says("goods_transport"), "Company");
  assert.equal(says("other"), "Business");
  assert.equal(t("nav.groupFarm", "en"), "Business");
  assert.equal(t("nav.groupFarm", langOf("af", "friendly", "farm")), "Plaas");
});

test("a farm is on the farm, a company is in the company", () => {
  assert.equal(wordsFor("{{on}} the {{org}}", langOf("en", "friendly", "farm")), "on the farm");
  assert.equal(wordsFor("{{on}} the {{org}}", langOf("en", "friendly", "delivery")), "in the company");
  assert.equal(wordsFor("{{On}} die {{org}}", langOf("af", "friendly", "farm")), "Op die plaas");
});

test("machines stay machines where that is the word, and are vehicles elsewhere", () => {
  assert.equal(wordsFor("{{Assets}}", langOf("en", "friendly", "construction")), "Machines");
  assert.equal(wordsFor("{{Assets}}", langOf("en", "friendly", "passenger_transport")), "Vehicles");
  assert.equal(wordsFor("{{Assets}}", "en"), "Vehicles");
});

test("a Lang gives back each of the things put into it", () => {
  const lang = langOf("af", "professional", "game_drive");
  assert.equal(lang, "af-pro@game_drive");
  assert.equal(localeOf(lang), "af");
  assert.equal(toneOf(lang), "professional");
  assert.equal(companyOf(lang), "game_drive");
  assert.equal(companyOf("en-pro"), null);
  assert.equal(toneOf("en@farm"), "friendly");
});

test("a placeholder for somebody's own name is never turned into a word", () => {
  // A swap once rewrote {machine} too, and a warranty notice printed "{vehicle}" instead of
  // the machine's name.
  const found = [...strings(en as Tree), ...strings(af as Tree)].filter(([, v]) => v.includes("{{{"));
  assert.deepEqual(found, []);
  for (const [key, value] of strings(en as Tree)) {
    const placeholders = (s: string) => (s.match(/(?<!\{)\{[A-Za-z]+\}(?!\})/g) ?? []).sort();
    const other = key.split(".").reduce<string | Tree | undefined>(
      (at, part) => (at && typeof at === "object" ? at[part] : undefined),
      af as Tree,
    );
    if (typeof other === "string") assert.deepEqual(placeholders(other), placeholders(value), key);
  }
});

test("no customer-facing string still spells the name another way", () => {
  const found = strings(en as Tree).filter(([, v]) => /Fleet ?Wise/.test(v));
  assert.deepEqual(found, []);
});
