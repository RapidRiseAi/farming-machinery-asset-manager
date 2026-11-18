# Lane A progress (branch final/lane-a, worktree C:\projects\.fw-lane-a)

Read this and `git log` first when resuming. Never restart a step that is marked done.

## Current task: A3 (pooled storage, paid blocks, shared assistance spending cap)

BRIEF 11 and 12; decisions 14, 15, 22, 23, 24, 34, 36; scenarios 24, 25, 26, 30, 31, 32 (and the
storage/assistance half of 12). Started 17 Nov 2026 on 48b7987 (A1, B1, A2, Codex B2 and B3 merged).

| # | Step | State |
|---|---|---|
| 1 | Storage allowance and pool (migration 20261118120000): pooled customer allowance, quota hooks replaced, files from before the pipeline counted (nightly snapshot of untracked objects), 80/95% warnings, status function, auto blocks setting with ceiling, transactional auto block; suite storage_pool.sql | SQL done (12/12 mutations); TS in step 4 |
| 2 | Storage blocks billing (20261118120100): buy through A2's quotes (change 'storage'), reductions scheduled at the next storage month and never below what is stored, storage charge ledger, recurring monthly charge on the period invoice (monthly) and on the usage invoice (annual), generic cost-plus storage retired; suite storage_blocks.sql | SQL done (12/12 mutations); TS in step 4 |
| 3 | Assistance cap (20261118120200): customer-wide budget table, existing limits migrated as chosen (owners told), blank refuses (budget_unset), customer-wide lock and spend, staff sublimits across sites, WhatsApp on the same ledger (owner acceptance, hold before send, settle on the delivery webhook's pricing, free = R0, stale = R0), event fields, AI use of every pooled site invoiced, usage corrections as credit; suite assistance_cap.sql | SQL done (16/16 mutations); usage corrections as credit NOT built (see report) |
| 4 | TS storage: mirror + tests, /billing storage section (status, warnings, blocks, auto setting), upload refusal offers expansion, admin usage page | done (gates passed at the step 4 commit; no browser run) |
| 5 | TS assistance: /settings/ai setup (required, zero allowed, migrated notice, reset boundary), refusals, WhatsApp hooks and acceptance, admin rates | todo |
| 6 | Docs, register rows, REPORT-A3.md | todo |

Design (decided at the start, keep to it):
- Pool = the billing root (`app.billing_root`) and every site billed through it. Allowance per
  pool: F = max(purchased full spaces or counted, price minimum); E = included equipment of the
  price + extra equipment paid (metered: max(included, in use)); included = max(2e9, F x 1e8 +
  E x 2.5e7); total = included + blocks x 1e10. `app.storage_quota_overrides` (Rapid Rise by
  hand) still wins when set. Next renewal figures use pending quantities.
- Counted bytes = finalised pipeline files not removed + open reservations + bytes of objects in
  the business's folders with no upload intent (files from before the pipeline and old upload
  paths), measured nightly into `storage_usage_snapshots` (one row per pool per day; also the
  per-period usage record). Not counted: billing-proofs, partner-*, menu-media and the
  temporary command-audio bucket (removed by its own sweep, so no loophole).
- Blocks: R49 per 10 GB per month (billing_settings, snapshotted on every charge), monthly
  even for annual software. Storage month = the period for monthly subscriptions; for annual,
  months stepped from the period start on the anchor day. Manual purchase = A2 quote, change
  'storage', paid change invoice raises `storage_blocks`. Automatic = OFF by default; owner
  sets a monthly rand ceiling counting existing blocks; under the pool and subscription locks
  the block is added at once and the pro-rata amount is a storage charge on the next invoice.
  Reduction = pending_storage_blocks at the next storage month, refused if what is stored would
  not fit; nothing is deleted.
