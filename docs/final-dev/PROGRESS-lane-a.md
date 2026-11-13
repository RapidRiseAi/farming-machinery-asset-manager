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
| 2 | Equipment profile model | in progress |
| 3 | Central entitlements matrix and server enforcement | not started |
| 4 | Pricing calculator and capacity | not started |
| 5 | Assets UI | not started |
| 6 | Tests and docs | not started |

## In progress

Step 2: designing the profile column, eligibility function and review flag (migration
`20261114090000_equipment_profile.sql`).

Baseline at `6e3830a` before any change: tsc clean, 1074 unit tests pass, dashes, parity,
keys, design and errors gates clean.

## Decisions and assumptions

(none yet)

## Blockers

(none yet)

## For task A2

(filled in at the end of A1)
