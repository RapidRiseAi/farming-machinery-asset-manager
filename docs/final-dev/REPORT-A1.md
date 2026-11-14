# REPORT A1: register, equipment profile, entitlements, pricing

Saved by the runner from the worker's final message (the worker's harness refused to write this file). Text unchanged.

Task A1 is done on `final/lane-a` and ready for you to merge. Nothing was pushed, merged or applied to production. One thing differs from your instructions: the harness refused to let me write `docs/final-dev/REPORT-A1.md`, so the full report is below. `PROGRESS-lane-a.md` says "TASK A1 COMPLETE" and holds the A2 and lane B handover. Last commit `d1341ca`.

**Done**

| Step | Commit | What it delivers |
|---|---|---|
| 1 | `6fc30ee` | `docs/final-dev/REQUIREMENTS.md`: requirements R-001 to R-143 covering the whole brief, decisions D1 to D41 mapped, and inventory items I-001 to I-077 each given an owner or a classification. Rows A1 closed are marked "E (A1)" (`0b0e66c`). |
| 2 | `7b25ff5` | Migrations `20261114090000` and `20261114090100`. Adds `machines.profile` (full or equipment); every existing asset is full and nothing is repriced. One eligibility function, mirrored in TypeScript and pinned by a test. Three new types: compressor, workshop tool, other equipment. A guard stops the profile being changed directly. Adds a review list for unusual items and a read-only list of assets that could move. |
| 3 | `fe1d2b7` | Migration `20261114090200` and `src/lib/entitlements.ts`: one plan x profile x feature matrix in TS and SQL. Triggers on 9 tables refuse new restricted work for equipment, whatever path writes it. A trailer may still go on a vehicle's trip. New trips now need Professional and new routes or positions need Complete. Reports show equipment repair spend as its own subtotal and leave it out of TCO, cost per hour and fuel analysis. |
| 4 | `98c4c13` | Migration `20261114090300`: new price list `launch-2026-11-eq` with the annual prices stated (R490 / R790 / R990), 2 / 5 / 15 included equipment, R15 a month or R150 a year extra. Old agreements are pinned first. One renewal sum in SQL, matched by `src/lib/billing/calculator.ts`. The capacity check locks the subscription before counting. Adds the previews and the conversion. |
| 5 | `332ee88` | Fleet assets and Support equipment views with capacity shown. The add page asks which kind it is, then the equipment form. Convert dialog with the preview, review request, the import's new profile column, and `/admin/equipment-reviews`. |
| 6 | `d1341ca` | Docs and register updated. Follow-up migration `20261114090400`: moving an asset to another site was turning equipment into a full asset (it lost its profile), and equipment now keeps only insurance and "other" papers. |

**Scenarios covered**
- **1 and 2:** `calculator.test.ts`, `asset_capacity.sql` [1] [2], `view.test.ts`, `safety.test.ts`.
- **3, 4, 5 and 9:** `asset_capacity.sql` sections [3], [4], [5], [9].
- **14:** `equipment_restrictions.sql`, `equipment_profile.sql`, `csv.test.ts`, `entitlements.test.ts`.
- **15:** `equipment_restrictions.sql`.
- **16:** `equipment_restrictions.sql` and `reports/data.test.ts`.

I broke each new rule on purpose to check a test catches it: 19 breaks, all caught. Final gates on `d1341ca`: tsc, all 1095 unit tests, the six lint checks and all 76 PGlite SQL suites pass. CI on real Postgres has not run yet.

**Not done, and why**
- **Paying for an extra space mid-period** is A2's. Until then, a conversion or add that needs one is refused with `capacity-needed`, and the preview shows the charge as pending.
- **Signup with an equipment quantity and the 201+ quote route** is A2/A5. Moving old agreements onto the new price list is A2, as an agreed change.
- **Assistant wording for these refusals** is B4. Written stops, the trip workflow and map provider calls are B3.
- **Two sessions racing for the last space is not tested.** One psql session can't run two transactions at once. The suite proves the lock is taken before counting and that every add, import, restore and move past capacity is refused.
- **No browser check:** this worktree has no `.env.local`, so the new screens are type-checked and linted only.

**Assumptions**
- `atv_other` stays a full asset (an ATV drives itself).
- Equipment charged at renewal is what is in use then; paid extra equipment spaces reset to that at each renewal, while full spaces stay as bought.
- Fuel for a generator is recorded as a draw with no asset, so the tank still balances.
- Service, maintenance, warranty and insurance contracts are allowed on equipment; leases and rentals are not.
- Money in previews is shown only to the payer.
- The Rapid Rise review page is English only, like the rest of that console.

**Risks, most important first**
1. `billable_asset_count` and `farms.asset_count` now count full assets only.
2. Essential businesses can no longer start new trips; their existing trips stay readable.
3. A Professional business that had the map in testing loses it.
4. The capacity trigger now fires only on changes to status, deleted, site or profile, not on every update.
5. I edited `20261114090100` after `7b25ff5` (refusal messages became short codes). No other branch contains these commits, so apply its final form.

**External blockers:** none for A1. Next checks are your CI run and one browser pass on a test project.

**For A2:** price buying `equipment_extra_quota` mid-period. Add the equipment allowance to the plan-change quote (scenarios 7 and 8). Give signup an equipment quantity. Move the quote functions onto the stated period price before any annual price that isn't a whole multiple of the monthly one.

**For lane B:** the chat key is `general_chat`. Every map surface should use `mapsAvailable`. Refusals come back as `plan-feature-*` and `equipment-refused-*`. The assistant can check `public.has_asset_entitlement` before proposing a write.
