-- The activity log must never show a reader more than the source table would (part 1 of 5).
--
-- THE BUG (verified 2026-10-28). `public.app_audit()` (latest body 0510) copied the WHOLE
-- row (`to_jsonb`) into `audit_log` and filed it under the row's `farm_id`. `audit_log` is
-- read through `audit_sel` (20261026100000): Rapid Rise, or any farm in
-- `app.audit_readable_farm_ids()`, which was every owner, manager and mechanic, every
-- operator on a farm that shows costs to operators, and every linked contractor whatever
-- their link allowed. So the log handed out what the tables themselves refuse:
--   * `billing_payment_methods.authorization_code` / `authorization_email` (a reusable
--     Paystack charge credential), withheld from every signed-in role by the column grant;
--   * `support_tickets.evidence`, a billing dossier (owner phone and email, card brand,
--     last4, expiry and bank, invoice and attempt history), readable by Rapid Rise only;
--   * every notification (readable by its addressee only), every billing row (owner only),
--     team memberships and permission grants (owner and manager only), driving sessions,
--     and to a contractor with a narrow link: other contractors' quotes, the farm's costs
--     and budgets, every vehicle, and the team's phone numbers.
--
-- THE FIX, five files, one concern each:
--   20261028090000 (this file)  the rule for every audited table, in a table;
--   20261028091000  app_audit() copies only columns a signed-in reader may select;
--   20261028091500  one door for every row that reaches audit_log: hidden columns are
--                   stripped and a narrower-than-the-log table is filed for Rapid Rise only
--                   (farm_id null, the farm kept in the new about_farm_id);
--   20261028092000  who may read the log: owners, managers and mechanics (whose view of
--                   every 'farm' table below is complete), plus, for vehicle rows only,
--                   anyone who can see that vehicle;
--   20261028092500  existing rows: hidden keys stripped and narrower rows refiled, by a
--                   function that can be run again.
--
-- == The enumeration ========================================================================
-- Every table whose trigger writes audit_log, read from a migrated database (pg_trigger),
-- not from grep: 78 through app_audit() plus 4 with a redacting trigger of their own. For
-- each: who may SELECT the source row (its RLS select policies), which columns the signed-in
-- role may not select at all (column grants), and the rule chosen.
--
-- Reader shorthand: O owner, M manager, Me mechanic, Op operator, C linked contractor,
-- RR Rapid Rise (two-step, not a test account). "Machine rule" = app.row_visible_to_role:
-- O/M/Me see every vehicle, an Op only an assigned one (or every one with the
-- see_all_vehicles grant), a C only with the link's vehicles scope or its own job on it.
-- Soft-deleted rows are hidden by most policies; their history staying in the log is the
-- log's purpose and is not counted as "narrower" here.
--
-- Rule 'farm': filed under the row's farm. After 20261028092000 a farm's log is read by its
-- O, M and Me (and RR); for each 'farm' table every row is visible to all three, which is
-- what makes the filing safe. Rule 'rapid_rise': filed with farm_id null, read by RR only.
--
-- table                       | source row readable by (besides RR)                  | columns withheld from signed-in readers                         | rule
-- ----------------------------+------------------------------------------------------+-----------------------------------------------------------------+-----------
-- asset_aliases               | machine rule                                         | -                                                               | farm
-- attachments                 | farm access; job docs/invoices need cost visibility  | -                                                               | farm
-- bank_lines                  | the contractor's own books                           | - (no farm_id column)                                           | rapid_rise
-- bank_statement_imports      | the contractor's own books                           | - (no farm_id column)                                           | rapid_rise
-- billing_asset_snapshots     | O only (is_farm_billing_admin)                       | -                                                               | rapid_rise
-- billing_invoice_lines       | O only                                               | -                                                               | rapid_rise
-- billing_invoices            | O only                                               | -                                                               | rapid_rise
-- billing_payment_attempts    | O only                                               | -                                                               | rapid_rise
-- billing_payment_methods     | O only, live rows                                    | authorization_code, authorization_email, signature,             | rapid_rise
--                             |                                                      | paystack_customer_code, paystack_customer_id, created_by,       |
--                             |                                                      | deleted_at, deleted_by                                          |
-- billing_payments            | O only                                               | -                                                               | rapid_rise
-- billing_price_versions      | everyone                                             | - (no farm_id column)                                           | rapid_rise
-- billing_promo_codes         | RR only                                              | - (no farm_id column)                                           | rapid_rise
-- billing_settings            | everyone, seller columns only                        | updated_by and the seven ai_* columns (no farm_id column)       | rapid_rise
-- billing_subscriptions       | O only                                               | -                                                               | rapid_rise
-- budgets                     | cost visibility, C costs scope, machine rule         | -                                                               | farm
-- checklist_instance_values   | farm access                                          | -                                                               | farm
-- checklist_instances         | farm access                                          | -                                                               | farm
-- checklist_template_fields   | farm access (global rows: everyone)                  | -                                                               | farm
-- checklist_templates         | farm access (global rows: everyone)                  | -                                                               | farm
-- cost_entries                | cost visibility, C costs scope, machine rule         | -                                                               | farm
-- driver_connections          | the driver, O/M of a driver farm                     | -                                                               | rapid_rise
-- driver_credentials          | the person, O/M                                      | -                                                               | rapid_rise
-- driver_device_links         | the driver, O/M of a driver farm                     | -                                                               | rapid_rise
-- driving_events              | through its session                                  | -                                                               | rapid_rise
-- driving_sessions            | the driver, O/M of a driver farm                     | -                                                               | rapid_rise
-- farms                       | farm access                                          | - (no farm_id column: always filed for RR, as before)           | rapid_rise
-- faults                      | machine rule                                         | -                                                               | farm
-- fines                       | machine rule                                         | -                                                               | farm
-- fuel_deliveries             | farm access, C costs scope                           | price_per_l_cents, doc_url                                      | farm
-- fuel_dips                   | farm access                                          | -                                                               | farm
-- fuel_issues                 | machine rule, C costs scope                          | cost_cents, price_per_l_cents                                   | farm
-- fuel_tanks                  | farm access, C costs scope                           | -                                                               | farm
-- incidents                   | machine rule                                         | -                                                               | farm
-- job_card_lines              | farm access, C costs scope, machine rule             | unit_cost_cents, rate_cents, total_cents                        | farm
-- job_card_service_lines      | farm access                                          | -                                                               | farm
-- job_cards                   | machine rule                                         | parts_total_cents, labour_total_cents, other_total_cents,       | farm
--                             |                                                      | total_cents                                                     |
-- licences                    | machine rule                                         | -                                                               | farm
-- machines                    | machine rule                                         | purchase_price_cents, supplier, the five finance_* columns, the | farm
--                             |                                                      | three depreciation_* columns, useful_life_months,               |
--                             |                                                      | residual_value_cents                                            |
-- meter_readings              | machine rule, C history scope                        | -                                                               | farm
-- meter_replacements          | machine rule                                         | -                                                               | farm
-- notifications               | the addressee only (cost templates: cost visibility) | -                                                               | rapid_rise
-- partner_client_vehicles     | the contractor's own books                           | - (no farm_id column)                                           | rapid_rise
-- partner_clients             | the contractor's own books                           | -                                                               | rapid_rise
-- partner_document_lines      | as its document                                      | -                                                               | rapid_rise
-- partner_documents           | the issuing C; the farm's O/M/Me once not a draft    | -                                                               | rapid_rise
-- partner_expenses            | the contractor's own books                           | - (no farm_id column)                                           | rapid_rise
-- partner_payments            | as its document                                      | -                                                               | rapid_rise
-- partners                    | farm side (never a C); global rows: everyone         | -                                                               | farm
-- parts_catalogue             | farm access (global rows: everyone)                  | typical_cost_cents                                              | farm
-- purchase_order_lines        | the contractor's own books                           | - (no farm_id column)                                           | rapid_rise
-- purchase_orders             | the contractor's own books                           | - (no farm_id column)                                           | rapid_rise
-- push_subscriptions          | the subscriber only (not even RR)                    | -                                                               | rapid_rise
-- recurring_expenses          | the contractor's own books                           | - (no farm_id column)                                           | rapid_rise
-- recurring_invoice_lines     | the contractor's own books                           | - (no farm_id column)                                           | rapid_rise
-- recurring_invoices          | the contractor's own books                           | -                                                               | rapid_rise
-- report_schedules            | O/M                                                  | -                                                               | rapid_rise
-- service_kit_items           | farm access                                          | unit_cost_cents                                                 | farm
-- service_kits                | farm access                                          | -                                                               | farm
-- service_plan_lines          | machine rule, C history scope                        | -                                                               | farm
-- service_templates           | farm access (global rows: everyone)                  | -                                                               | farm
-- stock_items                 | farm side                                            | -                                                               | farm
-- stock_movements             | farm side                                            | unit_cost_cents                                                 | farm
-- suppliers                   | the contractor's own books                           | - (no farm_id column)                                           | rapid_rise
-- support_tickets             | RR only                                              | -                                                               | rapid_rise
-- sync_log                    | the person's own entries, O/M                        | -                                                               | rapid_rise
-- tyre_checks                 | farm access                                          | -                                                               | farm
-- tyre_fitments               | machine rule                                         | -                                                               | farm
-- tyres                       | farm access                                          | -                                                               | farm
-- usage_logs                  | machine rule                                         | -                                                               | farm
-- user_farm_memberships       | the person, O/M                                      | -                                                               | rapid_rise
-- user_permission_grants      | the person, O/M                                      | -                                                               | rapid_rise
-- users                       | the person, their workshop, farm access + C team     | -                                                               | farm
-- warranty_claims             | machine rule                                         | -                                                               | farm
-- watch_items                 | machine rule                                         | -                                                               | farm
-- work_request_events         | farm access, its request's visibility                | -                                                               | farm
-- work_requests               | machine rule; a C only its own                       | quote_amount_cents, invoice_amount_cents, invoice_from_documents | farm
-- workshop_links              | farm access, the workshop                            | -                                                               | farm
-- workshops                   | the workshop, farms linked to it                     | - (no farm_id column)                                           | rapid_rise
-- -- tables with a redacting trigger of their own, filed by the same rule since 20261028091500:
-- ai_interactions             | the person only (prompt and reply already stripped)  | -                                                               | rapid_rise
-- api_tokens                  | O/M (token_hash already stripped)                    | -                                                               | rapid_rise
-- report_schedule_recipients  | O/M (address already stripped)                       | -                                                               | rapid_rise
-- voice_captures              | the person only (transcript already stripped)        | -                                                               | rapid_rise
--
-- Hand-written rows whose entity is not a table (admin_farm_access, data_subject_*,
-- the machines qr_reissue row) keep the farm their writer chose; each names only what its
-- readers may know.
--
-- == Why the rules live in a table =========================================================
-- A new audited table must be decided on, not inherited: a table with no row here is filed
-- for Rapid Rise only (fail closed), and supabase/tests/audit_redaction.sql fails until it
-- has one. Changing a decision later is one UPDATE in a migration, e.g.
--   update app.audit_table_rules set scope = 'farm', reason = '...' where table_name = 'x';
-- Not exposed: schema app is not served by PostgREST and nobody but the definer reads it.