- Assistance: `assistance_budgets` keyed by the billing root. No row = no paid work
  ('budget_unset'). Existing businesses get their current effective limit as a 'migrated'
  choice and an owner notice. Trial cap (never paid, test) and the owner maximum stay as
  guards. Month = calendar month in Africa/Johannesburg for every plan (AI_USAGE.md), shown
  explicitly. WhatsApp messages go on the same ledger (feature 'whatsapp_message'); billing for
  them starts only when Rapid Rise sets a start date and the rates (Meta charges on delivery;
  the account's rate-card currency is an account fact).

Log:
- 17 Nov: read PROGRESS, register rows, BRIEF 11/12/23, decisions, A2 and B1 reports, the AI
  ledger, the upload pipeline, A2 quotes and the invoice generators. Meta pricing docs read
  (developers.facebook.com/docs/whatsapp/pricing and the status webhook reference): charged
  per delivered message; `pricing.type` regular = billable, free_customer_service and
  free_entry_point free; 1,000 free service messages per number per month from 1 Oct 2026;
  currency fixed per account (ZAR not in the list). Next: step 1.
- 18 Nov: steps 1 and 2 SQL committed (through 623d917). The full notice is a separate call
  (public.storage_note_full) because the refusal rolls back its own transaction. The usage
  invoice (kind ai_usage) now also carries storage for annual subscribers and the AI use of
  pooled sites (it never reached them before); one usage invoice per customer per day is an
  index (billing_payment_integrity.sql adjusted). Suites must use app.billing_today() for
  storage months and current_date for the invoice run (they differ 22:00 to 24:00 UTC).
  Tool trap: a Bash command containing "=>" hangs this harness; use edit.js with a spec file.
  Next: step 3 (assistance cap migration 20261118120200).
- 18 Nov (after a usage-limit stop): step 3 SQL committed (through the 16/16 mutation commit).
  Migrated value = the billing site's own farm_ai_settings limit or the R200 default, so the
  trial guard reproduces every current effective limit exactly. ai_usage.sql and
  test_account_fence.sql now choose a budget in their fixtures. Next: step 4 (TS storage), then
  step 5 (TS assistance and the WhatsApp hooks).
- 18 Nov: step 4 done. Full SQL suite 87/87 at 6fbd349. Storage catalogue entries in
  limits.ts, src/lib/storage-allowance.ts (+ test pinned to the migration), StorageCard on
  /billing (blocks through requestChange change=storage, saveStorageAuto), upload refusal
  calls storage_note_full, nightly cron_storage_measure, /admin/usage is a cost view only
  (raiseUsageInvoice removed). Gates: tsc, 1177 unit tests (0 fail), dashes, parity, keys,
  design, errors. Next: step 5.

## A2 (complete)

**TASK A2 COMPLETE** (17 Nov 2026). Final gates: tsc clean, 1162 unit tests, dashes, parity,
keys, design and errors clean, all 82 PGlite suites pass (292 migrations). Mutations: 35 of 35
caught. The harness refused to write `docs/final-dev/REPORT-A2.md` (as for A1 and B1): the full
report is the worker's final message; the runner saves it as the report. CI on real Postgres and
a browser walk are the next checks.

BRIEF 15, 4 (signup range), 16 first paragraph; decisions 25, 26, 27, 38, 39, 41; scenarios
6, 7, 8, 10, 11, 12, 40. Started 15 Nov 2026 on c75eed6 (A1 and B1 merged).

| # | Step | State |
|---|---|---|
| 1 | Additions: quote, accept, pay, then capacity (migration 20261115110000) | done |
| 2 | Plan changes: upgrade now with credit, downgrade at renewal, pending edit/cancel | done |
| 3 | Cancellation: period end only for owners, wording, legal flags | done |
| 4 | Failed renewal: grace 7 days, then 90 days owner-only retrieval, then closed (20261115120000) | done |
| 5 | Reactivation without duplicate charge or replay | done (billing_lifecycle.sql: pay in grace, in retrieval, after the window; reopen) |
| 6 | Payment integrity: out-of-order settles, void invoice payments, quote version, uniqueness | done (settle guards in 20261115110000; billing_payment_integrity.sql) |
| 7 | Signup: 5 to 200 full spaces with equipment; 201+ capacity quote request | done (20261115130000; billing_signup_capacity.sql; /signup and /admin/billing) |

Design (decided at the start, keep to it):
- `billing_change_quotes`: one row per priced change (target plan, period, full spaces, extra
  equipment spaces), with the basis it was priced on, charge now, credit, next renewal, expiry
  (30 minutes or the next SAST midnight). Accept recomputes under the subscription lock and
  refuses `quote-changed` / `quote-expired`. Mode `now` (more spaces, plan up) raises a `change`
  invoice; capacity rises only when that invoice is PAID (trigger on billing_invoices, every
  payment path). Mode `renewal` (fewer spaces, plan down, period change) writes the existing
  pending_* columns. A cheaper upgrade is a credit in `billing_account_credits`, never a
  negative payment; credit is applied to the next invoice as a payment with provider `credit`.
- `change` invoices never count towards overdue, are never charged by the nightly run, never
  dun on decline; unpaid ones are voided at expiry (unless a payment is in flight).
- Lifecycle keeps `farm_billing_gate`'s four values (ok, pending, suspended, closed): grace is
  `ok` plus `app.farm_paid_extras_allowed` false; `suspended` and billing `closed` are the 90-day
  owner-only retrieval (reading limited to the owner in `app.stopped_farm_ids` and
  `app.require_open_farm`), and past `retrieval_ends_on` nothing is readable.

Log:
- Migration `20261115110000_billing_change_quotes.sql` written (SQL side of steps 1 and 2 plus
  the settle guards of step 6): `app.billing_today` (SAST), `app.farm_payment_late`,
  `app.billing_change_state` (pricing), quote/accept/apply/cancel/expire, change invoice, credit
  ledger and spending, payment trigger, `due_billing_charges` and `settle_billing_attempt`
  restated (no change invoices at night, no dunning on a declined change, a succeeded attempt is
  final, failure duns once), `apply_pending_plan_changes` marks quotes applied, A1's
  `asset_capacity_state` now prices `charge_now` (status `quote`). Suite
  `billing_change_quotes.sql` passes (scenarios 6, 7, 8, 10); 15 mutations all caught.
- TypeScript side done (through d824238): `calculator.ts` mirror (prorateCents, additionCents,
  upgradeDifference, lostFeatures) + `change.test.ts`; service quoteChange/acceptQuote/
  cancelQuote/creditBalance/changeRefusal; `beginCheckout({invoiceId})`; openInvoiceForFarm
  skips change invoices; actions requestChange/acceptChange/payChange/cancelChange (runOnce);
  `components/billing/change-review.tsx`; /billing reads stored quotes; cron step
  expire_quotes; receipts print change lines; conversion review shows the price; EN/AF keys and
  error codes. 1160 unit tests and all lint gates pass. Steps 1 and 2 DONE: tsc, 1160 unit tests, dashes, parity, keys,
  design, errors and all 79 PGlite suites pass.
- Step 4 (lifecycle) written: migration `20261115120000_billing_lifecycle.sql` (retrieval_ends_on,
  `app.farm_billing_gate_on` on SAST days, owner-only reading in `stopped_farm_ids` and
  `require_open_farm`, `farm_paid_extras_allowed`, pause lifted by trigger, cancellations
  pause the farm row and open 90 days, suspensions stop retries, owner notices and 30/7/1-day
  reminders, `public.farm_lifecycle`, AI/voice `billing_paused`, WhatsApp off in grace).
  Suite `billing_lifecycle.sql` passes; 15 lifecycle mutations caught (re-run of the quote
  batch with the fixed harness: 15 of 15 caught with their FAIL messages). pay_gate.sql updated
  (a contractor no longer reads a suspended customer). TS: /suspended and /closed show who may
  read and until when, owner-only download, pay to reopen an unpaid account, export route
  refuses non-owners in words, grace notice and credit on /billing, notification templates.
  Next: step 3 wording (terms, cancel dialog, owner cancels at period end only), then gates.
- 17 Nov (resumed): steps 3 to 6 committed (1933476 and after). billing_review_5.sql money-10 failed
  today: its simulation set the anchor to the pre-fix start day, so it passed only on days 1 to 15
  of a month; fixed the simulation (anchor = day billing starts, the approved rule) and added a
  direct assertion of the rule (mutation caught on any date). The redundant uniqueness migration
  was dropped (index exists since 20261010090000). Now: step 7 (signup suite, TS, admin list). Next: step 3 cancellation (owner period-end only, wording, legal flags).

## A1 (complete)

A1 of `C:\projects\output\fleetwise-final-dev\MASTER-PLAN.md`: requirement register for the
whole BRIEF, equipment profile model, central entitlements (plan x profile x feature), pricing
calculator and capacity, assets UI, tests for scenarios 1, 2, 3, 4, 5, 9, 14, 15, 16.

## Steps

| # | Step | State |
|---|---|---|
| 1 | Requirement register `docs/final-dev/REQUIREMENTS.md` | done |
| 2 | Equipment profile model | done |
| 3 | Central entitlements matrix and server enforcement | done |
| 4 | Pricing calculator and capacity | done |
| 5 | Assets UI | done |
| 6 | Tests and docs | done |

**TASK A1 COMPLETE** (14 Nov 2026). Final gates on the last commit: tsc clean, 1095 unit
tests, dashes, parity, keys, design, errors clean, and all 76 PGlite suites pass (287
migrations). CI on real Postgres is the manager's next check.

## In progress

(nothing: A1 is complete; the history below is kept for whoever resumes this lane)

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

Step 3 finished: report split test (mutation caught), API v1 `profile` column and
docs/PUBLIC_API.md line; tsc, 1086 unit tests, all gates and 75 PGlite suites pass.
Left for step 5 (UI): the machines list TCO column per row, hiding refused tabs on an
equipment asset page (`isEquipment` is already computed in machines/[id]/page.tsx).

Step 4 (now): migration `20261114090300_equipment_pricing_capacity.sql`. Written and
committed (WIP, not yet run): price version columns period_price_incl_cents,
equipment_included, equipment_period_incl_cents + check + freeze; app.billing_space_period_cents,
app.billing_renewal_cents; pin then retire launch-2026-11, insert launch-2026-11-eq;
app.self_service_max_full_spaces (200); billing_subscriptions.equipment_extra_quota;
app.billing_root, billable_asset_count (full only), billable_equipment_count,
recount_farm_assets (full only), billing_subscription_for; capacity trigger (locks the
subscription row; slugs vehicle-limit-reached, equipment-limit-reached,
equipment-not-in-agreement); farm_vehicle_allowance pooled; retired-equipment work
refused (equipment-retired) on job_cards, faults, meter_readings, checklist_instances,
work_requests; invoice equipment columns, derive totals, freeze; generator with
equipment line; renewal notice with equipment.
Step 4 DONE: also asset_profile_changes, public.convert_asset_profile (lock, blockers,
capacity-needed, preview-changed), public.asset_capacity_summary, asset_add_preview,
asset_conversion_preview (charge_now.status quote_pending for A2), equipment_migration_preview
(app.equipment_migration_state); billing reads behind app helpers listed in
billing_subscription.sql's sweep; `supabase/tests/asset_capacity.sql` (scenarios 1 to 5, 9;
6 mutations caught); billing (0), pricing 2026-11 and onboarding suites moved to the
-eq generation; `src/lib/billing/calculator.ts` + `calculator.test.ts` (2 mutations caught);
PLAN_PRICING has perVehicleAnnualCents and includedEquipment, ANNUAL_MONTHS_CHARGED and
perVehicleMonthlyCents gone (perVehiclePeriodCents; pricing.ts keeps
LEGACY_ANNUAL_MONTHS_CHARGED for old rows); billing estimate and page show the equipment
line; capacity refusal slugs in errors.ts EN/AF. Gates: tsc, 1094 unit tests, dashes,
parity, keys, design, errors, 76 PGlite suites pass.

