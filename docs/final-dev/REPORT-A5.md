# REPORT A5: website, sign-up, wording and the revised plan PDF

Lane A, branch `final/lane-a`, 19 November 2026, from `7f08d1f`; the website in `C:\projects\fleetwise-launch-polish` on branch `claude/launch-polish` (committed locally, never pushed, published or deployed). Built by the main Claude session itself. BRIEF section 22 and deliverable 8 (and 25.8, 25.9); scenario 41.

Gates in lane A at the final code commit: tsc clean; 1251 unit tests pass; dashes, i18n parity and keys, design lint, errors clean; `node scripts/migrate_check.mjs --suite` 98/98. Website: `npm run build` (prerender and static checks) and `npm test` pass; all eight browser scripts pass (browser, state, feature, hero, mobile UX, story, scroll, menu and plans), both layouts; screenshots of the pricing section inspected at 1366 and 390 px. Mutations: 5/5 for the commercial source test; the website's storage guard proven by inserting the old line.

## 1. Done

| Part | What was built | Commits |
|---|---|---|
| Source of truth | `docs/commercial-source.json`, dated 2026-11-19, price list `launch-2026-11-eq`: plan prices, included equipment, the minimum, the online limit, extra equipment, the storage formula and R49 block, media limits (app and WhatsApp), the 30% usage margin, plan gates, not-yet-available features, Done-For-You floors and the optional services. `src/lib/commercial-source.test.ts` checks every value against the code (calculator, entitlements, limits, service rules) and the database defaults against their migrations, and that every readiness flag created unreleased is listed as not yet available. | `84be784` |
| Sign-up prefill | `src/app/(public)/signup/prefill.ts` reads `plan`, `period`, `vehicles` and `equipment` from the website's link: only a sellable plan, a known period and whole counts in range pass; anything else is dropped. The plan picker starts from them; the server action still prices and validates what is submitted (A2), so nothing activates from a link. Tests in `prefill.test.ts`. | `a43a873` |
| Customer guidance | `/help` gains "How FLEETWISE works": support equipment, spaces and storage, the spending limit, staff chat (not yet available; support sees chats only in a recorded visit), downloading records, payments, grace and cancelling, phones and offline. English and Afrikaans. | `8d09ec7` |
| Website pricing | `src/shared/pricing.mjs`: dated source fields, included equipment per plan, extra equipment, pooled storage, `quoteSoftware` with equipment, `compareMix` (all three totals, the lowest for the mix, no best-value claim), `storageFor`. Equipment counter, equipment in every plan total, "Lowest total for this mix" on desktop and mobile. Comparison rows for equipment, storage, driving logs, trips, staff chat and maps (not yet available), WhatsApp (questions and alerts; photos and voice not yet available), AI within the owner's limit. Sign-up and enquiry links carry equipment when above zero. Stale "100 MB per asset, at least 1 GB" removed in three places, with a guard. | website `a0f820d` to `f8ffc92`, `a43ae17` |
| Website checks | `scripts/check-content.mjs` checks `pricing.mjs` against `src/shared/commercial-source.json` (a copy of the app's file), the equipment, lowest-total and storage examples, the not-yet-available rows and no best-value claim; `browser-check.mjs` asserts R440 / R545 / R495 and the lowest mark on Essential for 5 full spaces and 15 equipment, in both layouts. | website `ac0c2ae`, `f8ffc92` |
| Website records | Dated 19 November sections in `docs/COMMERCIAL.md` (the new commercial facts; the brief's not-yet-available rule supersedes the 2 November "all live" note for staff chat, maps and WhatsApp photos and voice) and `docs/FEATURE-SOURCES.md`. | website `a43ae17` |
| Revised plan review PDF | `C:\projects\output\pdf\review-2026-11-19\Fleetwise-Plan-Review-2026-11-19.pdf`, 9 A4 pages, built by `C:\projects\output\pdf\build_fleetwise_review_2026-11-19.mjs` from `docs/commercial-source.json` (Chromium print of fixed A4 pages; no Python with reportlab on this machine, so the brief's "equivalent verified layout"). The builder fails if any page's content overflows its box; every page was rendered to PNG (`pages/`) and inspected; one defect found and fixed (storage sizes written with a decimal comma read as thousands). Covers plans and prices, full assets and support equipment, billing examples (five mixes, monthly and annual, lowest marked, storage), plan gates, limits by channel, usage, changes and the lifecycle, optional services and Done-For-You, and a readiness appendix that reports no pending test as passed. The 12 and 13 November PDFs and the old builder are untouched. | outside the repo |

## 2. Requirements and scenarios

| Covered | By |
|---|---|
| R-140 (website table with equipment, minimum, extra price, annual totals, storage, assistance), scenario 41 | website `scripts/check-content.mjs`, `scripts/browser-check.mjs` |
| R-141 (sign-up carries the choice, never activates from a link) | `src/app/(public)/signup/prefill.test.ts`, A2's `billing_signup_capacity.sql` |
| R-142 (aligned copy, dated source of truth, revised PDF) | `src/lib/commercial-source.test.ts`; the PDF and its page images |
| R-143 (EN/AF guidance) | `/help`, i18n parity and keys gates |

R-140, R-141, R-142 and R-143 are now E; I-077 resolved. R-054 (precise legal wording) stays C: legal text is listed for the lawyer below, not changed by A5.

## 3. Not done, and why

- **The website is not published.** Founder approval is required; the branch is local.
- **The app's other plan surfaces** (sign-up, `/billing`, the conversion preview, renewal notices, cancellation) were rewritten by A1 to A4 against the same catalogue; A5 checked them for stale figures (none found: no "1 GB", no best-value claim) rather than rewriting them again.
- **No browser walk of `/help` and `/signup?plan=...` in the app** (no `.env.local` in the lane); type-checked, linted, unit-tested.
- **The website's copy of the source JSON is a copy.** A change to the app's file must be copied too; the website's test then fails until `pricing.mjs` agrees.

## 4. Assumptions

1. The website shows `equipment` in links only when above zero, so existing links and behaviour stay identical for a visitor with no equipment.
2. "Lowest total for this mix" is a fact about that mix, shown on the cheapest plan's card; the existing visual emphasis on Professional is kept as design, with no words claiming value.
3. Storage in the website calculator counts the plan's included equipment as equipment spaces (A3's rule).
4. The brief's "not yet available" rule (13 November) governs over the 2 November owner note that every advertised capability is live, for staff chat, maps and WhatsApp photos and voice.

## 5. Risks

1. **The website and the app must release together**: the website now sends `equipment`, which the live app ignores until this release ships (harmless: the visitor chooses again).
2. **Two copies of the source** (app and website); the website test catches drift only when someone copies the file.

## 6. Legal text changes for the lawyer (collected across the tasks)

1. **`src/lib/legal.ts`, TERMS_VERSION 2026-11-15 (A2):** changes mid-period (priced for the days left, paid before they take effect, credit never refunded), failed payment (seven days' grace, then 90 days owner-only read and export), cancelling (stops the next renewal, access to the paid-through date, no automatic refund), records. The refund line in the cancel dialog.
2. **`src/lib/legal.ts`, TERMS_VERSION 2026-11-18 (A3):** "What it costs": one owner-chosen spending limit for paid AI, voice and WhatsApp, no default; landed provider cost plus 30%; free WhatsApp messages at R0; the pooled storage allowance and R49 blocks billed monthly also on annual plans.
3. **Retention and deletion (A4, REPORT-A4.md section 8, 11 questions):** the 90-day window and 30-day delay, five-year billing records, what survives a deletion, the deletion ledger, backups under POPIA, warning timing, exports versus personal access requests, private chat, Done-For-You acceptance by tick box and the CPA, once-off order refunds, Rapid Rise staff exports.
4. **Driver hours page (B3):** "South Africa sets no number for this".
5. **Open questions carried from A2:** do CPA s14 and s16 and ECTA s44 apply to these business customers?
6. **Website (A5, for the same read before publishing):** the pricing and comparison copy, "Cancel any time from the billing screen", and the FAQ on usage charges and WhatsApp.

## 7. For the next tasks

- **B5:** documents and imports stay in the app; WhatsApp has no document path.
- **A6:** add the website release (founder-approved) beside the app release; copy `docs/commercial-source.json` to the website whenever prices change; the review PDF is rebuilt with `node build_fleetwise_review_2026-11-19.mjs <source> <dir with playwright> <out>` (rename for a new date).
