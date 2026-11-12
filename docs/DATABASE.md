# The database, by area

A map of the Supabase Postgres schema as it stands on 11 November 2026: 137 tables and 8
views in `public`, 8 tables in `app`, about 600 functions, and the rules every table follows. Table names
are grouped by the part of the product they serve; the migration that created each one is
the authority on its columns (`supabase/migrations`, applied in filename order).

## The rules every table follows

- **Row-level security on everything, forced.** 141 tables have RLS and 115 force it, so even
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
- **Policies call `auth.uid()` once per query**, as `(select auth.uid())`, since
  20261111150000. Write new policies the same way.
- **RPCs that run as their owner check the caller themselves.** A `security definer`
  function reachable from a browser must verify membership, role and the account's state
  before it reads or writes; its tests in `supabase/tests` prove a member of one business
  cannot reach another's rows through it.
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

`machines` (every vehicle or machine; `meter_type` hours or km), `meter_readings`,
`meter_replacements`, `attachments` (photos and files), `asset_aliases` (the names people
say), `asset_contracts` (leases, rentals, service contracts), `asset_positions` (where a
vehicle was, kept 180 days), `licences`, `driver_credentials`, `tyres`, `tyre_fitments`,
`tyre_checks`, `watch_items`, `cost_entries` (every cost against a machine), `budgets`,
`billing_asset_snapshots` (what was billed for, per period).

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
`docs/BILLING.md`.

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

## Bookkeeping of the system itself

`audit_log`, `app.audit_table_rules`, `app.audit_redaction_runs`, `cron_runs` (every
scheduled run, 180 days), `request_claims` (one request, one effect), `app.rate_limit_windows`,
`app.signup_attempt_buckets`, `app.test_email_inboxes`.

## Adding a table

1. A migration under `supabase/migrations` named by timestamp. Enable and force RLS, write
   the policies with `(select auth.uid())`, grant the least the roles need, and add an
   `app.audit_table_rules` row and the audit trigger when the table holds a business's data.
2. A probe in `scripts/apply_pending.mjs` that answers true once the migration is in, so
   production can be brought up to date and checked.
3. A test in `supabase/tests` that proves the isolation, named in `supabase/tests/run.sh`
   (`src/lib/sql-suite.test.ts` fails when a suite is left out).
4. A line in this file under the area it belongs to.

## Keeping it tidy

`scripts/apply_pending.mjs --dry` says what production is missing. Supabase's advisors
(security and performance) are read after schema changes; what they flag and why it is
left as it is lives in the 11 November entry of `LAUNCH_CHECKLIST.md`. Unused objects are
found by reading every reference in the app, the other functions, policies, views, triggers
and the suites before anything is dropped; the last such pass was 11 November 2026
(20261111160000).