Step 5 DONE: `src/components/machines/asset-views.tsx` (AssetViews, CapacityFacts,
EquipmentProfileNote), `asset-kind.tsx` (AssetKindChooser), `conversion-review.tsx`;
machines list `?view=equipment` with counts and capacity; add page asks which kind
(`?profile=equipment`), equipment form (eligible types, make/model where known, no tank);
createMachine and importMachines carry the profile (import `profile` column, aliases,
profile_invalid / profile_not_eligible); machine page: equipment note instead of upgrade
prompts, licence kinds limited, Convert dialog with the preview, classification review;
`/admin/equipment-reviews` (Rapid Rise, English like the console) with nav entry;
fuel cards never match equipment, tyres never offer it. Not checked in a browser: no
.env.local in this worktree (ui:check needs the app running against a database).
Gates: tsc, 1095 unit tests, all lints; SQL unchanged since step 4 (76 suites).

Step 6 (now): PLAN_FEATURES.md, BILLING.md, REQUIREMENTS.md states, REPORT-A1.md.

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

- Buy capacity mid-period: extend the quota change (or a sibling) to raise
  `billing_subscriptions.equipment_extra_quota` pro rata to the renewal, and fill
  `charge_now.cents` in `app.asset_capacity_state` (status `quote_pending` today). Until then a
  conversion or add that needs a paid space is refused with `capacity-needed` /
  `equipment-limit-reached`. The invoice run resets `equipment_extra_quota` at each renewal.
