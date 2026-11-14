# Lane A progress (branch final/lane-a, worktree C:\projects\.fw-lane-a)

Read this and `git log` first when resuming. Never restart a step that is marked done.

## Task

A1 of `C:\projects\output\fleetwise-final-dev\MASTER-PLAN.md`: requirement register for the
whole BRIEF, equipment profile model, central entitlements (plan x profile x feature), pricing
calculator and capacity, assets UI, tests for scenarios 1, 2, 3, 4, 5, 9, 14, 15, 16.

## Steps

| # | Step | State |
|---|---|---|
| 1 | Requirement register `docs/final-dev/REQUIREMENTS.md` | done |
| 2 | Equipment profile model | done |
| 3 | Central entitlements matrix and server enforcement | in progress |
| 4 | Pricing calculator and capacity | not started |
| 5 | Assets UI | not started |
| 6 | Tests and docs | not started |

## In progress

Step 3: entitlements matrix in `src/lib/entitlements.ts`, SQL mirror and the database
rules on child tables (migration `20261114090200_equipment_entitlements.sql`, written:
feature_min_rank with trips 2, maps 3, budgets 2, depreciation 2 and every-plan keys;
app.profile_refuses; app.farm_plan_allows; app.asset_allows; public.has_asset_entitlement
(listed open in pay_gate_functions.sql); app.refuse_equipment_work trigger on
driving_sessions, driver_device_links, asset_positions, fuel_issues,
fuel_card_transactions, budgets, finance_agreements, tyre_fitments, trips; trailer guard on
trips; licence road types; asset_contracts lease/rental; depreciation method on equipment;
plan gates on insert: trips/trip_jobs/trip_income/trip_expenses = trips (Professional),
trip_routes/asset_positions = maps (Complete); driving_vehicles and farm_book_values leave
equipment out).

Done in step 3 (WIP commit): `supabase/tests/equipment_restrictions.sql` (passes on
PGlite; 5 mutations caught: fuel rule, tco refusal, trailer guard, trips rank, depreciation),
probe and run.sh line; slugs instead of English in 20261114090100's refusals (not yet
applied anywhere, so edited in place); `src/lib/entitlements.ts` CAPABILITY_MIN_PLAN,
PROFILE_REFUSES, profileRefuses, assetAllows, NOT_YET_ADVERTISED (maps hidden on the
signup comparison) + `entitlements.test.ts` pinning both to the migration;
`machineAllows` in auth.ts used by machine page (analyticsVisible, fuelAllowed),
file.pdf, sale pack (pack-data); `mapsAvailable` in features.ts (Complete AND flag) used by
every former `featureOn("map")` site incl. /api/positions and routing access; trips page
gated by `trips` with UpgradeNotice and no equipment as vehicles; reports data split
`maintenanceByProfile`, equipment rows no TCO/cost per hour, no fuel analysis; reports
page shows the labelled subtotal; error codes `equipment-refused-*`, `plan-feature-*`,
`equipment-type-not-eligible`, `equipment-review-*` in errors.ts with EN/AF keys.

Next in step 3: run the new report test through `pnpm -s test` (it needs the server-only
shim; `npx tsx --test` alone fails on `server-only`), API v1 `profile` column, full gates,
then the step-3-done commit.

Step 2 delivered: `20261114090000_machine_types_equipment.sql` (compressor, workshop_tool,
other_equipment), `20261114090100_equipment_profile.sql` (`machines.profile`,
`app.equipment_eligible`, guard trigger, `asset_classification_reviews`,
`request_/decide_asset_classification_review`, `equipment_profile_candidates`),
`src/lib/machine-options.ts` (EQUIPMENT_ELIGIBLE_TYPES etc.), `machine-options.test.ts`,
`supabase/tests/equipment_profile.sql` (3 mutations caught). DATABASE.md names
`convert_asset_profile`, which arrives in step 4.

Baseline at `6e3830a` before any change: tsc clean, 1074 unit tests pass, dashes, parity,
keys, design and errors gates clean.

## Decisions and assumptions

- Founder (via the manager, 13 Nov): this work will be released to production as it is
  finished. Every migration must be safe on live data: additive, defaults that change no
  customer's price or access, no long locks.
- Eligible types: pump_generator, compressor, workshop_tool, implement, trailer,
  other_equipment. atv_other stays full (an ATV is self-propelled). other_equipment on the
  equipment profile opens a Rapid Rise review automatically; a review never converts or
  bills by itself.
- The profile changes only through the conversion function (runs as owner); the guard
  refuses any direct change by authenticated, anon or service_role (it reads current_user,
  so it is SECURITY INVOKER).

## Blockers

(none yet)

## For task A2

(filled in at the end of A1)
