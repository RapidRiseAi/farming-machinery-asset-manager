# The database, by area

A map of the Supabase Postgres schema as it stands on 11 November 2026: 137 tables and 8
views in `public`, 9 tables in `app`, about 600 functions, and the rules every table follows. Table names
are grouped by the part of the product they serve; the migration that created each one is
the authority on its columns (`supabase/migrations`, applied in filename order).

## The rules every table follows

- **Row-level security on everything, forced.** 142 tables have RLS and 116 force it, so even
  the table owner is bound by the policies. A table with RLS and no policies is service-only
  (the server's service key reaches it, no browser does): `request_claims`,
  `driver_connection_secrets`, `place_search_cache`, `place_search_slot`,
  `notification_*_delivery`, `whatsapp_inbox`, `whatsapp_media`, `support_settings`,
  `farm_closure_requests` and the `app` bookkeeping tables. Supabase's advisor lists them as
  a warning; that is the intended shape.
- **Who the caller is comes from the database, not the request.** Policies and functions ask
  `app.effective_farm_role(auth.uid(), farm_id)`, `app.has_farm_access`, `app.is_rr_admin`,
  `app.has_permission` and their relatives. Rapid Rise's powers need a two-step session
  (`aal2`), checked in the database (20261014100000).
- **A business that has not paid cannot work through anybody's session, its own included**
  (20261112090000). Every table with a `farm_id` carries restrictive `pay_gate_*` policies:
  while `app.farm_billing_gate` is not `ok`, a member cannot insert, update or delete that
  business's rows. A `suspended` or `closed` business is read by its OWNER only, for 90 days
  (`billing_subscriptions.retrieval_ends_on`; the export reads through the owner's session),
  and by nobody after that (20261115120000, decisions 38 and 41); a `pending` one, which never
  paid, cannot be read at all. A row with no farm (the shared libraries) is never stopped, and
  Rapid Rise never is. `app.stopped_farm_ids(writing)` names the caller's stopped businesses
  once per statement, never per row. Tables a stopped business must keep (billing, the
  person's account and memberships, notifications, help, closure, handover) are listed
  `open` in `app.pay_gate_rules` with the reason; a contractor's own books are
  `contractor_open`, stopped for the customer but not for the contractor. A new table with
  `farm_id` calls `app.pay_gate_apply('table')` or gets a rules row; `pay_gate.sql` fails
  until it does. The farm buckets in Storage follow the same rule (`pay_gate_*` on
  `storage.objects`, the business read from the path's first folder).
- **A `security definer` function runs as its owner, past those policies, so it checks the
  pay gate itself** (20261112100000): `app.require_open_farm(farm, writing)`, called once the
  function knows the business and has checked the caller, raises 42501 `farm-not-active`
  (which the app says in the person's language) on the same rule as the tables. Rapid Rise,
  the service role and a business the caller does not reach pass through. Functions for
  paying, the person's own account, help, Rapid Rise staff and a contractor's own books are
  left open on purpose; the list and the reasons are in the migration's header, and
  `pay_gate_functions.sql` fails when a new definer function a person can call is neither
  checked nor listed there.
- **Notifications are written by the system.** Owner-run functions (`app.notify_farm` and
  its relatives) write every one; a person's session cannot insert one, and deletes only
  their own (20261112100000).
- **Policies call `auth.uid()` once per query**, as `(select auth.uid())`, since
  20261111150000. Write new policies the same way.
- **RPCs that run as their owner check the caller themselves.** A `security definer`
  function reachable from a browser must verify membership, role and the account's state
  before it reads or writes; its tests in `supabase/tests` prove a member of one business
  cannot reach another's rows through it. The check may live in a helper it calls first:
  `has_entitlement` asks `app.has_farm_access` before it reads a plan, so it answers "no"
  for a business the caller does not reach, and for a call with no user (the service role)
  (0251; `rls_isolation.sql` F5 pins both, and the public wrapper).
- **The `app` schema is not exposed.** PostgREST serves `public` only, so `app.*` helpers
  are reachable from policies and other functions, never from `supabase.rpc()`. A screen that
  needs one calls a thin `public` wrapper.
- **Costs are hidden from operators by views.** The eight `*_visible` views
  (`job_cards_visible`, `fuel_issues_visible`, ...) are owned by a dedicated reader role and
  blank the cost columns unless `app.can_view_farm_costs(farm_id)` says yes. They are not
  `security_invoker` on purpose: the base tables deny those columns to the `authenticated`
  role, so a caller-rights view would deny them to everyone.
- **Every change to a business's data is logged** in `audit_log`, with `app.audit_table_rules`
  saying which columns of each table a reader may see (20261028090000 to 20261028093000).
- **Test accounts are fenced** (`is_test` on farms, workshops and users, 20261014120000):
  triggers refuse a row that ties a test account to a real one, and `app.test_fence` is the
  one switch a direct SQL session sets to move data across.
- **Service-only functions are granted to `service_role` and revoked from `authenticated`
  and `anon`**; `security_surface.sql` fails if an anonymous caller can execute a trigger
  function, and the suites check the grants of the functions they cover.

## Businesses and people

`farms` (a business of any kind; `company_type` sets the words), `users` (profiles, one per
login, `role` and `farm_id` or `workshop_id`), `user_farm_memberships` (a person on more
than one site), `user_permission_grants` (named extras such as `manage_stock`),
`farm_feature_access` (features in testing switched on per business, such as `map`),
`feature_flags`, `farm_ownership_transfers`, `farm_closures` and `farm_closure_requests`
(the permanent closure and its five-year purge), `farm_ai_settings`, `farm_ai_keys`,
`farm_member_ai_limits`, `member_qr_receipts`, `api_tokens`, `dashboard_layouts` (each
person's dashboard), `sync_log`.

## Vehicles and machinery

`machines` (every vehicle or machine; `meter_type` hours or km; `profile` full or equipment,
which only `convert_asset_profile` changes and `app.equipment_eligible(type)` limits to
support equipment, 20261114090100), `asset_classification_reviews` (an owner or an
other-equipment asset asks Rapid Rise to check a classification; never bills by itself),
`asset_profile_changes` (every conversion between profiles with the preview it was accepted on,
20261114090300), `meter_readings`,
`meter_replacements`, `attachments` (photos and files), `asset_aliases` (the names people
say), `asset_contracts` (leases, rentals, service contracts), `asset_positions` (where a
vehicle was, kept 180 days), `licences`, `driver_credentials`, `tyres`, `tyre_fitments`,
`tyre_checks`, `watch_items`, `cost_entries` (every cost against a machine), `budgets`,
`billing_asset_snapshots` (what was billed for, per period).

**Plan x profile x feature is enforced at the table** (20261114090200): `app.profile_refuses`,
`app.asset_allows` and `public.has_asset_entitlement` mirror `src/lib/entitlements.ts`; a trigger on
`driving_sessions`, `driver_device_links`, `asset_positions`, `fuel_issues`, `fuel_card_transactions`,
`budgets`, `finance_agreements`, `tyre_fitments` and `trips` refuses new restricted work for support
equipment (slug `equipment-refused-<feature>`); a trip may name an equipment trailer only; road
licences, leases and a depreciation method are refused for equipment; a new trip, load or trip
money needs Professional, a planned route or position Complete (`plan-feature-*`). New ordinary
work on retired or sold equipment is refused (`equipment-retired`, 20261114090300). A move to another
site keeps the profile, and equipment keeps only insurance and other dated papers (20261114090400).

## Work: faults, job cards, service, parts

`faults`, `job_cards`, `job_card_lines`, `job_card_service_lines`, `job_card_line_receipts`,
`work_requests` and `work_request_events` (work asked of a partner), `service_templates`,
`service_plan_lines`, `service_kits`, `service_kit_items`, `parts_catalogue`, `stock_items`,
`stock_movements`, `checklist_templates`, `checklist_template_fields`,
`checklist_instances`, `checklist_instance_values`, `warranty_claims`, `incidents`
(accidents and claims), `fines` (AARTO), and in `app`: `job_machine_baselines` and
`job_service_baselines` (what a job card's completion changed, so it can be traced).

## Fuel

`fuel_tanks`, `fuel_deliveries`, `fuel_dips`, `fuel_issues` (diesel drawn, per machine),
`fuel_card_statements` and `fuel_card_transactions` (card statements matched to vehicles).

## Driving: trips, routes, trackers

`trips`, `trip_jobs` (loads and deliveries), `trip_expenses`, `trip_income`, `trip_routes`
(the planned route, its stops and distance), `driving_sessions` and `driving_events` (a
driver's record), `driver_connections`, `driver_connection_secrets` and
`driver_device_links` (vehicle trackers and other feeds), `routing_usage` (route requests
and searches per month), `place_search_cache` and `place_search_slot` (the place search's
shared cache and one-a-second queue). `docs/ROUTING.md` and `docs/DRIVER_ACTIVITY.md`.

## Partners, suppliers and the books

`workshops` (a partner business), `workshop_links` (which farms it works for), `partners`,
`partner_applications`, `partner_invites`, `partner_clients`, `partner_client_vehicles`,
`partner_documents`, `partner_document_lines`, `partner_document_revisions` (quotes,
invoices, corrections), `partner_payments`, `partner_expenses`, `document_emails`,
`suppliers`, `purchase_orders`, `purchase_order_lines`, `recurring_invoices`,
`recurring_invoice_lines`, `recurring_expenses`, `bank_statement_imports`, `bank_lines`.

## Paying Rapid Rise

`billing_settings` (the seller's details; the bank details live only in
`eft_instructions`), `billing_price_versions`, `billing_subscriptions`, `billing_invoices`,
`billing_invoice_lines`, `billing_payments`, `billing_payment_attempts`,
`billing_payment_methods`, `billing_webhook_events`, `billing_promo_codes`,
`billing_service_catalogue`, `done_for_you_quotes`, `usage_logs`, `usage_rates`, `fx_rates`.
Since 20261114090300 a price row states its period price and its equipment terms
(`period_price_incl_cents`, `equipment_included`, `equipment_period_incl_cents`; current generation
`launch-2026-11-eq`), a subscription holds `equipment_extra_quota`, an invoice carries its equipment
count and price, and `app.billing_enforce_vehicle_quota` locks the subscription before it counts
either profile. `public.asset_capacity_summary`, `asset_add_preview`, `asset_conversion_preview`,
`convert_asset_profile` and `equipment_migration_preview` are the previews and the conversion.
`billing_change_quotes` (20261115110000) is every priced mid-period change: its basis, target,
charge, credit, next renewal, expiry, acceptance and outcome; a `now` change raises a `change`
invoice and is made only when that invoice is paid (trigger on `billing_payments`), a
`renewal` change writes the pending columns. `billing_account_credits` is append-only account
credit (an upgrade that lowers the price, money for a change that could no longer be made),
spent on the next invoice as a payment with provider `credit`. The lifecycle (20261115120000):
`app.farm_billing_gate_on` answers for any South African day, `app.farm_read_allowed` and
`app.farm_paid_extras_allowed` decide owner-only reading and the grace, `public.farm_lifecycle`
says where a business stands for the stopped screens. `capacity_quote_requests`
(20261115130000) holds a request for more than 200 full spaces made at sign-up (Rapid Rise
only; no farm yet, so no pay gate). `docs/BILLING.md`.

## AI and voice

`ai_usage`, `ai_reservations`, `ai_prices`, `ai_interactions`, `ai_voice_sessions`,
`ai_health_events`, `voice_captures`, and `app.assistant_turn_buckets` (the per-minute
allowance). `docs/AI_USAGE.md`.

## Alerts, messages and support

`notifications`, `notification_push_delivery`, `notification_email_delivery`,
`whatsapp_notification_delivery`, `push_subscriptions`, `whatsapp_links`,
`whatsapp_link_challenges`, `whatsapp_inbox`, `whatsapp_media`, `support_tickets`,
`support_ticket_messages`, `support_visits` (each time Rapid Rise opened a business),
`support_settings`, `support_holidays`, `report_schedules`, `report_schedule_recipients`,
`report_schedule_runs`.

## Files and uploads

`attachments` (above) is the record of a stored file. `upload_intents` (20261115090000) is
one direct upload on its way there: the person, the business (or a contractor's workshop),
the record, the object path the server chose, what was declared, what the server read back
from Storage, the bytes reserved against the storage pool and its status (reserved,
uploaded, finalised, failed, expired). Written only by `upload_begin` and `upload_commit`
(a person's session) and the service-only `upload_mark_verified`, `upload_fail` and the
nightly sweep; a person reads their own. `app.upload_settings` holds the switch that makes
Storage refuse a person's direct writes outside a reserved path, and
`app.storage_quota_overrides` a hand-set limit; `app.storage_quota_bytes` and
`app.storage_pool_farm_ids` are the hooks task A3 replaced with the pooled allowance.
`docs/LIMITS.md` explains the flow.

Pooled storage (20261118120000, task A3). One pool per customer: the billing site and every
site billed through it (`app.storage_pool_farm_ids`). `app.storage_allowance` is max(2 GB,
full spaces x 100 MB + equipment spaces x 25 MB) plus 10 GB per paid block, decimal bytes,
now and at the next renewal; `billing_subscriptions.storage_blocks` (and
`pending_storage_blocks`/`_on`) are the paid blocks. `storage_usage_snapshots` is what each
site stored on each South African day (pipeline files, objects with no upload intent, open
reservations; the billing site's row carries the allowance), written by
`cron_storage_measure` and read by the owner; it is the per-period record of storage.
`storage_pool_settings` (owner, audited) holds automatic blocks (off by default, a monthly
ceiling counting held blocks, the accepted terms version) and which warnings were sent.
`storage_charges` (owner reads, audited, never changed except the invoice stamp) is a monthly
block charge or the pro-rata part of an automatic block. `storage_pool_status` (anyone with
access; money for the payer), `storage_set_auto` (owner) and `storage_note_full` (after a
refused upload) are the person-facing functions.

Assistance spending (20261118120200, task A3). `assistance_budgets` (owner reads, audited) is
one monthly rand limit per customer (the billing site) for paid AI, voice and WhatsApp: no row
means no paid assistance (`budget_unset`), zero is a choice, source owner, migrated (existing
customers' limits, `app.assistance_migrate_existing`) or rapid_rise; it also holds the owner's
acceptance of paid WhatsApp (who, when, terms version, the cap then) and the 80%/limit warning
flags. `app.assistance_cap` applies the trial guard; `app.ai_month_spend` and
`app.assistance_member_limit` read across the customer's sites (`app.customer_site_ids`).
`ai_reservations`/`ai_usage` take feature `whatsapp_message` (provider `whatsapp_cloud`,
measured `provider`); `ai_usage` also records `billing_root`, `rate_version`,
`supplier_currency`, `supplier_tax` and `pricing_category`. `whatsapp_usage_holds`
(service only) maps Meta's message id to its hold; `whatsapp_usage_reserve`, `_sent`,
`_release` and `_settle` are the service-role surface. `billing_settings` gained
`whatsapp_billing_starts_on` and `supplier_tax_treatment`.

`assistant_command_jobs` (20261115100000) is one spoken command longer than the instant
hearing: its uploaded recording (an intent of purpose `command_audio` in the service-only
`command-audio` bucket), status, attempts against a limit, a lease so a vanished runner is
taken over, the transcript, and when its temporary audio was removed (at once when
completed or cancelled; after the 72-hour recovery window when failed or unfinished). The
same migration widens `voice_captures` and `ai_interactions` to 16,000-character spoken
requests.

## Bookkeeping of the system itself

`audit_log`, `app.audit_table_rules`, `app.audit_redaction_runs`, `cron_runs` (every
scheduled run, 180 days), `request_claims` (one request, one effect), `app.rate_limit_windows`,
`app.signup_attempt_buckets`, `app.test_email_inboxes`, `app.pay_gate_rules` (the tables a
business that has not paid keeps).

## Adding a table

1. A migration under `supabase/migrations` named by timestamp. Enable and force RLS, write
   the policies with `(select auth.uid())`, grant the least the roles need, and add an
   `app.audit_table_rules` row and the audit trigger when the table holds a business's data.
   A table with `farm_id` also gets the pay gate: `select app.pay_gate_apply('table')` after
   its policies, or an `app.pay_gate_rules` row saying why a stopped business keeps it.
2. A probe in `scripts/apply_pending.mjs` that answers true once the migration is in, so
   production can be brought up to date and checked.
3. A test in `supabase/tests` that proves the isolation, named in `supabase/tests/run.sh`
   (`src/lib/sql-suite.test.ts` fails when a suite is left out).
4. A line in this file under the area it belongs to.

## Keeping it tidy

### B2 private staff conversations (17 November 2026, isolated branch)

`20261117090000_staff_chat.sql` adds `chat_conversations`, `chat_members`,
`chat_messages`, `chat_attachments` and `chat_events`. All have forced RLS and the
existing account pay gate. Authenticated sessions have SELECT only; checked RPCs perform
changes. Active internal membership is required, including an explicit inactive-membership
denial instead of a home-farm fallback. Owners have no implicit access. Support reading
requires an open audited support visit. New/re-added members see publication sequences
after joining. Only the group creator manages membership; direct pairs remain direct.

`chat_events` is the private append-only audit trail for these tables. They deliberately
do not use the farm-wide audit trigger, which would disclose private conversations to
nonmember owners. Events keep actor, action, record and time, with no body or title.

`20261117090100_chat_uploads.sql` extends the existing upload target/commit functions with
`chat_message`, uses the same quota reservation and byte validation, and adds private
`chat-files` Storage policies. `chat_file_readable` applies conversation and message RLS
rules to bytes. Restrictive policies prevent a broader legacy policy from granting chat
access or permitting unreserved direct writes. The business-wide ZIP excludes this private
bucket, while service quota and closure cleanup retain it in their inventory.

Probes are in `apply_pending.mjs`; `staff_chat.sql` is in `run.sh`. Optional local checks
`chat_review_check.mjs storage` and `mutations` exercise the actual migration with a Storage
schema fixture and verify five guards fail when removed. `general_chat` defaults to
unreleased. See `final-dev/REPORT-B2.md` for acceptance blockers and live checks.

`scripts/apply_pending.mjs --dry` says what production is missing. Supabase's advisors
(security and performance) are read after schema changes; what they flag and why it is
left as it is lives in the 11 November entry of `LAUNCH_CHECKLIST.md`. Unused objects are
found by reading every reference in the app, the other functions, policies, views, triggers
and the suites before anything is dropped; the last such pass was 11 November 2026
(20261111160000).

## Manual driving log (B3 R-044 candidate)

Migration 20261117110000_manual_driving_log.sql adds destination, ordered planned_stops,
plan_version and optional start/end kilometres to driving_sessions, and reading, itinerary
and request receipt fields to driving_events. Existing defaults preserve old rows. Existing
tenant policies, pay gates and audit triggers remain; RLS is forced on both tables. There
are no new tables. record_manual_driving_event is authenticated-only, checks
app.require_open_farm before replay, and is covered by the pay_gate_functions.sql definer
audit plus behavioural tests in manual_driving.sql. The old RPC signature is unchanged.
The deployment probe is in scripts/apply_pending.mjs; no live migration was applied.
Deploy the additive migration before the new page, which selects these columns. Rolling
back application code can leave the additive schema and records intact.

## Trips and maps by plan after a downgrade (B3)

Migration 20261119090000_trips_maps_history.sql adds no table. Below Professional, an
update to a saved trip, load, trip income or trip expense is refused (`plan-feature-trips`)
except cancelling a planned trip, finishing a trip already underway (with its deliveries)
and a soft delete; nothing else may change in the same update (`app.only_changed`).
`app.maps_ready` (the `map` flag) and `app.maps_allowed` (Complete and the flag) now hold in
the database: a new or edited `trip_routes` row and a new `asset_positions` row need both
(`plan-feature-maps`, `maps-not-ready`), and a delivery's `pod_lat`/`pod_lng` is kept only
where maps are allowed. Reads are unchanged, so every saved trip, route and position stays
readable on any plan. Suite: `supabase/tests/trips_by_plan.sql`.

## Scheduled work by plan, and the weekly digest once a week (B3)

Migration 20261119100000_scheduled_work_by_plan.sql adds no table. AARTO nomination
reminders go only to a business whose plan includes AARTO and whose `app.farm_billing_gate`
is `ok`. `app.enqueue_weekly_digest` sends one `weekly_digest` per open business per South
African week (`app.sast_week_start`, Monday 00:00 SAST), whichever run gets there first,
under a per-business advisory lock; the nightly route asks Monday to Wednesday so a missed
Monday catches up. Suite: `supabase/tests/scheduled_work_by_plan.sql`.

## Request claims keep a whole answer; swept nightly (B3)

Migration 20261119110000_request_claim_answers.sql lets `request_claims.outcome` hold up to
64 KiB (NOT VALID check, then validated) so an assistant turn or an AI transcription can be
answered again from its claim instead of paid for twice, and adds
`public.cron_sweep_request_claims()` (service role), which the nightly job runs to remove
every claim older than two days. Suite: `supabase/tests/request_claim_answers.sql`.

## A service template once per machine (B3)

Migration 20261119120000_service_template_once.sql adds `service_plan_lines.template_id`
(nullable, existing lines keep null) and the partial unique index
`service_plan_lines_template_once` on (machine, template, task folded) for live lines that
carry a template: two presses of "apply template" cannot double a machine's plan. Lines
added by hand are not constrained. Suite: `supabase/tests/service_template_once.sql`.

## One capture, one record, online or queued (B3)

Migration 20261119130000_offline_capture_once.sql adds
`public.apply_offline_capture_once` (service role; `/api/sync` calls it instead of
`apply_offline_capture`). A queued capture now carries the online attempt's request id; the
function checks that id's `request_claims` row first (the online save landed: answered as a
duplicate; still running: `retry`), claims the id for the capture otherwise, and asks the
plan again for a diesel draw (`plan-feature-fuel`). `claim_request` answers `done` for the
same person's id a queued capture already used. Suite: `supabase/tests/offline_capture_once.sql`.

## The accounting summary summed in the database (B3)

Migration 20261119140000_journal_summary.sql adds `public.farm_journal_totals`,
`farm_journal_accounts`, `partner_journal_totals` and `partner_journal_accounts` (SECURITY
INVOKER over the journal functions, so the journal's own permissions decide). `/accounting`
reads its totals and per-account summary from them instead of every journal line. Suite:
`supabase/tests/journal_summary.sql`. Scenario 18 at the database: `sites_roles_consolidated.sql`.

## Done-For-You agreements and service orders (A4)

Migration 20261120100000_service_orders.sql extends `done_for_you_quotes` (every existing row
is `legacy`, unchanged) with the managed-service terms: scope, work allowance, review schedule,
staff owner (a role), extras, assumptions, supplier mandate (null: the owner approves every
supplier cost), explicit period prices (per full space, minimum spaces, equipment included and
further equipment), the recurring total at the assumed quantities, currency, VAT snapshot, term
and dates, acceptance, landing and end. `public.dfy_offer` / `dfy_accept` / `dfy_cancel` /
`dfy_end` (service role, actor checked inside); `public.cron_apply_service_agreements` (billing
cron, before the invoice run) pins the subscription to a private retired price row at the
renewal on or after the effective date; a trigger on `billing_change_quotes` refuses a plan
change while the term runs. `billing_service_catalogue` gains pricing rules (`per_unit`,
`hourly`, `from`), minimums, the setup work group and supplier readiness (QR kits not ready).
New tables `service_orders` (offered, accepted by the owner, invoiced once through
`billing_raise_service_invoice`) and `service_work_entries` (time by activity and asset: Rapid
Rise only; reviews: the owner too); both forced RLS, audited, pay gate open. Suite:
`supabase/tests/service_orders.sql`.