create table if not exists app.audit_table_rules (
  table_name text primary key,
  scope      text not null check (scope in ('farm', 'rapid_rise')),
  reason     text not null check (btrim(reason) <> ''),
  decided_on date not null default current_date
);

comment on table app.audit_table_rules is
  'Where each audited public table files its audit_log rows: farm (under the row''s farm, read '
  'by its owners, managers and mechanics) or rapid_rise (farm_id null, Rapid Rise only). A table '
  'with no row is filed for Rapid Rise (fail closed). See 20261028090000.';

revoke all on table app.audit_table_rules from public, anon, authenticated, service_role;

insert into app.audit_table_rules (table_name, scope, reason) values
  -- Visible to every owner, manager and mechanic of the row's farm.
  ('asset_aliases',             'farm', 'machine rule: every vehicle is visible to O/M/Me'),
  ('attachments',               'farm', 'farm access; cost-bearing kinds need cost visibility, which O/M/Me have'),
  ('budgets',                   'farm', 'cost visibility and machine rule, both held by O/M/Me'),
  ('checklist_instance_values', 'farm', 'farm access'),
  ('checklist_instances',       'farm', 'farm access'),
  ('checklist_template_fields', 'farm', 'farm access; global rows have no farm and go to RR'),
  ('checklist_templates',       'farm', 'farm access; global rows have no farm and go to RR'),
  ('cost_entries',              'farm', 'cost visibility and machine rule, both held by O/M/Me'),
  ('faults',                    'farm', 'machine rule'),
  ('fines',                     'farm', 'machine rule'),
  ('fuel_deliveries',           'farm', 'farm access; price columns withheld by grant and stripped'),
  ('fuel_dips',                 'farm', 'farm access'),
  ('fuel_issues',               'farm', 'machine rule; cost columns withheld by grant and stripped'),
  ('fuel_tanks',                'farm', 'farm access'),
  ('incidents',                 'farm', 'machine rule'),
  ('job_card_lines',            'farm', 'farm access and machine rule; money columns withheld by grant and stripped'),
  ('job_card_service_lines',    'farm', 'farm access'),
  ('job_cards',                 'farm', 'machine rule; totals withheld by grant and stripped'),
  ('licences',                  'farm', 'machine rule'),
  ('machines',                  'farm', 'machine rule; finance columns withheld by grant and stripped; vehicle rows also readable by whoever can see the vehicle (20261028092000)'),
  ('meter_readings',            'farm', 'machine rule'),
  ('meter_replacements',        'farm', 'machine rule'),
  ('partners',                  'farm', 'farm side; global rows have no farm and go to RR'),
  ('parts_catalogue',           'farm', 'farm access; typical cost withheld by grant and stripped'),
  ('service_kit_items',         'farm', 'farm access; unit cost withheld by grant and stripped'),
  ('service_kits',              'farm', 'farm access'),
  ('service_plan_lines',        'farm', 'machine rule'),
  ('service_templates',         'farm', 'farm access; global rows have no farm and go to RR'),
  ('stock_items',               'farm', 'farm side'),
  ('stock_movements',           'farm', 'farm side; unit cost withheld by grant and stripped'),
  ('tyre_checks',               'farm', 'farm access'),
  ('tyre_fitments',             'farm', 'machine rule'),
  ('tyres',                     'farm', 'farm access'),
  ('usage_logs',                'farm', 'machine rule'),
  ('users',                     'farm', 'farm access; contractor staff have no farm and go to RR'),
  ('warranty_claims',           'farm', 'machine rule'),
  ('watch_items',               'farm', 'machine rule'),
  ('work_request_events',       'farm', 'farm access and request visibility'),
  ('work_requests',             'farm', 'machine rule; amounts withheld by grant and stripped'),
  ('workshop_links',            'farm', 'farm access'),
  -- Narrower than a farm's log: Rapid Rise only.
  ('billing_asset_snapshots',   'rapid_rise', 'billing: the owner only'),
  ('billing_invoice_lines',     'rapid_rise', 'billing: the owner only'),
  ('billing_invoices',          'rapid_rise', 'billing: the owner only'),
  ('billing_payment_attempts',  'rapid_rise', 'billing: the owner only'),
  ('billing_payment_methods',   'rapid_rise', 'billing: the owner only; the charge credential is withheld from everyone'),
  ('billing_payments',          'rapid_rise', 'billing: the owner only'),
  ('billing_subscriptions',     'rapid_rise', 'billing: the owner only'),
  ('support_tickets',           'rapid_rise', 'Rapid Rise only: disputes carry a billing dossier'),
  ('notifications',             'rapid_rise', 'the addressee only'),
  ('push_subscriptions',        'rapid_rise', 'the subscriber only'),
  ('report_schedules',          'rapid_rise', 'owners and managers only'),
  ('report_schedule_recipients','rapid_rise', 'owners and managers only (own trigger strips the address)'),
  ('api_tokens',                'rapid_rise', 'owners and managers only (own trigger strips the hash)'),
  ('user_farm_memberships',     'rapid_rise', 'the person, owners and managers only'),
  ('user_permission_grants',    'rapid_rise', 'the person, owners and managers only'),
  ('sync_log',                  'rapid_rise', 'the person''s own entries, owners and managers only'),
  ('driver_connections',        'rapid_rise', 'the driver, owners and managers only'),
  ('driver_device_links',       'rapid_rise', 'the driver, owners and managers only'),
  ('driving_sessions',          'rapid_rise', 'the driver, owners and managers only'),
  ('driving_events',            'rapid_rise', 'as its driving session'),
  ('driver_credentials',        'rapid_rise', 'the person, owners and managers only'),
  ('partner_documents',         'rapid_rise', 'the issuing contractor; drafts are private to it (0383)'),
  ('partner_document_lines',    'rapid_rise', 'as its partner document'),
  ('partner_payments',          'rapid_rise', 'as its partner document'),
  ('partner_clients',           'rapid_rise', 'the contractor''s own books'),
  ('recurring_invoices',        'rapid_rise', 'the contractor''s own books'),
  ('voice_captures',            'rapid_rise', 'the person only (own trigger strips the transcript)'),
  ('ai_interactions',           'rapid_rise', 'the person only (own trigger strips prompt and reply)'),
  -- No farm_id column: these were always filed with farm_id null; the rule says so out loud.
  ('bank_lines',                'rapid_rise', 'no farm_id column: the contractor''s own books'),
  ('bank_statement_imports',    'rapid_rise', 'no farm_id column: the contractor''s own books'),
  ('billing_price_versions',    'rapid_rise', 'no farm_id column'),
  ('billing_promo_codes',       'rapid_rise', 'no farm_id column: Rapid Rise only'),
  ('billing_settings',          'rapid_rise', 'no farm_id column; AI margin columns withheld by grant'),
  ('farms',                     'rapid_rise', 'no farm_id column: always filed for Rapid Rise; about_farm_id is the farm'),
  ('partner_client_vehicles',   'rapid_rise', 'no farm_id column: the contractor''s own books'),
  ('partner_expenses',          'rapid_rise', 'no farm_id column: the contractor''s own books'),
  ('purchase_order_lines',      'rapid_rise', 'no farm_id column: the contractor''s own books'),
  ('purchase_orders',           'rapid_rise', 'no farm_id column: the contractor''s own books'),
  ('recurring_expenses',        'rapid_rise', 'no farm_id column: the contractor''s own books'),
  ('recurring_invoice_lines',   'rapid_rise', 'no farm_id column: the contractor''s own books'),
  ('suppliers',                 'rapid_rise', 'no farm_id column: the contractor''s own books'),
  ('workshops',                 'rapid_rise', 'no farm_id column')
on conflict (table_name) do nothing;
