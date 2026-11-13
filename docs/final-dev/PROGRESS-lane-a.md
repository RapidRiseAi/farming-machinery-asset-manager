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
rules on child tables (migration `20261114090200_equipment_entitlements.sql`).

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