- `app.billing_plan_change_quote` prices full spaces only: add the allowance difference
  (scenarios 7 and 8: 5 full + 15 equipment, Professional R545 vs Complete R495).
- `create_pending_signup` needs an equipment quantity (`equipment_extra_quota` =
  max(0, E - A); the first invoice already bills it for a pending subscription) and the 200
  line (`app.self_service_max_full_spaces()`, `signupRoute` in calculator.ts).
- Agreements on `launch-2026` / `launch-2026-11` have no equipment terms (refused with
  `equipment-not-in-agreement`); moving one to `launch-2026-11-eq` is an accepted change.
- Quote functions still read per_vehicle x months; a price-row check keeps that equal to
  `period_price_incl_cents`. Move them to `app.billing_space_period_cents` before any annual
  price that is not a whole multiple. The billing page's annual note says ten months.
- Lane B: chat key `general_chat`; maps via `mapsAvailable`; trips need Professional at the
  table (`plan-feature-trips`), routes/positions Complete (`plan-feature-maps`); equipment
  refusals are `equipment-refused-<feature>`; `public.has_asset_entitlement` for the assistant.

## Risks recorded at the end of A1

1. `app.billable_asset_count` and `farms.asset_count` now count full assets only.
2. New trips need Professional at the table; Essential businesses keep old trips readable.
3. Maps need Complete plus the flag; a Professional business testing the map loses it.
4. The capacity trigger fires only on status, deleted_at, farm_id and profile updates.
5. `20261114090100` was edited after `7b25ff5` (slugs) before any merge; apply its final form.
6. Concurrency is proven by the lock (structural) and sequential refusals, not by two sessions.
7. New screens are type-checked and linted only: no browser run (no .env.local here).

The full A1 report (done with commits, scenarios by test, not done, assumptions, risks,
blockers, handover) is in the worker's final message: writing a separate REPORT-A1.md file
was refused by the agent harness.
