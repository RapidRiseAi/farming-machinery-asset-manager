-- rls_isolation.sql — the tenancy/RLS correctness gate (Scope ground rule #3).
--
-- Proves, for EVERY table, that:
--   * Farm A users see only Farm A rows; Farm B users see only Farm B rows.
--   * A workshop linked to Farm A sees Farm A rows only — never Farm B.
--   * Revoking a workshop link immediately removes access.
--   * RR admin sees across all tenants.
--   * The anon role sees nothing and cannot write.
--   * Cross-tenant writes are rejected.
--   * Structural rules hold: job-card totals compute; locked job cards can't be edited.
--
-- Run via supabase/tests/run.sh (psql with ON_ERROR_STOP=1). Any failed assertion
-- raises and aborts with a non-zero exit code.

\set ON_ERROR_STOP on
\timing off
set client_min_messages to warning;

-- ─────────────────────────────────────────────────────────────────
-- Assertion helpers. SECURITY INVOKER (default) so RLS is evaluated
-- against the current role.
-- ─────────────────────────────────────────────────────────────────
create or replace function _t_assert(tbl text, expected bigint, who text)
returns void language plpgsql as $$
declare c bigint;
begin
  execute format('select count(*) from public.%I', tbl) into c;
  if c is distinct from expected then
    raise exception 'ISOLATION FAIL [%]: table % visible=% expected=%', who, tbl, c, expected;
  end if;
end $$;
grant execute on function _t_assert(text, bigint, text) to public;

create or replace function _t_login(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false);
$$;
grant execute on function _t_login(uuid) to public;

-- ─────────────────────────────────────────────────────────────────
-- Seed (as superuser — RLS bypassed)
-- ─────────────────────────────────────────────────────────────────
insert into farms (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Farm A'),
  ('22222222-2222-2222-2222-222222222222', 'Farm B');

insert into workshops (id, name) values
  ('33333333-3333-3333-3333-333333333333', 'Workshop W');

insert into workshop_links (workshop_id, farm_id, status) values
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'active');

insert into auth.users (id, email) values
  ('a1111111-1111-1111-1111-111111111111', 'ownerA@test'),
  ('b2222222-2222-2222-2222-222222222222', 'ownerB@test'),
  ('c3333333-3333-3333-3333-333333333333', 'workshopW@test'),
  ('d4444444-4444-4444-4444-444444444444', 'admin@test');

insert into users (id, farm_id, workshop_id, role, name) values
  ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', null, 'owner',    'Owner A'),
  ('b2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', null, 'owner',    'Owner B'),
  ('c3333333-3333-3333-3333-333333333333', null, '33333333-3333-3333-3333-333333333333', 'workshop', 'Workshop W Staff'),
  ('d4444444-4444-4444-4444-444444444444', null, null, 'rr_admin', 'RR Admin');

insert into machines (id, farm_id, name, type) values
  ('aa111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Machine A1', 'tractor'),
  ('bb222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Machine B1', 'tractor');

insert into meter_readings (farm_id, machine_id, reading, source, by_user) values
  ('11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 100, 'manual', 'a1111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 200, 'manual', 'b2222222-2222-2222-2222-222222222222');

insert into service_plan_lines (farm_id, machine_id, task, interval_hours) values
  ('11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 'Engine oil', 250),
  ('22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 'Engine oil', 250);

-- two per-farm templates + one shared GLOBAL template (farm_id null)
insert into service_templates (farm_id, machine_type, name) values
  ('11111111-1111-1111-1111-111111111111', 'tractor', 'Farm A tractor plan'),
  ('22222222-2222-2222-2222-222222222222', 'tractor', 'Farm B tractor plan'),
  (null, 'tractor', 'GLOBAL tractor plan');

insert into faults (id, farm_id, machine_id, description, urgency, status) values
  ('a5111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 'A leak', 'limping', 'open'),
  ('b5222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 'B leak', 'limping', 'open');

insert into job_cards (id, farm_id, machine_id, type, status) values
  ('ac111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 'repair', 'open'),
  ('bc222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 'repair', 'open');

insert into job_card_lines (farm_id, job_card_id, kind, description, qty, unit_cost_cents) values
  ('11111111-1111-1111-1111-111111111111', 'ac111111-1111-1111-1111-111111111111', 'part', 'Oil filter', 1, 15000),
  ('22222222-2222-2222-2222-222222222222', 'bc222222-2222-2222-2222-222222222222', 'part', 'Oil filter', 1, 15000);

insert into job_card_service_lines (job_card_id, service_plan_line_id, farm_id)
select 'ac111111-1111-1111-1111-111111111111', id, '11111111-1111-1111-1111-111111111111'
  from service_plan_lines where machine_id = 'aa111111-1111-1111-1111-111111111111' limit 1;
insert into job_card_service_lines (job_card_id, service_plan_line_id, farm_id)
select 'bc222222-2222-2222-2222-222222222222', id, '22222222-2222-2222-2222-222222222222'
  from service_plan_lines where machine_id = 'bb222222-2222-2222-2222-222222222222' limit 1;

insert into watch_items (farm_id, machine_id, text) values
  ('11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 'Front tyres 50%'),
  ('22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 'Front tyres 50%');

insert into attachments (farm_id, parent_type, parent_id, kind, url) values
  ('11111111-1111-1111-1111-111111111111', 'machine', 'aa111111-1111-1111-1111-111111111111', 'photo', 'http://x/a'),
  ('22222222-2222-2222-2222-222222222222', 'machine', 'bb222222-2222-2222-2222-222222222222', 'photo', 'http://x/b');

-- notifications are produced by the fault-reported trigger (0203): one per farm,
-- to that farm's owner. (No explicit seed needed — the faults above generate them.)

insert into fuel_tanks (id, farm_id, name) values
  ('af111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Tank A'),
  ('bf222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Tank B');

insert into fuel_deliveries (farm_id, tank_id, litres) values
  ('11111111-1111-1111-1111-111111111111', 'af111111-1111-1111-1111-111111111111', 1000),
  ('22222222-2222-2222-2222-222222222222', 'bf222222-2222-2222-2222-222222222222', 1000);

insert into fuel_issues (farm_id, tank_id, machine_id, litres) values
  ('11111111-1111-1111-1111-111111111111', 'af111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 50),
  ('22222222-2222-2222-2222-222222222222', 'bf222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 50);

-- usage_logs (0233): one driver-usage record per farm (AARTO driver-usage log).
insert into usage_logs (farm_id, machine_id, driver_user_id, occurred_on, meter_reading, source) values
  ('11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', current_date, 100, 'app'),
  ('22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', current_date, 200, 'app');

-- One synced mutation per farm (written by the /api/sync service-role route in prod;
-- seeded here as superuser) so the isolation assertions cover sync_log too.
insert into sync_log (farm_id, client_id, mutation, scope, status, client_ts, entity) values
  ('11111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', 'log_reading', 'app', 'applied', now(), 'meter_readings'),
  ('22222222-2222-2222-2222-222222222222', 'c2222222-2222-2222-2222-222222222222', 'log_reading', 'app', 'applied', now(), 'meter_readings');

-- ─────────────────────────────────────────────────────────────────
-- Structural: job-card totals computed by trigger (1 × 15000c = 15000c)
-- ─────────────────────────────────────────────────────────────────
do $$ declare v bigint; begin
  select total_cents into v from job_cards where id = 'ac111111-1111-1111-1111-111111111111';
  if v is distinct from 15000 then raise exception 'TOTALS FAIL: expected 15000 got %', v; end if;
end $$;

-- ═════════════════════════════════════════════════════════════════
-- Persona: OWNER A → only Farm A
-- ═════════════════════════════════════════════════════════════════
set role authenticated;
do $$ begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  perform _t_assert('farms',              1, 'ownerA');
  perform _t_assert('machines',           1, 'ownerA');
  perform _t_assert('meter_readings',     1, 'ownerA');
  perform _t_assert('service_plan_lines', 1, 'ownerA');
  perform _t_assert('service_templates',  2, 'ownerA');  -- Farm A + GLOBAL
  perform _t_assert('faults',             1, 'ownerA');
  perform _t_assert('job_cards',          1, 'ownerA');
  perform _t_assert('job_card_lines',     1, 'ownerA');
  perform _t_assert('job_card_service_lines', 1, 'ownerA');
  perform _t_assert('watch_items',        1, 'ownerA');
  perform _t_assert('attachments',        1, 'ownerA');
  perform _t_assert('notifications',      1, 'ownerA');
  perform _t_assert('fuel_tanks',         1, 'ownerA');
  perform _t_assert('fuel_deliveries',    1, 'ownerA');
  perform _t_assert('fuel_issues',        1, 'ownerA');
  perform _t_assert('users',              1, 'ownerA');  -- self only
  perform _t_assert('workshops',          1, 'ownerA');  -- W linked to Farm A
  perform _t_assert('workshop_links',     1, 'ownerA');
  perform _t_assert('sync_log',           1, 'ownerA');
  perform _t_assert('usage_logs',         1, 'ownerA');
end $$;
-- audit isolation: no Farm B audit rows; some Farm A audit rows
do $$ declare c int; begin
  execute $q$ select count(*) from audit_log where farm_id = '22222222-2222-2222-2222-222222222222' $q$ into c;
  if c <> 0 then raise exception 'ISOLATION FAIL [ownerA]: sees % Farm B audit rows', c; end if;
  execute $q$ select count(*) from audit_log where farm_id = '11111111-1111-1111-1111-111111111111' $q$ into c;
  if c = 0 then raise exception 'AUDIT FAIL [ownerA]: sees no Farm A audit rows'; end if;
end $$;
reset role;

-- ═════════════════════════════════════════════════════════════════
-- Persona: OWNER B → only Farm B; NEVER the workshop linked to A
-- ═════════════════════════════════════════════════════════════════
set role authenticated;
do $$ begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');
  perform _t_assert('farms',              1, 'ownerB');
  perform _t_assert('machines',           1, 'ownerB');
  perform _t_assert('meter_readings',     1, 'ownerB');
  perform _t_assert('service_plan_lines', 1, 'ownerB');
  perform _t_assert('service_templates',  2, 'ownerB');  -- Farm B + GLOBAL
  perform _t_assert('faults',             1, 'ownerB');
  perform _t_assert('job_cards',          1, 'ownerB');
  perform _t_assert('job_card_lines',     1, 'ownerB');
  perform _t_assert('job_card_service_lines', 1, 'ownerB');
  perform _t_assert('watch_items',        1, 'ownerB');
  perform _t_assert('attachments',        1, 'ownerB');
  perform _t_assert('notifications',      1, 'ownerB');
  perform _t_assert('fuel_tanks',         1, 'ownerB');
  perform _t_assert('fuel_deliveries',    1, 'ownerB');
  perform _t_assert('fuel_issues',        1, 'ownerB');
  perform _t_assert('users',              1, 'ownerB');
  perform _t_assert('workshops',          0, 'ownerB');  -- W not linked to Farm B
  perform _t_assert('workshop_links',     0, 'ownerB');
  perform _t_assert('sync_log',           1, 'ownerB');
  perform _t_assert('usage_logs',         1, 'ownerB');
end $$;
reset role;

-- ═════════════════════════════════════════════════════════════════
-- Persona: WORKSHOP W → only its linked farm (A), never Farm B
-- ═════════════════════════════════════════════════════════════════
set role authenticated;
do $$ begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');
  perform _t_assert('farms',              1, 'workshopW');  -- Farm A only
  perform _t_assert('machines',           1, 'workshopW');
  perform _t_assert('meter_readings',     1, 'workshopW');
  perform _t_assert('service_plan_lines', 1, 'workshopW');
  perform _t_assert('service_templates',  2, 'workshopW');  -- Farm A + GLOBAL
  perform _t_assert('faults',             1, 'workshopW');
  perform _t_assert('job_cards',          1, 'workshopW');
  perform _t_assert('job_card_lines',     1, 'workshopW');
  perform _t_assert('job_card_service_lines', 1, 'workshopW');
  perform _t_assert('watch_items',        1, 'workshopW');
  perform _t_assert('attachments',        1, 'workshopW');
  perform _t_assert('notifications',      1, 'workshopW');
  perform _t_assert('fuel_tanks',         1, 'workshopW');
  perform _t_assert('fuel_deliveries',    1, 'workshopW');
  perform _t_assert('fuel_issues',        1, 'workshopW');
  perform _t_assert('users',              2, 'workshopW');  -- self + Owner A (linked farm)
  perform _t_assert('workshops',          1, 'workshopW');  -- self
  perform _t_assert('workshop_links',     1, 'workshopW');
  perform _t_assert('sync_log',           1, 'workshopW');  -- Farm A only
  perform _t_assert('usage_logs',         1, 'workshopW');
end $$;
reset role;

-- ═════════════════════════════════════════════════════════════════
-- Persona: RR ADMIN → everything across tenants
-- ═════════════════════════════════════════════════════════════════
set role authenticated;
do $$ begin
  perform _t_login('d4444444-4444-4444-4444-444444444444');
  perform _t_assert('farms',              2, 'rrAdmin');
  perform _t_assert('machines',           2, 'rrAdmin');
  perform _t_assert('meter_readings',     2, 'rrAdmin');
  perform _t_assert('service_plan_lines', 2, 'rrAdmin');
  perform _t_assert('service_templates',  3, 'rrAdmin');  -- A + B + GLOBAL
  perform _t_assert('faults',             2, 'rrAdmin');
  perform _t_assert('job_cards',          2, 'rrAdmin');
  perform _t_assert('job_card_lines',     2, 'rrAdmin');
  perform _t_assert('job_card_service_lines', 2, 'rrAdmin');
  perform _t_assert('watch_items',        2, 'rrAdmin');
  perform _t_assert('attachments',        2, 'rrAdmin');
  perform _t_assert('notifications',      2, 'rrAdmin');
  perform _t_assert('fuel_tanks',         2, 'rrAdmin');
  perform _t_assert('fuel_deliveries',    2, 'rrAdmin');
  perform _t_assert('fuel_issues',        2, 'rrAdmin');
  perform _t_assert('users',              4, 'rrAdmin');
  perform _t_assert('workshops',          1, 'rrAdmin');
  perform _t_assert('workshop_links',     1, 'rrAdmin');
  perform _t_assert('sync_log',           2, 'rrAdmin');
  perform _t_assert('usage_logs',         2, 'rrAdmin');
end $$;
reset role;

-- ═════════════════════════════════════════════════════════════════
-- Persona: ANON → sees NOTHING and cannot write
-- ═════════════════════════════════════════════════════════════════
set role anon;
do $$
declare t text; c bigint;
begin
  perform set_config('request.jwt.claims', '', false);
  foreach t in array array[
    'farms','workshops','users','workshop_links','machines','meter_readings',
    'service_templates','service_plan_lines','faults','job_cards','job_card_lines',
    'watch_items','attachments','notifications','fuel_tanks','fuel_deliveries',
    'fuel_issues','job_card_service_lines','cost_entries','usage_logs','audit_log','sync_log'
  ] loop
    begin
      execute format('select count(*) from public.%I', t) into c;
    exception when insufficient_privilege then c := 0;
    end;
    if c <> 0 then raise exception 'ISOLATION FAIL [anon]: sees % rows in %', c, t; end if;
  end loop;
  -- anon cannot insert a fault (public QR flow must use service_role, not anon)
  begin
    execute $i$ insert into faults(farm_id, machine_id, description)
                values ('11111111-1111-1111-1111-111111111111','aa111111-1111-1111-1111-111111111111','hack') $i$;
    raise exception 'ISOLATION FAIL [anon]: was able to insert a fault';
  exception
    when insufficient_privilege then null;   -- expected
    when others then
      if sqlstate = 'P0001' then raise; end if;  -- re-raise our own failure
  end;
end $$;
reset role;

-- ═════════════════════════════════════════════════════════════════
-- Cross-tenant WRITE denial: Owner A cannot insert into Farm B
-- ═════════════════════════════════════════════════════════════════
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  begin
    insert into machines(farm_id, name, type)
      values ('22222222-2222-2222-2222-222222222222', 'hack', 'tractor');
  exception when others then ok := true; end;
  if not ok then raise exception 'ISOLATION FAIL [ownerA]: inserted a machine into Farm B'; end if;
end $$;
reset role;

-- ═════════════════════════════════════════════════════════════════
-- Structural: job-card lock — approving locks the card; edits then fail
-- ═════════════════════════════════════════════════════════════════
update job_cards
  set status = 'approved', approved_by = 'a1111111-1111-1111-1111-111111111111',
      approved_at = now(), locked = true
  where id = 'ac111111-1111-1111-1111-111111111111';           -- OLD.locked = false → allowed
do $$ declare ok boolean := false; begin
  begin
    update job_cards set diagnosis = 'tamper' where id = 'ac111111-1111-1111-1111-111111111111';
  exception when others then ok := true; end;
  if not ok then raise exception 'LOCK FAIL: a locked job card was modified'; end if;
  ok := false;
  begin
    insert into job_card_lines(farm_id, job_card_id, kind, description, qty, unit_cost_cents)
      values ('11111111-1111-1111-1111-111111111111','ac111111-1111-1111-1111-111111111111','part','x',1,1);
  exception when others then ok := true; end;
  if not ok then raise exception 'LOCK FAIL: a line was added to a locked job card'; end if;
end $$;

-- ═════════════════════════════════════════════════════════════════
-- Dynamic scoping: revoking the workshop link removes access
-- ═════════════════════════════════════════════════════════════════
update workshop_links set status = 'revoked'
  where workshop_id = '33333333-3333-3333-3333-333333333333'
    and farm_id = '11111111-1111-1111-1111-111111111111';
set role authenticated;
do $$ begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');
  perform _t_assert('machines', 0, 'workshopW-after-revoke');   -- no longer linked
  perform _t_assert('farms',    0, 'workshopW-after-revoke');
end $$;
reset role;
update workshop_links set status = 'active'
  where workshop_id = '33333333-3333-3333-3333-333333333333'
    and farm_id = '11111111-1111-1111-1111-111111111111';

select 'ALL RLS ISOLATION TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- ═══ 0205: SERVICE-DUE NOTIFICATION ENGINE (appended section) ═════
-- Proves: (a) authenticated CANNOT execute the new app.* / public.cron_* functions;
-- (b) the enqueue engine (run as service_role) notifies only the right farm's
-- owner/manager; (c) retired/sold machines never enqueue; (d) dedupe + weekly
-- overdue escalation + return-to-ok reset behave; (e) stale-meter + weekly-digest
-- enqueues are farm-scoped; (f) quiet-hours delivery gate; (g) notifications stay
-- farm-isolated with the new columns. Nothing above this line is modified.
-- ═════════════════════════════════════════════════════════════════

-- Small helper: count (non-deleted) notifications for a farm+template (as superuser).
create or replace function _t_notif(p_farm uuid, p_template text) returns bigint
language sql as $$
  select count(*) from public.notifications
  where farm_id = p_farm and template = p_template and deleted_at is null;
$$;
grant execute on function _t_notif(uuid, text) to public;

-- ── Fixtures ──────────────────────────────────────────────────────
-- Manager A so Farm A notifications target owner+manager (2 rows/event).
insert into auth.users (id, email) values
  ('a1111111-1111-1111-1111-1111111111aa', 'managerA@test');
insert into users (id, farm_id, workshop_id, role, name) values
  ('a1111111-1111-1111-1111-1111111111aa', '11111111-1111-1111-1111-111111111111', null, 'manager', 'Manager A');

-- A RETIRED Farm A machine with an overdue line — must never enqueue.
insert into machines (id, farm_id, name, type, status) values
  ('aa999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111', 'Retired A', 'tractor', 'retired');
insert into service_plan_lines (id, farm_id, machine_id, task, interval_hours, status) values
  ('a9111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   'aa999999-9999-9999-9999-999999999999', 'Old oil', 250, 'overdue');

-- Drive the two seeded lines into notifiable states.
update service_plan_lines set status = 'overdue'
  where machine_id = 'aa111111-1111-1111-1111-111111111111';   -- Farm A
update service_plan_lines set status = 'due_soon'
  where machine_id = 'bb222222-2222-2222-2222-222222222222';   -- Farm B

-- ── (a) authenticated CANNOT execute the new functions ────────────
set role authenticated;
do $$
declare
  calls text[] := array[
    'select app.enqueue_service_notifications()',
    'select app.enqueue_stale_meter_nudges()',
    'select app.enqueue_weekly_digest()',
    'select app.notify_farm(''11111111-1111-1111-1111-111111111111''::uuid, ''x'', ''{}''::jsonb, null::timestamptz)',
    'select app.quiet_deliver_after(''{}''::jsonb)',
    'select public.cron_recalc_all_due()',
    'select public.cron_enqueue_service_notifications()',
    'select public.cron_enqueue_stale_meter_nudges()',
    'select public.cron_enqueue_weekly_digest()'
  ];
  c text;
begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  foreach c in array calls loop
    begin
      execute c;
      raise exception 'PRIV FAIL: authenticated executed % without a privilege error', c;
    exception
      when insufficient_privilege then null;                 -- expected
      when others then
        if sqlstate = 'P0001' then raise; end if;            -- our own PRIV FAIL bubbles up
        raise exception 'PRIV FAIL: % blocked by unexpected error (sqlstate %)', c, sqlstate;
    end;
  end loop;
end $$;
reset role;

-- ── (b) enqueue notifies only the right farm's owner/manager ──────
set role service_role;
do $$ begin perform app.enqueue_service_notifications(); end $$;
reset role;

do $$
declare fa uuid := '11111111-1111-1111-1111-111111111111';
        fb uuid := '22222222-2222-2222-2222-222222222222'; v bigint;
begin
  -- Farm A overdue → owner + manager = 2 rows; Farm B due_soon → owner only = 1 row.
  if _t_notif(fa,'service_overdue')  <> 2 then raise exception 'ENQUEUE FAIL: Farm A service_overdue = %', _t_notif(fa,'service_overdue'); end if;
  if _t_notif(fb,'service_due_soon') <> 1 then raise exception 'ENQUEUE FAIL: Farm B service_due_soon = %', _t_notif(fb,'service_due_soon'); end if;
  -- Farm B must not receive Farm A's overdue notice, and vice-versa.
  if _t_notif(fb,'service_overdue')  <> 0 then raise exception 'ENQUEUE FAIL: Farm B leaked service_overdue'; end if;
  if _t_notif(fa,'service_due_soon') <> 0 then raise exception 'ENQUEUE FAIL: Farm A leaked service_due_soon'; end if;

  -- (c) the retired machine's line was skipped — dedupe marker untouched (null).
  select notified_status::text into v from service_plan_lines where id = 'a9111111-1111-1111-1111-111111111111';
  if v is not null then raise exception 'RETIRED FAIL: retired-machine line got notified_status = %', v; end if;

  -- dedupe markers recorded on the real lines.
  perform 1 from service_plan_lines
    where machine_id = 'aa111111-1111-1111-1111-111111111111'
      and notified_status = 'overdue' and last_notified_at is not null;
  if not found then raise exception 'DEDUPE FAIL: Farm A line not marked notified'; end if;
end $$;

-- ── (d) dedupe: a second run enqueues nothing new ─────────────────
set role service_role;
do $$ begin perform app.enqueue_service_notifications(); end $$;
reset role;
do $$ begin
  if _t_notif('11111111-1111-1111-1111-111111111111','service_overdue')  <> 2
     then raise exception 'DEDUPE FAIL: Farm A service_overdue changed on re-run'; end if;
  if _t_notif('22222222-2222-2222-2222-222222222222','service_due_soon') <> 1
     then raise exception 'DEDUPE FAIL: Farm B service_due_soon changed on re-run'; end if;
end $$;

-- ── (d) weekly overdue escalation: age the marker > 7 days, re-run ─
update service_plan_lines set last_notified_at = now() - interval '8 days'
  where machine_id = 'aa111111-1111-1111-1111-111111111111';
set role service_role;
do $$ begin perform app.enqueue_service_notifications(); end $$;
reset role;
do $$ begin
  if _t_notif('11111111-1111-1111-1111-111111111111','service_overdue') <> 4
     then raise exception 'ESCALATION FAIL: Farm A service_overdue = % (expected 4)',
       _t_notif('11111111-1111-1111-1111-111111111111','service_overdue'); end if;
end $$;

-- ── (d) return-to-ok resets the marker silently (no new message) ──
update service_plan_lines set status = 'ok'
  where machine_id = 'aa111111-1111-1111-1111-111111111111';
set role service_role;
do $$ begin perform app.enqueue_service_notifications(); end $$;
reset role;
do $$ declare v text; begin
  if _t_notif('11111111-1111-1111-1111-111111111111','service_overdue') <> 4
     then raise exception 'RESET FAIL: return-to-ok produced a new message'; end if;
  select notified_status::text into v from service_plan_lines
    where machine_id = 'aa111111-1111-1111-1111-111111111111';
  if v <> 'ok' then raise exception 'RESET FAIL: notified_status = % (expected ok)', v; end if;
end $$;

-- ── (e) stale-meter nudge: farm-scoped, deduped weekly ────────────
update machines set current_reading_date = current_date - 60
  where id = 'aa111111-1111-1111-1111-111111111111';           -- Farm A machine now stale
set role service_role;
do $$ begin perform app.enqueue_stale_meter_nudges(); end $$;
reset role;
do $$ begin
  if _t_notif('11111111-1111-1111-1111-111111111111','stale_meter') <> 2
     then raise exception 'STALE FAIL: Farm A stale_meter = % (expected 2)',
       _t_notif('11111111-1111-1111-1111-111111111111','stale_meter'); end if;
  if _t_notif('22222222-2222-2222-2222-222222222222','stale_meter') <> 0
     then raise exception 'STALE FAIL: Farm B got an un-warranted stale nudge'; end if;
end $$;
-- weekly dedupe: a second run within 7 days adds nothing.
set role service_role;
do $$ begin perform app.enqueue_stale_meter_nudges(); end $$;
reset role;
do $$ begin
  if _t_notif('11111111-1111-1111-1111-111111111111','stale_meter') <> 2
     then raise exception 'STALE DEDUPE FAIL: Farm A stale_meter changed on re-run'; end if;
end $$;

-- ── (e) weekly digest: one per active farm's owner/manager ────────
set role service_role;
do $$ begin perform app.enqueue_weekly_digest(); end $$;
reset role;
do $$ declare p jsonb; begin
  if _t_notif('11111111-1111-1111-1111-111111111111','weekly_digest') <> 2
     then raise exception 'DIGEST FAIL: Farm A weekly_digest = % (expected 2)',
       _t_notif('11111111-1111-1111-1111-111111111111','weekly_digest'); end if;
  if _t_notif('22222222-2222-2222-2222-222222222222','weekly_digest') <> 1
     then raise exception 'DIGEST FAIL: Farm B weekly_digest = % (expected 1)',
       _t_notif('22222222-2222-2222-2222-222222222222','weekly_digest'); end if;
  -- payload carries the count keys the UI reads.
  select payload into p from notifications
    where farm_id = '11111111-1111-1111-1111-111111111111' and template = 'weekly_digest' limit 1;
  if not (p ? 'overdue_count' and p ? 'due_soon_count' and p ? 'open_faults_count' and p ? 'in_workshop_count')
     then raise exception 'DIGEST FAIL: payload missing count keys: %', p; end if;
end $$;

-- ── (f) quiet-hours delivery gate ─────────────────────────────────
do $$
declare
  h int := extract(hour from (now() at time zone 'Africa/Johannesburg'))::int;
  wnd jsonb := jsonb_build_object('quiet_hours_start', h, 'quiet_hours_end', (h + 2) % 24);
  after timestamptz;
begin
  -- disabled window (start == end) → deliver immediately (null).
  if app.quiet_deliver_after('{"quiet_hours_start":0,"quiet_hours_end":0}'::jsonb) is not null
     then raise exception 'QUIET FAIL: disabled window did not return null'; end if;
  -- a 2-hour window straddling "now" → hold until a future timestamp.
  after := app.quiet_deliver_after(wnd);
  if after is null or after <= now()
     then raise exception 'QUIET FAIL: active window returned % (expected future ts)', after; end if;
end $$;

-- ── (g) notifications stay farm-isolated with the new columns ──────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');   -- Owner B
  execute $q$ select count(*) from notifications where farm_id <> '22222222-2222-2222-2222-222222222222' $q$ into c;
  if c <> 0 then raise exception 'ISOLATION FAIL [ownerB]: sees % non-Farm-B notifications', c; end if;
end $$;
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  execute $q$ select count(*) from notifications where farm_id <> '11111111-1111-1111-1111-111111111111' $q$ into c;
  if c <> 0 then raise exception 'ISOLATION FAIL [ownerA]: sees % non-Farm-A notifications', c; end if;
end $$;
reset role;

select 'ALL 0205 NOTIFICATION-ENGINE TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- ═══ 0206: ADMIN FARM-ACCESS (IMPERSONATION) AUDIT (appended) ════
-- Proves: (a) a non-admin authenticated user CANNOT call
-- log_admin_farm_access (raises); (b) an rr_admin call appends exactly one
-- append-only audit_log row for that farm; (c) that row stays farm-scoped —
-- Owner B cannot see Farm A's admin-access row. Nothing above is modified.
-- ═════════════════════════════════════════════════════════════════
set role authenticated;

-- (a) non-admin is refused.
do $$
begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A (not admin)
  begin
    perform public.log_admin_farm_access('11111111-1111-1111-1111-111111111111', 'impersonate');
    raise exception 'ADMIN FAIL: non-admin was allowed to log farm access';
  exception
    when others then
      if sqlstate = 'P0001' and sqlerrm like 'ADMIN FAIL%' then raise; end if;   -- our own marker bubbles up
      -- otherwise the expected refusal — swallow
      null;
  end;
end $$;

-- (b) rr_admin call appends exactly one admin_farm_access row for Farm A.
do $$ declare c bigint; begin
  perform _t_login('d4444444-4444-4444-4444-444444444444');   -- RR admin
  perform public.log_admin_farm_access('11111111-1111-1111-1111-111111111111', 'impersonate');
  select count(*) into c from audit_log
    where entity = 'admin_farm_access'
      and farm_id = '11111111-1111-1111-1111-111111111111'
      and user_id = 'd4444444-4444-4444-4444-444444444444';
  if c <> 1 then raise exception 'ADMIN FAIL: expected 1 admin_farm_access row, got %', c; end if;
end $$;

-- (c) Owner B cannot see Farm A's admin-access audit row.
do $$ declare c bigint; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');   -- Owner B
  select count(*) into c from audit_log where entity = 'admin_farm_access';
  if c <> 0 then raise exception 'ADMIN FAIL: Owner B sees % admin_farm_access rows (expected 0)', c; end if;
end $$;

reset role;

select 'ALL 0206 ADMIN-AUDIT TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- ═══ 0210/0211: COST-ENTRIES & TCO SPINE (appended section) ══════
-- Proves: (a) a job-card part line auto-generates a farm-scoped `parts` cost entry via
-- the SECURITY DEFINER sync trigger; (b) cost_entries stay tenant-isolated (own-farm
-- visible, cross-tenant = 0, workshop scoped to its linked farm, rr_admin sees all,
-- anon none — anon covered in the anon sweep above); (c) app.machine_tco sums the
-- ledger under RLS and cannot read another farm's TCO; (d) a manual invoice-style entry
-- raises TCO; (e) cross-tenant cost writes are rejected; (f) soft-deleting a source line
-- soft-deletes its cost entry while preserving the row for audit. Nothing above is
-- modified. After the seed above, each farm has exactly one cost entry (its part line).
-- ═════════════════════════════════════════════════════════════════

-- (a) the sync trigger already fired during seed → assert the generated Farm A row.
do $$ declare v bigint; ty text; m uuid; begin
  select count(*) into v from cost_entries where farm_id = '11111111-1111-1111-1111-111111111111' and deleted_at is null;
  if v <> 1 then raise exception 'COST FAIL: Farm A cost_entries = % (expected 1 synced from the part line)', v; end if;
  select amount_cents, type::text, machine_id into v, ty, m from cost_entries
    where farm_id = '11111111-1111-1111-1111-111111111111' and source_type = 'job_card_line';
  if v <> 15000 or ty <> 'parts' or m <> 'aa111111-1111-1111-1111-111111111111'
    then raise exception 'COST FAIL: synced part line = (amount %, type %, machine %)', v, ty, m; end if;
end $$;

-- (b) per-persona isolation of cost_entries.
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  perform _t_assert('cost_entries', 1, 'ownerA');
  execute $q$ select count(*) from cost_entries where farm_id <> '11111111-1111-1111-1111-111111111111' $q$ into c;
  if c <> 0 then raise exception 'COST ISOLATION FAIL [ownerA]: sees % non-Farm-A cost rows', c; end if;
end $$;
do $$ begin perform _t_login('b2222222-2222-2222-2222-222222222222'); perform _t_assert('cost_entries', 1, 'ownerB');   end $$;
do $$ begin perform _t_login('c3333333-3333-3333-3333-333333333333'); perform _t_assert('cost_entries', 1, 'workshopW'); end $$;
do $$ begin perform _t_login('d4444444-4444-4444-4444-444444444444'); perform _t_assert('cost_entries', 2, 'rrAdmin');   end $$;
reset role;

-- (c) app.machine_tco sums the ledger under RLS and cannot cross tenants.
set role authenticated;
do $$ declare v bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  select app.machine_tco('aa111111-1111-1111-1111-111111111111') into v;
  if v <> 15000 then raise exception 'TCO FAIL: machine_tco(Farm A machine) = % (expected 15000)', v; end if;
  select app.machine_tco('bb222222-2222-2222-2222-222222222222') into v;   -- Farm B machine, invisible to A
  if v <> 0 then raise exception 'TCO ISOLATION FAIL: Owner A read Farm B TCO = % (expected 0)', v; end if;
end $$;
reset role;

-- (e) cross-tenant cost write is rejected (do this before the invoice mutation).
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  begin
    insert into cost_entries (farm_id, machine_id, type, amount_cents)
      values ('22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 'other', 999);
  exception when others then ok := true; end;
  if not ok then raise exception 'COST ISOLATION FAIL [ownerA]: inserted a cost entry into Farm B'; end if;
end $$;
reset role;

-- (d) a manual invoice-style entry (FR-8.4) raises the machine's TCO.
set role authenticated;
do $$ declare v bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  insert into cost_entries (farm_id, machine_id, type, amount_cents, source_type, source_id, occurred_on)
    values ('11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 'invoice', 50000,
            'job_card', 'ac111111-1111-1111-1111-111111111111', current_date);
  select app.machine_tco('aa111111-1111-1111-1111-111111111111') into v;
  if v <> 65000 then raise exception 'INVOICE FAIL: TCO after invoice = % (expected 65000)', v; end if;
end $$;
reset role;

-- (f) soft-deleting the source line soft-deletes its cost entry (preserved for audit).
-- Farm B's job card (bc222222) is NOT locked, so its line may be soft-deleted.
update job_card_lines set deleted_at = now() where job_card_id = 'bc222222-2222-2222-2222-222222222222';
do $$ declare v bigint; begin
  select count(*) into v from cost_entries
    where source_type = 'job_card_line' and farm_id = '22222222-2222-2222-2222-222222222222' and deleted_at is null;
  if v <> 0 then raise exception 'COST SYNC FAIL: Farm B cost entry survived line soft-delete (% still active)', v; end if;
  select count(*) into v from cost_entries
    where source_type = 'job_card_line' and farm_id = '22222222-2222-2222-2222-222222222222' and deleted_at is not null;
  if v <> 1 then raise exception 'COST SYNC FAIL: Farm B cost entry not preserved for audit (% soft-deleted)', v; end if;
end $$;

-- (g) setting a machine's purchase price seeds a `purchase` cost entry via the trigger.
update machines set purchase_price_cents = 120000000, purchase_date = current_date
  where id = 'bb222222-2222-2222-2222-222222222222';
do $$ declare v bigint; ty text; begin
  select amount_cents, type::text into v, ty from cost_entries
    where source_type = 'machine' and source_id = 'bb222222-2222-2222-2222-222222222222' and deleted_at is null;
  if v is distinct from 120000000 or ty <> 'purchase'
    then raise exception 'PURCHASE FAIL: machine purchase cost entry = (amount %, type %)', v, ty; end if;
end $$;

select 'ALL 0210/0211 COST-ENTRIES & TCO TESTS PASSED' as result;

-- ═══ 0220: OFFLINE SYNC — deterministic LWW conflict resolution ══
-- Proves: (a) two conflicting offline reading edits for the same machine reconcile
-- deterministically by client timestamp (last-writer-wins); (b) the superseded value
-- is preserved (no silent loss); (c) BOTH reading rows survive in history + audit_log
-- (recoverable); (d) authenticated CANNOT execute the service-role apply function.
-- Nothing above this line is modified.
-- ═════════════════════════════════════════════════════════════════

-- A dedicated Farm A machine so the conflict fixtures don't disturb earlier counts.
insert into machines (id, farm_id, name, type, meter_type) values
  ('aa777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'Conflict A', 'tractor', 'hours');

-- (d) a normal farm user must not be able to call the service-role apply function.
set role authenticated;
do $$ begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  begin
    perform public.sync_apply_reading(
      '11111111-1111-1111-1111-111111111111'::uuid, 'aa777777-7777-7777-7777-777777777777'::uuid,
      1, current_date, 'manual'::meter_source, null::uuid, now());
    raise exception 'SYNC PRIV FAIL: authenticated executed sync_apply_reading';
  exception
    when insufficient_privilege then null;                 -- expected
    when others then if sqlstate = 'P0001' then raise; end if;
  end;
end $$;
reset role;

-- (a)(b)(c) forced conflict — as the service role (the /api/sync route's identity).
set role service_role;
do $$
declare
  m uuid := 'aa777777-7777-7777-7777-777777777777';
  f uuid := '11111111-1111-1111-1111-111111111111';
  r1 jsonb; r2 jsonb;
  v_reading numeric; v_ts timestamptz; v_hist bigint;
begin
  -- Edit X: LATER client timestamp, reading 1200 → becomes the winner.
  r1 := public.sync_apply_reading(f, m, 1200, current_date, 'manual'::meter_source, null,
        '2026-01-01T10:00:00Z'::timestamptz);
  if r1->>'status' <> 'applied' then raise exception 'CONFLICT FAIL: first edit status=% (expected applied)', r1->>'status'; end if;

  -- Edit Y: EARLIER client timestamp, reading 1000, arrives late → must LOSE.
  r2 := public.sync_apply_reading(f, m, 1000, current_date, 'manual'::meter_source, null,
        '2026-01-01T09:00:00Z'::timestamptz);
  if r2->>'status' <> 'conflict' then raise exception 'CONFLICT FAIL: stale edit status=% (expected conflict)', r2->>'status'; end if;
  if (r2->'superseded'->>'reading')::numeric <> 1000 then
    raise exception 'CONFLICT FAIL: superseded value not preserved: %', r2->'superseded'; end if;

  -- Deterministic outcome: the machine reflects the greatest-timestamp writer (1200).
  select current_reading, current_reading_client_ts into v_reading, v_ts from machines where id = m;
  if v_reading <> 1200 then raise exception 'LWW FAIL: current_reading=% (expected 1200)', v_reading; end if;
  if v_ts <> '2026-01-01T10:00:00Z'::timestamptz then raise exception 'LWW FAIL: winner ts=% (expected 10:00Z)', v_ts; end if;

  -- No silent loss: BOTH reading rows persist in append-only history.
  select count(*) into v_hist from meter_readings where machine_id = m and deleted_at is null;
  if v_hist <> 2 then raise exception 'HISTORY FAIL: expected 2 reading rows, got %', v_hist; end if;
end $$;
reset role;

-- The losing value is ALSO recoverable from the append-only audit_log (both inserts logged).
do $$ declare c bigint; begin
  select count(*) into c from audit_log
    where entity = 'meter_readings'
      and (diff->'new'->>'machine_id') = 'aa777777-7777-7777-7777-777777777777';
  if c <> 2 then raise exception 'AUDIT FAIL: expected 2 audit rows for conflict readings, got %', c; end if;
end $$;

select 'ALL 0220 OFFLINE-SYNC TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- ═══ F3: FIELD CAPTURE & ACCOUNTABILITY (0230–0236, appended) ═════
-- Proves: (a) usage_logs cross-tenant WRITE denial; (b) a `stopped` fault flips the
-- machine to out_of_service (active-but-down), while retired/sold are never flipped;
-- (c) the extended fault lifecycle (acknowledged / in_progress) + assignee persist;
-- (d) the "driver on date D" usage query is farm-scoped. Nothing above is modified.
-- ═════════════════════════════════════════════════════════════════

-- Fresh Farm A machine for the out-of-service + usage tests (avoids disturbing counts).
insert into machines (id, farm_id, name, type, status) values
  ('aa333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'F3 Machine', 'tractor', 'active');

-- (a) Owner A cannot write a usage_log into Farm B.
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  begin
    insert into usage_logs (farm_id, machine_id, driver_user_id, meter_reading, source)
      values ('22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222',
              'a1111111-1111-1111-1111-111111111111', 5, 'app');
  exception when others then ok := true; end;
  if not ok then raise exception 'ISOLATION FAIL [ownerA]: wrote a usage_log into Farm B'; end if;
end $$;
reset role;

-- (b) a `stopped` fault flips the machine to out_of_service (trigger, any path).
insert into faults (id, farm_id, machine_id, description, urgency, status) values
  ('a5333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
   'aa333333-3333-3333-3333-333333333333', 'Engine seized', 'stopped', 'open');
do $$ declare s text; begin
  select status::text into s from machines where id = 'aa333333-3333-3333-3333-333333333333';
  if s <> 'out_of_service' then raise exception 'OOS FAIL: stopped fault did not flip machine (status=%)', s; end if;
end $$;

-- (b) retired machines are NEVER flipped by a stopped fault.
insert into faults (farm_id, machine_id, description, urgency, status) values
  ('11111111-1111-1111-1111-111111111111', 'aa999999-9999-9999-9999-999999999999', 'Dead', 'stopped', 'open');
do $$ declare s text; begin
  select status::text into s from machines where id = 'aa999999-9999-9999-9999-999999999999';
  if s <> 'retired' then raise exception 'OOS FAIL: a retired machine was flipped (status=%)', s; end if;
end $$;

-- (c) fault lifecycle: acknowledged → in_progress + assignee persist.
update faults set status = 'acknowledged', assigned_to = 'a1111111-1111-1111-1111-1111111111aa'
  where id = 'a5333333-3333-3333-3333-333333333333';
update faults set status = 'in_progress'
  where id = 'a5333333-3333-3333-3333-333333333333';
do $$ declare s text; a uuid; begin
  select status::text, assigned_to into s, a from faults where id = 'a5333333-3333-3333-3333-333333333333';
  if s <> 'in_progress' then raise exception 'LIFECYCLE FAIL: status=% (expected in_progress)', s; end if;
  if a is distinct from 'a1111111-1111-1111-1111-1111111111aa' then raise exception 'LIFECYCLE FAIL: assignee not persisted'; end if;
end $$;

-- (d) "driver on date D": a farm-scoped usage query returns the right driver, and
-- never leaks across tenants.
insert into usage_logs (farm_id, machine_id, driver_user_id, driver_name, occurred_on, meter_reading, source) values
  ('11111111-1111-1111-1111-111111111111', 'aa333333-3333-3333-3333-333333333333',
   'a1111111-1111-1111-1111-1111111111aa', 'Manager A', date '2026-05-01', 1234, 'app');
set role authenticated;
do $$ declare c bigint; d uuid; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  select count(*) into c from usage_logs
    where machine_id = 'aa333333-3333-3333-3333-333333333333' and occurred_on = date '2026-05-01' and deleted_at is null;
  if c <> 1 then raise exception 'USAGE FAIL: driver-on-date returned % rows (expected 1)', c; end if;
  select driver_user_id into d from usage_logs
    where machine_id = 'aa333333-3333-3333-3333-333333333333' and occurred_on = date '2026-05-01' and deleted_at is null
    limit 1;
  if d is distinct from 'a1111111-1111-1111-1111-1111111111aa' then raise exception 'USAGE FAIL: wrong driver on date'; end if;
  -- Owner B sees none of Farm A's usage logs.
  perform _t_login('b2222222-2222-2222-2222-222222222222');
  select count(*) into c from usage_logs where machine_id = 'aa333333-3333-3333-3333-333333333333';
  if c <> 0 then raise exception 'USAGE FAIL: Owner B leaked % Farm A usage logs', c; end if;
end $$;
reset role;

select 'ALL F3 FIELD-CAPTURE TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- ═══ F4: FUEL MODULE (0240–0242, appended section) ═══════════════
-- Proves:
--   (a) NO DOUBLE-COUNT: with the per-issue attribution model (0241), a delivery books
--       ZERO fuel cost entries and each costed issue books exactly ONE per-machine fuel
--       cost entry, so a farm's fuel appears in TCO exactly once (= Σ issue costs), never
--       delivery + issue.
--   (b) fuel_issues → per-machine `fuel` cost_entry raises app.machine_tco.
--   (c) app.machine_fuel_consumption computes L/hr from issues-vs-meter deltas under RLS
--       (and reads 0 across tenants).
--   (d) app.enqueue_fuel_anomalies flags a draw above the rolling baseline, enqueues a
--       farm-scoped `fuel_anomaly` to owner+manager, honours retired/sold exclusion, and
--       dedupes on re-run.
--   (e) authenticated CANNOT execute the anomaly engine / its cron wrapper.
--   (f) cross-tenant fuel_issues WRITE denial (new columns don't loosen RLS).
-- Nothing above this line is modified. Fresh Farm A fixtures avoid disturbing earlier
-- counts; Manager A (added in the 0205 section) makes Farm A alerts target 2 recipients.
-- ═════════════════════════════════════════════════════════════════

-- A dedicated Farm A machine (hours meter) + reuse Tank A (af111111). Five metered draws:
-- four at a steady 0.5 L/hr, then one at 1.0 L/hr (an anomaly vs the 0.5 baseline).
insert into machines (id, farm_id, name, type, status, meter_type) values
  ('aaf20000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Fuel A', 'tractor', 'active', 'hours');

-- A delivery WITH a price (R18.00/L ex-VAT × 1000 L). Under the per-issue model this must
-- book ZERO cost entries (it is tank stock, not an asset cost).
insert into fuel_deliveries (farm_id, tank_id, date, litres, price_per_l_cents) values
  ('11111111-1111-1111-1111-111111111111', 'af111111-1111-1111-1111-111111111111', date '2026-06-01', 1000, 1800);

-- Costed per-machine draws (ex-VAT cost_cents). Σ cost = 630000c.
insert into fuel_issues (farm_id, tank_id, machine_id, date, litres, meter_reading, cost_cents) values
  ('11111111-1111-1111-1111-111111111111', 'af111111-1111-1111-1111-111111111111', 'aaf20000-0000-0000-0000-000000000001', date '2026-06-01', 100, 1000, 180000),
  ('11111111-1111-1111-1111-111111111111', 'af111111-1111-1111-1111-111111111111', 'aaf20000-0000-0000-0000-000000000001', date '2026-06-05',  50, 1100,  90000),
  ('11111111-1111-1111-1111-111111111111', 'af111111-1111-1111-1111-111111111111', 'aaf20000-0000-0000-0000-000000000001', date '2026-06-10',  50, 1200,  90000),
  ('11111111-1111-1111-1111-111111111111', 'af111111-1111-1111-1111-111111111111', 'aaf20000-0000-0000-0000-000000000001', date '2026-06-15',  50, 1300,  90000),
  ('11111111-1111-1111-1111-111111111111', 'af111111-1111-1111-1111-111111111111', 'aaf20000-0000-0000-0000-000000000001', date '2026-06-20', 100, 1400, 180000);

-- (a) NO DOUBLE-COUNT: the delivery booked ZERO fuel cost entries…
do $$ declare v bigint; begin
  select count(*) into v from cost_entries
    where source_type = 'fuel_delivery' and farm_id = '11111111-1111-1111-1111-111111111111' and deleted_at is null;
  if v <> 0 then raise exception 'FUEL DOUBLE-COUNT FAIL: delivery booked % fuel cost entries (expected 0)', v; end if;
  -- …and each costed issue booked exactly one per-machine fuel cost entry.
  select count(*) into v from cost_entries
    where source_type = 'fuel_issue' and machine_id = 'aaf20000-0000-0000-0000-000000000001' and deleted_at is null;
  if v <> 5 then raise exception 'FUEL SYNC FAIL: expected 5 issue cost entries, got %', v; end if;
  -- Farm A fuel total = Σ issue costs (630000), NOT Σ issues + delivery(1 800 000): once.
  select coalesce(sum(amount_cents), 0) into v from cost_entries
    where type = 'fuel' and farm_id = '11111111-1111-1111-1111-111111111111' and deleted_at is null;
  if v <> 630000 then raise exception 'FUEL ONCE FAIL: farm fuel in ledger = % (expected 630000, proving no delivery double-count)', v; end if;
end $$;

-- (b) app.machine_tco includes the issued fuel (machine has only fuel costs → 630000).
set role authenticated;
do $$ declare v bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  select app.machine_tco('aaf20000-0000-0000-0000-000000000001') into v;
  if v <> 630000 then raise exception 'FUEL TCO FAIL: machine_tco(Fuel A) = % (expected 630000)', v; end if;
end $$;
reset role;

-- (c) consumption metric: 3 intervals of 0.5 L/hr → lifetime 0.5 L/hr (150 L / 300 h),
--     but the anomaly draw (4th interval, 1.0 L/hr) makes the lifetime 250 L / 400 h.
set role authenticated;
do $$ declare j jsonb; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  j := app.machine_fuel_consumption('aaf20000-0000-0000-0000-000000000001');
  if (j->>'unit') <> 'hours' then raise exception 'FUEL METRIC FAIL: unit = % (expected hours)', j->>'unit'; end if;
  if (j->>'intervals')::int <> 4 then raise exception 'FUEL METRIC FAIL: intervals = % (expected 4)', j->>'intervals'; end if;
  if (j->>'litres')::numeric <> 250 then raise exception 'FUEL METRIC FAIL: litres = % (expected 250)', j->>'litres'; end if;
  if (j->>'meter_span')::numeric <> 400 then raise exception 'FUEL METRIC FAIL: meter_span = % (expected 400)', j->>'meter_span'; end if;
  if round((j->>'consumption')::numeric, 4) <> 0.6250 then raise exception 'FUEL METRIC FAIL: consumption = % (expected 0.625 L/hr)', j->>'consumption'; end if;
  -- cross-tenant: Owner B reads no Farm A fuel → zero intervals.
  perform _t_login('b2222222-2222-2222-2222-222222222222');
  j := app.machine_fuel_consumption('aaf20000-0000-0000-0000-000000000001');
  if (j->>'intervals')::int <> 0 then raise exception 'FUEL METRIC ISOLATION FAIL: Owner B saw % Farm A intervals', j->>'intervals'; end if;
end $$;
reset role;

-- A retired Farm A machine with an identical anomalous series — must NEVER enqueue.
insert into machines (id, farm_id, name, type, status, meter_type) values
  ('aaf20000-0000-0000-0000-0000000000ff', '11111111-1111-1111-1111-111111111111', 'Fuel Retired', 'tractor', 'retired', 'hours');
insert into fuel_issues (farm_id, tank_id, machine_id, date, litres, meter_reading) values
  ('11111111-1111-1111-1111-111111111111', 'af111111-1111-1111-1111-111111111111', 'aaf20000-0000-0000-0000-0000000000ff', date '2026-06-01', 100, 1000),
  ('11111111-1111-1111-1111-111111111111', 'af111111-1111-1111-1111-111111111111', 'aaf20000-0000-0000-0000-0000000000ff', date '2026-06-05',  50, 1100),
  ('11111111-1111-1111-1111-111111111111', 'af111111-1111-1111-1111-111111111111', 'aaf20000-0000-0000-0000-0000000000ff', date '2026-06-10',  50, 1200),
  ('11111111-1111-1111-1111-111111111111', 'af111111-1111-1111-1111-111111111111', 'aaf20000-0000-0000-0000-0000000000ff', date '2026-06-15',  50, 1300),
  ('11111111-1111-1111-1111-111111111111', 'af111111-1111-1111-1111-111111111111', 'aaf20000-0000-0000-0000-0000000000ff', date '2026-06-20', 100, 1400);

-- (e) authenticated CANNOT execute the engine / cron wrapper.
set role authenticated;
do $$
declare calls text[] := array[
  'select app.enqueue_fuel_anomalies()',
  'select public.cron_enqueue_fuel_anomalies()'
]; c text;
begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  foreach c in array calls loop
    begin
      execute c;
      raise exception 'FUEL PRIV FAIL: authenticated executed % without a privilege error', c;
    exception
      when insufficient_privilege then null;                 -- expected
      when others then if sqlstate = 'P0001' then raise; end if;
    end;
  end loop;
end $$;
reset role;

-- (d) run the anomaly engine as the service role (the nightly route's identity).
set role service_role;
do $$ begin perform app.enqueue_fuel_anomalies(); end $$;
reset role;

do $$ declare fa uuid := '11111111-1111-1111-1111-111111111111'; begin
  -- exactly ONE anomalous draw on Fuel A → owner + manager = 2 rows; retired machine adds 0.
  if _t_notif(fa, 'fuel_anomaly') <> 2 then
    raise exception 'FUEL ANOMALY FAIL: Farm A fuel_anomaly = % (expected 2: retired machine must be excluded)', _t_notif(fa, 'fuel_anomaly');
  end if;
  if _t_notif('22222222-2222-2222-2222-222222222222', 'fuel_anomaly') <> 0 then
    raise exception 'FUEL ANOMALY FAIL: Farm B received an un-warranted fuel_anomaly';
  end if;
  -- the flagged draw (1.0 L/hr at meter 1400) is marked notified; the steady draws are not.
  perform 1 from fuel_issues where machine_id = 'aaf20000-0000-0000-0000-000000000001'
    and meter_reading = 1400 and anomaly_notified_at is not null;
  if not found then raise exception 'FUEL ANOMALY FAIL: anomalous draw not marked notified'; end if;
end $$;

-- (d) dedupe: a second run enqueues nothing new.
set role service_role;
do $$ begin perform app.enqueue_fuel_anomalies(); end $$;
reset role;
do $$ begin
  if _t_notif('11111111-1111-1111-1111-111111111111', 'fuel_anomaly') <> 2 then
    raise exception 'FUEL ANOMALY DEDUPE FAIL: Farm A fuel_anomaly changed on re-run';
  end if;
end $$;

-- (f) cross-tenant fuel_issues WRITE denial (with the new cost columns present).
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  begin
    insert into fuel_issues (farm_id, tank_id, machine_id, litres, cost_cents)
      values ('22222222-2222-2222-2222-222222222222', 'bf222222-2222-2222-2222-222222222222',
              'bb222222-2222-2222-2222-222222222222', 10, 5000);
  exception when others then ok := true; end;
  if not ok then raise exception 'FUEL ISOLATION FAIL [ownerA]: wrote a fuel_issue into Farm B'; end if;
end $$;
reset role;

select 'ALL F4 FUEL-MODULE TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- ═══ F5: PLANS & ENTITLEMENT GATING (0250–0251, appended) ════════
-- Proves: (a) app.has_entitlement / public.has_entitlement gate by the FARM's plan —
-- essential denies dashboard/fuel/aarto, allows ungated core; complete allows the P+/C+
-- features but not api_access; done_for_you unlocks api_access; (b) cross-tenant
-- isolation — a user cannot read another farm's entitlement (no plan probing), while
-- rr_admin reads any farm's real result; (c) anon cannot execute the helper; (d) the
-- asset_count trigger keeps farms.asset_count current (out_of_service counts; retired /
-- sold / soft-deleted excluded). Farm A/B were seeded with no plan → default 'essential'.
-- This section MUTATES Farm A's plan and adds a fresh Farm C; nothing above is modified.
-- ═════════════════════════════════════════════════════════════════

-- (a) essential (default) denies gated features; ungated core allowed. As Owner A.
set role authenticated;
do $$ declare fa uuid := '11111111-1111-1111-1111-111111111111'; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  if app.has_entitlement(fa,'dashboard') then raise exception 'ENT FAIL: essential has dashboard'; end if;
  if app.has_entitlement(fa,'fuel')      then raise exception 'ENT FAIL: essential has fuel'; end if;
  if app.has_entitlement(fa,'aarto')     then raise exception 'ENT FAIL: essential has aarto'; end if;
  if not app.has_entitlement(fa,'machines') then raise exception 'ENT FAIL: essential denied an ungated feature'; end if;
  -- the public PostgREST wrapper agrees with the app.* helper.
  if public.has_entitlement(fa,'dashboard') then raise exception 'ENT FAIL: public wrapper allowed dashboard on essential'; end if;
  if not public.has_entitlement(fa,'machines') then raise exception 'ENT FAIL: public wrapper denied an ungated feature'; end if;
end $$;
reset role;

-- (b) upgrade Farm A → complete: the Professional+/Complete+ features unlock; api_access
-- (done_for_you) still denied.
update farms set plan = 'complete' where id = '11111111-1111-1111-1111-111111111111';
set role authenticated;
do $$ declare fa uuid := '11111111-1111-1111-1111-111111111111'; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  if not app.has_entitlement(fa,'dashboard') then raise exception 'ENT FAIL: complete missing dashboard'; end if;
  if not app.has_entitlement(fa,'fuel')      then raise exception 'ENT FAIL: complete missing fuel'; end if;
  if not app.has_entitlement(fa,'aarto')     then raise exception 'ENT FAIL: complete missing aarto'; end if;
  if app.has_entitlement(fa,'api_access')    then raise exception 'ENT FAIL: complete unexpectedly has api_access'; end if;
end $$;
reset role;

-- (b) upgrade Farm A → done_for_you: api_access unlocks.
update farms set plan = 'done_for_you' where id = '11111111-1111-1111-1111-111111111111';
set role authenticated;
do $$ begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  if not app.has_entitlement('11111111-1111-1111-1111-111111111111','api_access')
    then raise exception 'ENT FAIL: done_for_you missing api_access'; end if;
end $$;
reset role;

-- (c) cross-tenant isolation: Owner A cannot read Farm B's entitlement — not even an
-- ungated feature — because they have no access to Farm B (no plan probing).
set role authenticated;
do $$ declare fb uuid := '22222222-2222-2222-2222-222222222222'; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  if app.has_entitlement(fb,'machines')  then raise exception 'ENT ISOLATION FAIL: Owner A read Farm B ungated entitlement'; end if;
  if app.has_entitlement(fb,'dashboard') then raise exception 'ENT ISOLATION FAIL: Owner A read Farm B gated entitlement'; end if;
end $$;
-- rr_admin can read any farm's real result (Farm B is essential → ungated yes, dashboard no).
do $$ declare fb uuid := '22222222-2222-2222-2222-222222222222'; begin
  perform _t_login('d4444444-4444-4444-4444-444444444444');   -- RR admin
  if not app.has_entitlement(fb,'machines') then raise exception 'ENT FAIL: rr_admin denied ungated on Farm B'; end if;
  if app.has_entitlement(fb,'dashboard')    then raise exception 'ENT FAIL: rr_admin saw dashboard on essential Farm B'; end if;
end $$;
reset role;

-- (c) anon cannot execute the entitlement helper (revoked from anon).
set role anon;
do $$ begin
  perform set_config('request.jwt.claims', '', false);
  begin
    perform public.has_entitlement('11111111-1111-1111-1111-111111111111','dashboard');
    raise exception 'ENT PRIV FAIL: anon executed public.has_entitlement';
  exception
    when insufficient_privilege then null;                 -- expected
    when others then if sqlstate = 'P0001' then raise; end if;
  end;
end $$;
reset role;

-- (d) asset_count trigger: fresh farm starts at 0; out_of_service counts; retired/sold
-- and soft-deleted are excluded; status/soft-delete changes recompute.
insert into farms (id, name, plan, billing_period) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Farm C', 'professional', 'annual');
do $$ declare v int; begin
  select asset_count into v from farms where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  if v <> 0 then raise exception 'ASSET COUNT FAIL: new farm asset_count = % (expected 0)', v; end if;
end $$;
insert into machines (farm_id, name, type, status) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'C1', 'tractor', 'active'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'C2', 'tractor', 'active'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'C3', 'tractor', 'out_of_service'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'C4', 'tractor', 'retired'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'C5', 'tractor', 'sold');
do $$ declare v int; begin
  select asset_count into v from farms where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  if v <> 3 then raise exception 'ASSET COUNT FAIL: asset_count = % (expected 3: out_of_service counts, retired/sold excluded)', v; end if;
end $$;
update machines set deleted_at = now() where farm_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' and name = 'C1';
do $$ declare v int; begin
  select asset_count into v from farms where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  if v <> 2 then raise exception 'ASSET COUNT FAIL: after soft-delete asset_count = % (expected 2)', v; end if;
end $$;
update machines set status = 'retired' where farm_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' and name = 'C2';
do $$ declare v int; begin
  select asset_count into v from farms where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  if v <> 1 then raise exception 'ASSET COUNT FAIL: after retire asset_count = % (expected 1)', v; end if;
end $$;

select 'ALL F5 ENTITLEMENT TESTS PASSED' as result;

-- ═══ F6: COMPLIANCE REMINDERS & WEB PUSH (0260–0263, appended) ═══
-- Proves:
--   (a) `licences` is tenant-isolated (own-farm visible, cross-tenant = 0, workshop
--       scoped to its linked farm, rr_admin sees all, anon covered in the anon sweep);
--       cross-tenant licence WRITE is rejected.
--   (b) `push_subscriptions` is OWN-USER isolated (a farm-mate cannot see or write another
--       user's device tokens); cross-user WRITE is rejected.
--   (c) authenticated CANNOT execute the expiry engine / its cron wrapper.
--   (d) app.enqueue_expiry_notifications enqueues warranty + licence reminders to the right
--       farm's owner+manager (2 each), never cross-tenant; excludes retired machines; dedupes
--       on re-run.
--   (e) per-user prefs: a recipient with notify_inapp = false receives no in-app row.
-- Fresh fixtures avoid disturbing earlier counts. Manager A (0205 section) makes Farm A
-- alerts target 2 recipients. Nothing above this line is modified.
-- ═════════════════════════════════════════════════════════════════

-- ── Fixtures (superuser; RLS bypassed) ────────────────────────────
-- Active machines with a warranty expiring soon (date within the default 30-day lead).
insert into machines (id, farm_id, name, type, meter_type, current_reading, status, warranty_expiry_date) values
  ('aae60000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Warranty A', 'tractor', 'hours', 100, 'active', current_date + 10),
  ('bbe60000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'Warranty B', 'tractor', 'hours', 100, 'active', current_date + 10);
-- A RETIRED Farm A machine with an EXPIRED warranty — must NEVER enqueue.
insert into machines (id, farm_id, name, type, status, warranty_expiry_date) values
  ('aae60000-0000-0000-0000-0000000000f0', '11111111-1111-1111-1111-111111111111', 'Retired Warranty A', 'tractor', 'retired', current_date - 5);

-- Licences: Farm A expired (enqueues), Farm B in-date (silent), Farm A retired-machine (excluded).
insert into licences (id, farm_id, machine_id, type, number, expiry_date, reminder_lead_days) values
  ('11ce0000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'aae60000-0000-0000-0000-000000000001', 'vehicle_licence', 'ND-A-123', current_date - 3,   30),
  ('22ce0000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'bbe60000-0000-0000-0000-000000000002', 'vehicle_licence', 'ND-B-999', current_date + 200, 30),
  ('11ce0000-0000-0000-0000-0000000000f0', '11111111-1111-1111-1111-111111111111', 'aae60000-0000-0000-0000-0000000000f0', 'roadworthy',      'RW-OLD',   current_date - 100, 30);

-- Push subscriptions: one for Owner A, one for Manager A (both Farm A).
insert into push_subscriptions (id, farm_id, user_id, endpoint, p256dh, auth) values
  ('50b50000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'https://push.example/ownerA', 'p256dh-a', 'auth-a'),
  ('50b50000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111111aa', 'https://push.example/managerA', 'p256dh-m', 'auth-m');

-- ── (a) licences isolation ────────────────────────────────────────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  perform _t_assert('licences', 2, 'ownerA');                 -- both Farm A licences (incl. retired-machine one)
  execute $q$ select count(*) from licences where farm_id <> '11111111-1111-1111-1111-111111111111' $q$ into c;
  if c <> 0 then raise exception 'LICENCE ISOLATION FAIL [ownerA]: sees % non-Farm-A licences', c; end if;
end $$;
do $$ begin perform _t_login('b2222222-2222-2222-2222-222222222222'); perform _t_assert('licences', 1, 'ownerB');    end $$;
do $$ begin perform _t_login('c3333333-3333-3333-3333-333333333333'); perform _t_assert('licences', 2, 'workshopW'); end $$;
do $$ begin perform _t_login('d4444444-4444-4444-4444-444444444444'); perform _t_assert('licences', 3, 'rrAdmin');   end $$;
reset role;

-- (a) cross-tenant licence WRITE is rejected.
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  begin
    insert into licences (farm_id, machine_id, type, expiry_date)
      values ('22222222-2222-2222-2222-222222222222', 'bbe60000-0000-0000-0000-000000000002', 'permit', current_date + 30);
  exception when others then ok := true; end;
  if not ok then raise exception 'LICENCE ISOLATION FAIL [ownerA]: wrote a licence into Farm B'; end if;
end $$;
reset role;

-- ── (b) push_subscriptions own-user isolation ─────────────────────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  perform _t_assert('push_subscriptions', 1, 'ownerA');       -- sees ONLY own (not Manager A's)
  execute $q$ select count(*) from push_subscriptions where user_id <> 'a1111111-1111-1111-1111-111111111111' $q$ into c;
  if c <> 0 then raise exception 'PUSH ISOLATION FAIL [ownerA]: sees % other-user subscriptions', c; end if;
end $$;
do $$ begin perform _t_login('a1111111-1111-1111-1111-1111111111aa'); perform _t_assert('push_subscriptions', 1, 'managerA'); end $$;
do $$ begin perform _t_login('b2222222-2222-2222-2222-222222222222'); perform _t_assert('push_subscriptions', 0, 'ownerB');   end $$;
reset role;

-- (b) cross-user push WRITE is rejected (with check user_id = auth.uid()).
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A impersonating Manager A
  begin
    insert into push_subscriptions (farm_id, user_id, endpoint, p256dh, auth)
      values ('11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111111aa', 'https://push.example/evil', 'x', 'y');
  exception when others then ok := true; end;
  if not ok then raise exception 'PUSH ISOLATION FAIL [ownerA]: wrote a subscription for another user'; end if;
end $$;
reset role;

-- ── (c) authenticated CANNOT execute the expiry engine / cron wrapper ──
set role authenticated;
do $$
declare calls text[] := array[
  'select app.enqueue_expiry_notifications()',
  'select public.cron_enqueue_expiry_notifications()'
]; c text;
begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  foreach c in array calls loop
    begin
      execute c;
      raise exception 'EXPIRY PRIV FAIL: authenticated executed % without a privilege error', c;
    exception
      when insufficient_privilege then null;                 -- expected
      when others then if sqlstate = 'P0001' then raise; end if;
    end;
  end loop;
end $$;
reset role;

-- ── (d) run the expiry engine as the service role (the nightly route's identity) ──
set role service_role;
do $$ begin perform app.enqueue_expiry_notifications(); end $$;
reset role;

do $$
declare fa uuid := '11111111-1111-1111-1111-111111111111';
        fb uuid := '22222222-2222-2222-2222-222222222222';
begin
  -- Warranty A (expiring) → owner + manager = 2; retired warranty machine adds 0.
  if _t_notif(fa, 'warranty_expiring') <> 2 then
    raise exception 'EXPIRY FAIL: Farm A warranty_expiring = % (expected 2)', _t_notif(fa, 'warranty_expiring');
  end if;
  if _t_notif(fa, 'warranty_expired') <> 0 then
    raise exception 'EXPIRY FAIL: Farm A warranty_expired = % (retired machine must be excluded)', _t_notif(fa, 'warranty_expired');
  end if;
  -- Farm A expired licence → owner + manager = 2; retired-machine licence excluded.
  if _t_notif(fa, 'licence_expired') <> 2 then
    raise exception 'EXPIRY FAIL: Farm A licence_expired = % (expected 2; retired-machine licence excluded)', _t_notif(fa, 'licence_expired');
  end if;
  -- Farm B: its own warranty_expiring (1); its in-date licence stays silent.
  if _t_notif(fb, 'warranty_expiring') <> 1 then
    raise exception 'EXPIRY FAIL: Farm B warranty_expiring = % (expected 1)', _t_notif(fb, 'warranty_expiring');
  end if;
  if _t_notif(fb, 'licence_expired') <> 0 or _t_notif(fb, 'licence_expiring') <> 0 then
    raise exception 'EXPIRY FAIL: Farm B received an un-warranted licence reminder';
  end if;
end $$;

-- (d) dedupe: a second run enqueues nothing new.
set role service_role;
do $$ begin perform app.enqueue_expiry_notifications(); end $$;
reset role;
do $$ declare fa uuid := '11111111-1111-1111-1111-111111111111'; begin
  if _t_notif(fa, 'warranty_expiring') <> 2 or _t_notif(fa, 'licence_expired') <> 2 then
    raise exception 'EXPIRY DEDUPE FAIL: Farm A counts changed on re-run (warranty=%, licence=%)',
      _t_notif(fa, 'warranty_expiring'), _t_notif(fa, 'licence_expired');
  end if;
end $$;

-- ── (e) per-user prefs: notify_inapp = false suppresses the in-app row ──
insert into machines (id, farm_id, name, type, meter_type, current_reading, status, warranty_expiry_date) values
  ('aae60000-0000-0000-0000-0000000000e5', '11111111-1111-1111-1111-111111111111', 'Prefs A', 'tractor', 'hours', 100, 'active', current_date + 10);
update users set notify_inapp = false where id = 'a1111111-1111-1111-1111-1111111111aa';   -- Manager A opts out of in-app

set role service_role;
do $$ begin perform app.enqueue_expiry_notifications(); end $$;
reset role;

do $$
declare
  fa uuid := '11111111-1111-1111-1111-111111111111';
  mgr uuid := 'a1111111-1111-1111-1111-1111111111aa';
  own uuid := 'a1111111-1111-1111-1111-111111111111';
  c_mgr bigint; c_own bigint;
begin
  -- Only the new Prefs A machine should have fired (others deduped) → owner only, not manager.
  select count(*) into c_mgr from notifications
    where farm_id = fa and template = 'warranty_expiring'
      and payload->>'machine_id' = 'aae60000-0000-0000-0000-0000000000e5' and user_id = mgr and deleted_at is null;
  select count(*) into c_own from notifications
    where farm_id = fa and template = 'warranty_expiring'
      and payload->>'machine_id' = 'aae60000-0000-0000-0000-0000000000e5' and user_id = own and deleted_at is null;
  if c_mgr <> 0 then raise exception 'PREFS FAIL: opted-out Manager A still received % in-app rows', c_mgr; end if;
  if c_own <> 1 then raise exception 'PREFS FAIL: Owner A received % rows for Prefs A (expected 1)', c_own; end if;
end $$;

select 'ALL F6 COMPLIANCE & PUSH TESTS PASSED' as result;

-- ═══ F10: VEHICLE CAPTURE + PRIMARY IMAGE (0280, appended) ═══════════
-- Proves the primary-image reference (machines.primary_attachment_id) stays
-- farm-isolated: the composite FK to attachments(id, farm_id) lets a machine point
-- ONLY at a photo of its own farm; and the new capture columns (cost_centre /
-- department) are farm-scoped like the rest of the row. Runs as superuser (RLS
-- bypassed for seeding) — FK + tenant checks still apply.
reset role;

insert into attachments (id, farm_id, parent_type, parent_id, kind, storage_path) values
  ('a7100000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'machine',
     'aa111111-1111-1111-1111-111111111111', 'photo',
     '11111111-1111-1111-1111-111111111111/aa111111-1111-1111-1111-111111111111/p.jpg'),
  ('b7200000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'machine',
     'bb222222-2222-2222-2222-222222222222', 'photo',
     '22222222-2222-2222-2222-222222222222/bb222222-2222-2222-2222-222222222222/p.jpg');

-- (a) same-farm primary reference is accepted.
update machines set primary_attachment_id = 'a7100000-0000-0000-0000-0000000000a1'
  where id = 'aa111111-1111-1111-1111-111111111111';
do $$ begin
  if not exists (select 1 from machines
      where id = 'aa111111-1111-1111-1111-111111111111'
        and primary_attachment_id = 'a7100000-0000-0000-0000-0000000000a1') then
    raise exception 'F10 FAIL: same-farm primary_attachment_id was not set';
  end if;
end $$;

-- (b) cross-farm primary reference is REJECTED by the composite FK (no tenant leak).
do $$
begin
  begin
    update machines set primary_attachment_id = 'b7200000-0000-0000-0000-0000000000b1'
      where id = 'aa111111-1111-1111-1111-111111111111';
    raise exception 'F10 FAIL: Farm A machine accepted Farm B''s attachment as primary (tenant leak!)';
  exception when foreign_key_violation then
    null; -- expected: the (attachment_id, farm_id) pair does not exist in Farm A
  end;
end $$;

-- (c) the new capture columns are farm-scoped: Owner B cannot see Farm A's values.
update machines set cost_centre = 'CC-A', department = 'Werkswinkel'
  where id = 'aa111111-1111-1111-1111-111111111111';
select _t_login('b2222222-2222-2222-2222-222222222222');   -- Owner B
set role authenticated;
do $$ begin
  if exists (select 1 from machines where cost_centre = 'CC-A' or department = 'Werkswinkel') then
    raise exception 'F10 FAIL: Owner B can see Farm A cost_centre/department (tenant leak!)';
  end if;
end $$;
reset role;

select 'ALL F10 VEHICLE-CAPTURE TESTS PASSED' as result;
-- ═════════════════════════════════════════════════════════════════
-- ═══ F9: SERVICE KITS & PARTS CATALOGUE (0270–0271, appended) ════
-- Proves:
--   (a) parts_catalogue visibility mirrors service_templates: own-farm rows + GLOBAL
--       (farm_id null) rows are visible; other farms' rows never are.
--   (b) service_kits / service_kit_items are farm-isolated (own-farm only; cross-tenant
--       write rejected; anon sees nothing and cannot write).
--   (c) the scope check rejects a kit with neither a machine nor a machine_type.
--   (d) NO DOUBLE-COUNT: a kit/kit-item creates ZERO cost_entries by itself; applying a
--       kit (== inserting job_card_lines) books exactly one cost_entry per line via the
--       existing 0211 trigger.
-- Fresh fixtures reuse the base Farm A / Farm B machines; nothing above is modified.
-- ═════════════════════════════════════════════════════════════════

-- ── Fixtures (superuser; RLS bypassed) ────────────────────────────
insert into parts_catalogue (id, farm_id, part_no, description, typical_cost_cents) values
  ('9a000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'OIL-15W40', 'Engine oil 15W40 20L', 120000),
  ('9a000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'OIL-15W40', 'Engine oil 15W40 20L', 120000),
  ('9a000000-0000-0000-0000-0000000000f0', null,                                   'FILT-GLOBAL', 'Global oil filter',  15000);

insert into service_kits (id, farm_id, machine_id, name) values
  ('9c000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', '250h service kit'),
  ('9c000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', '250h service kit');

insert into service_kit_items (id, farm_id, service_kit_id, part_catalogue_id, part_no, description, qty, unit_cost_cents) values
  ('9d000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', '9c000000-0000-0000-0000-0000000000a1', '9a000000-0000-0000-0000-0000000000a1', 'OIL-15W40',   'Engine oil', 2, 120000),
  ('9d000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', '9c000000-0000-0000-0000-0000000000a1', '9a000000-0000-0000-0000-0000000000f0', 'FILT-GLOBAL', 'Oil filter', 1,  15000),
  ('9d000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', '9c000000-0000-0000-0000-0000000000b1', null,                                    'OIL-15W40',   'Engine oil', 2, 120000);

-- ── (a) parts_catalogue: own-farm + GLOBAL visible; other farms hidden ──
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  perform _t_assert('parts_catalogue', 2, 'ownerA');          -- Farm A + GLOBAL
  execute $q$ select count(*) from parts_catalogue where farm_id = '22222222-2222-2222-2222-222222222222' $q$ into c;
  if c <> 0 then raise exception 'PARTS ISOLATION FAIL [ownerA]: sees % Farm B parts', c; end if;
end $$;
do $$ begin perform _t_login('b2222222-2222-2222-2222-222222222222'); perform _t_assert('parts_catalogue', 2, 'ownerB');    end $$;  -- Farm B + GLOBAL
do $$ begin perform _t_login('c3333333-3333-3333-3333-333333333333'); perform _t_assert('parts_catalogue', 2, 'workshopW'); end $$;  -- Farm A + GLOBAL
do $$ begin perform _t_login('d4444444-4444-4444-4444-444444444444'); perform _t_assert('parts_catalogue', 3, 'rrAdmin');   end $$;  -- A + B + GLOBAL
reset role;

-- ── (b) service_kits / service_kit_items farm isolation ───────────
set role authenticated;
do $$ begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  perform _t_assert('service_kits',      1, 'ownerA');
  perform _t_assert('service_kit_items', 2, 'ownerA');
end $$;
do $$ begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');   -- Owner B
  perform _t_assert('service_kits',      1, 'ownerB');
  perform _t_assert('service_kit_items', 1, 'ownerB');
end $$;
do $$ begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');   -- Workshop W (linked to A)
  perform _t_assert('service_kits',      1, 'workshopW');
  perform _t_assert('service_kit_items', 2, 'workshopW');
end $$;
do $$ begin
  perform _t_login('d4444444-4444-4444-4444-444444444444');   -- RR Admin
  perform _t_assert('service_kits',      2, 'rrAdmin');
  perform _t_assert('service_kit_items', 3, 'rrAdmin');
end $$;
reset role;

-- ── (b) cross-tenant WRITE denials (Owner A → Farm B) ─────────────
set role authenticated;
do $$ declare ok boolean; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  -- a per-farm part into Farm B
  ok := false;
  begin insert into parts_catalogue (farm_id, part_no) values ('22222222-2222-2222-2222-222222222222', 'HACK'); exception when others then ok := true; end;
  if not ok then raise exception 'PARTS ISOLATION FAIL [ownerA]: wrote a Farm B part'; end if;
  -- a kit onto a Farm B machine
  ok := false;
  begin insert into service_kits (farm_id, machine_id, name) values ('22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 'hack'); exception when others then ok := true; end;
  if not ok then raise exception 'KIT ISOLATION FAIL [ownerA]: wrote a Farm B kit'; end if;
  -- a kit item into Farm B's kit
  ok := false;
  begin insert into service_kit_items (farm_id, service_kit_id, part_no) values ('22222222-2222-2222-2222-222222222222', '9c000000-0000-0000-0000-0000000000b1', 'HACK'); exception when others then ok := true; end;
  if not ok then raise exception 'KIT ITEM ISOLATION FAIL [ownerA]: wrote into Farm B kit'; end if;
end $$;
reset role;

-- ── (b) anon sees nothing and cannot write the new tables ─────────
set role anon;
do $$ declare t text; c bigint; begin
  perform set_config('request.jwt.claims', '', false);
  foreach t in array array['parts_catalogue','service_kits','service_kit_items'] loop
    begin execute format('select count(*) from public.%I', t) into c;
    exception when insufficient_privilege then c := 0; end;
    if c <> 0 then raise exception 'F9 ISOLATION FAIL [anon]: sees % rows in %', c, t; end if;
  end loop;
  begin
    insert into parts_catalogue (farm_id, part_no) values ('11111111-1111-1111-1111-111111111111', 'anon-hack');
    raise exception 'F9 ISOLATION FAIL [anon]: inserted a part';
  exception
    when insufficient_privilege then null;                    -- expected
    when others then if sqlstate = 'P0001' then raise; end if;
  end;
end $$;
reset role;

-- ── (c) scope check: a kit needs a machine OR a machine_type ───────
do $$ declare ok boolean := false; begin
  begin insert into service_kits (farm_id, name) values ('11111111-1111-1111-1111-111111111111', 'scopeless'); exception when check_violation then ok := true; end;
  if not ok then raise exception 'KIT SCOPE FAIL: a kit with neither machine nor machine_type was accepted'; end if;
end $$;

-- ── (d) NO DOUBLE-COUNT: kit/items book no cost; applying a kit (== job_card_lines) books once ──
-- Kit items themselves never create cost_entries (there is no kit→cost path).
do $$ declare c bigint; begin
  execute $q$ select count(*) from cost_entries where source_type like 'service_kit%' $q$ into c;
  if c <> 0 then raise exception 'F9 DOUBLE-COUNT FAIL: % cost_entries were booked directly from kit items', c; end if;
end $$;

-- Apply a kit to a fresh (unlocked) Farm A job card: the OIL line (qty 2 × R1200 =
-- R2400 ex-VAT) must produce exactly one cost_entry via the 0211 job_card_lines trigger.
insert into job_cards (id, farm_id, machine_id, type, status) values
  ('9e000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 'scheduled_service', 'open');
insert into job_card_lines (id, farm_id, job_card_id, kind, part_no, description, qty, unit_cost_cents) values
  ('9f000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', '9e000000-0000-0000-0000-0000000000a1', 'part', 'OIL-15W40', 'Engine oil', 2, 120000);
do $$ declare c bigint; amt bigint; begin
  select count(*), coalesce(max(amount_cents), 0) into c, amt
    from cost_entries where source_type = 'job_card_line' and source_id = '9f000000-0000-0000-0000-0000000000a1' and deleted_at is null;
  if c <> 1 then raise exception 'F9 DOUBLE-COUNT FAIL: applied kit line produced % cost_entries (expected 1)', c; end if;
  if amt <> 240000 then raise exception 'F9 COST FAIL: applied kit line cost = % (expected 240000)', amt; end if;
end $$;

select 'ALL F9 SERVICE-KITS & PARTS-CATALOGUE TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- ═══ F12a: CONTRACTOR SPINE & PARTNERS DIRECTORY (0300–0301) ═════
-- ═════════════════════════════════════════════════════════════════
-- `partners` tenancy mirrors service_templates/parts_catalogue:
--   (a) GLOBAL suggested rows (farm_id null, is_suggested true) are visible to ALL
--       authenticated users; farm-owned rows only via app.has_farm_access — INCLUDING
--       the linked workshop, which proves the contractor spine still isolates by farm;
--   (b) cross-tenant writes are rejected;
--   (c) mutation is restricted to the owning farm's owner/manager (an operator is denied);
--   (d) anon sees nothing and cannot write;
--   (e) the (farm_id IS NULL) = is_suggested invariant is enforced by a check constraint.

-- An extra Farm A operator, to prove partner mutation is owner/manager-only.
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-0000000000a9', 'operatorA@test');
insert into users (id, farm_id, workshop_id, role, name) values
  ('a0000000-0000-0000-0000-0000000000a9', '11111111-1111-1111-1111-111111111111', null, 'operator', 'Operator A');

-- Seed: one GLOBAL suggested, one Farm A partner, one Farm B partner (superuser → RLS off).
insert into partners (id, farm_id, is_suggested, name, kind, created_by) values
  ('c0000000-0000-0000-0000-000000000001', null,                                     true,  'Global Parts Co', 'parts_supplier', null),
  ('ca000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111',   false, 'Farm A Mechanic', 'mechanic',       'a1111111-1111-1111-1111-111111111111'),
  ('cb000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222',   false, 'Farm B Mechanic', 'mechanic',       'b2222222-2222-2222-2222-222222222222');

-- ── (a) visibility: own-farm + GLOBAL; other farms hidden; workshop link holds ──
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');       -- Owner A
  perform _t_assert('partners', 2, 'ownerA');                      -- Farm A + GLOBAL
  execute $q$ select count(*) from partners where farm_id = '22222222-2222-2222-2222-222222222222' $q$ into c;
  if c <> 0 then raise exception 'PARTNERS ISOLATION FAIL [ownerA]: sees % Farm B partners', c; end if;
end $$;
do $$ begin perform _t_login('b2222222-2222-2222-2222-222222222222'); perform _t_assert('partners', 2, 'ownerB');    end $$;  -- Farm B + GLOBAL
do $$ begin perform _t_login('c3333333-3333-3333-3333-333333333333'); perform _t_assert('partners', 2, 'workshopW'); end $$;  -- Farm A + GLOBAL (link holds)
do $$ begin perform _t_login('d4444444-4444-4444-4444-444444444444'); perform _t_assert('partners', 3, 'rrAdmin');   end $$;  -- A + B + GLOBAL

-- ── (b) cross-tenant write denied (Owner A → a Farm B partner) ────
do $$ declare ok boolean := false; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  begin insert into partners (farm_id, is_suggested, name) values ('22222222-2222-2222-2222-222222222222', false, 'HACK');
  exception when others then ok := true; end;
  if not ok then raise exception 'PARTNERS ISOLATION FAIL [ownerA]: wrote a Farm B partner'; end if;
end $$;

-- ── (c) role gating: an operator cannot write even its OWN farm's partner ──
do $$ declare ok boolean := false; begin
  perform _t_login('a0000000-0000-0000-0000-0000000000a9');       -- Operator A
  begin insert into partners (farm_id, is_suggested, name) values ('11111111-1111-1111-1111-111111111111', false, 'op-hack');
  exception when others then ok := true; end;
  if not ok then raise exception 'PARTNERS ROLE FAIL [operatorA]: operator wrote a partner'; end if;
end $$;
reset role;

-- ── (d) anon sees nothing and cannot write ────────────────────────
set role anon;
do $$ declare c bigint; begin
  perform set_config('request.jwt.claims', '', false);
  begin execute 'select count(*) from public.partners' into c;
  exception when insufficient_privilege then c := 0; end;
  if c <> 0 then raise exception 'F12a ISOLATION FAIL [anon]: sees % partners', c; end if;
  begin
    insert into partners (farm_id, is_suggested, name) values (null, true, 'anon-hack');
    raise exception 'F12a ISOLATION FAIL [anon]: inserted a partner';
  exception
    when insufficient_privilege then null;                        -- expected
    when others then if sqlstate = 'P0001' then raise; end if;
  end;
end $$;
reset role;

-- ── (e) scope invariant: (farm_id IS NULL) = is_suggested (check constraint) ──
do $$ declare ok1 boolean := false; ok2 boolean := false; begin
  begin insert into partners (farm_id, is_suggested, name) values (null, false, 'bad-global');
  exception when check_violation then ok1 := true; end;
  if not ok1 then raise exception 'PARTNERS SCOPE FAIL: farm_id NULL with is_suggested=false accepted'; end if;
  begin insert into partners (farm_id, is_suggested, name) values ('11111111-1111-1111-1111-111111111111', true, 'bad-farm');
  exception when check_violation then ok2 := true; end;
  if not ok2 then raise exception 'PARTNERS SCOPE FAIL: farm-owned row with is_suggested=true accepted'; end if;
end $$;

-- ── (f) owner CAN add a partner to its own farm (positive path) ───
set role authenticated;
do $$ begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  insert into partners (farm_id, is_suggested, name, kind) values ('11111111-1111-1111-1111-111111111111', false, 'Owner-added', 'tyre');
end $$;
reset role;

select 'ALL F12a CONTRACTOR-SPINE & PARTNERS TESTS PASSED' as result;

-- ═══ F11: VEHICLE CHECKLISTS + TEMPLATE BUILDER (0290, appended) ══
-- Proves:
--   (a) checklist_templates + checklist_template_fields visibility mirrors
--       service_templates: own-farm rows + GLOBAL (farm_id null) rows are visible;
--       other farms' rows never are.
--   (b) checklist_instances / checklist_instance_values are farm-isolated (own-farm
--       only; cross-tenant write rejected; anon sees nothing and cannot write).
--   (c) composite-FK isolation: a farm field can't attach to another farm's template,
--       and an instance value can't cite another farm's photo attachment.
-- Fresh fixtures reuse the base Farm A / Farm B machines; nothing above is modified.
-- ═════════════════════════════════════════════════════════════════

-- ── Fixtures (superuser; RLS bypassed) ────────────────────────────
insert into checklist_templates (id, farm_id, machine_type, name) values
  ('ca000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'tractor', 'Farm A pre-use inspection'),
  ('ca000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'tractor', 'Farm B pre-use inspection'),
  ('ca000000-0000-0000-0000-0000000000f0', null,                                   'tractor', 'GLOBAL daily inspection');

insert into checklist_template_fields (id, template_id, farm_id, sort_order, field_type, label, required) values
  ('cb000000-0000-0000-0000-0000000000a1', 'ca000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 0, 'checkbox', 'Oil level OK',   true),
  ('cb000000-0000-0000-0000-0000000000a2', 'ca000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 1, 'photo',    'Damage photo',   false),
  ('cb000000-0000-0000-0000-0000000000b1', 'ca000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 0, 'text',     'Notes',          false),
  ('cb000000-0000-0000-0000-0000000000f0', 'ca000000-0000-0000-0000-0000000000f0', null,                                   0, 'rating',   'Overall condition', false);

insert into checklist_instances (id, farm_id, machine_id, template_id, template_name, status) values
  ('cc000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 'ca000000-0000-0000-0000-0000000000a1', 'Farm A pre-use inspection', 'completed'),
  ('cc000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 'ca000000-0000-0000-0000-0000000000b1', 'Farm B pre-use inspection', 'completed');

-- Per-farm checklist photo attachments (kind=photo, parent=checklist_instance).
insert into attachments (id, farm_id, parent_type, parent_id, kind, storage_path) values
  ('ce000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'checklist_instance', 'cc000000-0000-0000-0000-0000000000a1', 'photo', '11111111-1111-1111-1111-111111111111/cc000000-0000-0000-0000-0000000000a1/p.jpg'),
  ('ce000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'checklist_instance', 'cc000000-0000-0000-0000-0000000000b1', 'photo', '22222222-2222-2222-2222-222222222222/cc000000-0000-0000-0000-0000000000b1/p.jpg');

insert into checklist_instance_values (id, farm_id, instance_id, template_field_id, sort_order, field_type, label, value_text, attachment_id) values
  ('cd000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'cc000000-0000-0000-0000-0000000000a1', 'cb000000-0000-0000-0000-0000000000a1', 0, 'checkbox', 'Oil level OK', 'true', null),
  ('cd000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'cc000000-0000-0000-0000-0000000000a1', 'cb000000-0000-0000-0000-0000000000a2', 1, 'photo',    'Damage photo', null,   'ce000000-0000-0000-0000-0000000000a1'),
  ('cd000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'cc000000-0000-0000-0000-0000000000b1', 'cb000000-0000-0000-0000-0000000000b1', 0, 'text',     'Notes',        'B note', null);

-- ── (a) templates + fields: own-farm + GLOBAL visible; other farms hidden ──
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  perform _t_assert('checklist_templates',       2, 'ownerA'); -- Farm A + GLOBAL
  perform _t_assert('checklist_template_fields', 3, 'ownerA'); -- 2 Farm A fields + 1 GLOBAL
  execute $q$ select count(*) from checklist_templates where farm_id = '22222222-2222-2222-2222-222222222222' $q$ into c;
  if c <> 0 then raise exception 'CHECKLIST ISOLATION FAIL [ownerA]: sees % Farm B templates', c; end if;
end $$;
do $$ begin perform _t_login('b2222222-2222-2222-2222-222222222222'); perform _t_assert('checklist_templates', 2, 'ownerB'); perform _t_assert('checklist_template_fields', 2, 'ownerB'); end $$;  -- Farm B + GLOBAL
do $$ begin perform _t_login('c3333333-3333-3333-3333-333333333333'); perform _t_assert('checklist_templates', 2, 'workshopW'); perform _t_assert('checklist_template_fields', 3, 'workshopW'); end $$;  -- Farm A + GLOBAL
do $$ begin perform _t_login('d4444444-4444-4444-4444-444444444444'); perform _t_assert('checklist_templates', 3, 'rrAdmin'); perform _t_assert('checklist_template_fields', 4, 'rrAdmin'); end $$;  -- A + B + GLOBAL
reset role;

-- ── (b) instances / values farm isolation ─────────────────────────
set role authenticated;
do $$ begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  perform _t_assert('checklist_instances',       1, 'ownerA');
  perform _t_assert('checklist_instance_values', 2, 'ownerA');
end $$;
do $$ begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');   -- Owner B
  perform _t_assert('checklist_instances',       1, 'ownerB');
  perform _t_assert('checklist_instance_values', 1, 'ownerB');
end $$;
do $$ begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');   -- Workshop W (linked to A)
  perform _t_assert('checklist_instances',       1, 'workshopW');
  perform _t_assert('checklist_instance_values', 2, 'workshopW');
end $$;
do $$ begin
  perform _t_login('d4444444-4444-4444-4444-444444444444');   -- RR Admin
  perform _t_assert('checklist_instances',       2, 'rrAdmin');
  perform _t_assert('checklist_instance_values', 3, 'rrAdmin');
end $$;
reset role;

-- ── (b/c) cross-tenant WRITE + composite-FK denials (Owner A → Farm B) ──
set role authenticated;
do $$ declare ok boolean; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  -- a GLOBAL template (only RR admin may) — farm_id null fails the ins check
  ok := false;
  begin insert into checklist_templates (farm_id, name) values (null, 'HACK GLOBAL'); exception when others then ok := true; end;
  if not ok then raise exception 'CHECKLIST ISOLATION FAIL [ownerA]: wrote a GLOBAL template'; end if;
  -- a farm template into Farm B
  ok := false;
  begin insert into checklist_templates (farm_id, name) values ('22222222-2222-2222-2222-222222222222', 'HACK'); exception when others then ok := true; end;
  if not ok then raise exception 'CHECKLIST ISOLATION FAIL [ownerA]: wrote a Farm B template'; end if;
  -- a field tagged Farm A but pointing at Farm B's template → composite FK rejects
  ok := false;
  begin insert into checklist_template_fields (template_id, farm_id, sort_order, field_type, label)
        values ('ca000000-0000-0000-0000-0000000000b1', '11111111-1111-1111-1111-111111111111', 0, 'text', 'HACK'); exception when others then ok := true; end;
  if not ok then raise exception 'CHECKLIST ISOLATION FAIL [ownerA]: attached a field to Farm B''s template'; end if;
  -- an instance onto a Farm B machine
  ok := false;
  begin insert into checklist_instances (farm_id, machine_id, template_name) values ('22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 'hack'); exception when others then ok := true; end;
  if not ok then raise exception 'CHECKLIST ISOLATION FAIL [ownerA]: wrote a Farm B instance'; end if;
  -- a value into Farm B's instance
  ok := false;
  begin insert into checklist_instance_values (farm_id, instance_id, sort_order, field_type, label) values ('22222222-2222-2222-2222-222222222222', 'cc000000-0000-0000-0000-0000000000b1', 0, 'text', 'HACK'); exception when others then ok := true; end;
  if not ok then raise exception 'CHECKLIST ISOLATION FAIL [ownerA]: wrote into Farm B instance'; end if;
  -- a Farm A value citing Farm B's photo attachment → composite FK rejects
  ok := false;
  begin insert into checklist_instance_values (farm_id, instance_id, sort_order, field_type, label, attachment_id)
        values ('11111111-1111-1111-1111-111111111111', 'cc000000-0000-0000-0000-0000000000a1', 5, 'photo', 'HACK', 'ce000000-0000-0000-0000-0000000000b1'); exception when others then ok := true; end;
  if not ok then raise exception 'CHECKLIST ISOLATION FAIL [ownerA]: cited Farm B''s photo attachment'; end if;
end $$;
reset role;

-- ── (b) anon sees nothing and cannot write the new tables ─────────
set role anon;
do $$ declare t text; c bigint; begin
  perform set_config('request.jwt.claims', '', false);
  foreach t in array array['checklist_templates','checklist_template_fields','checklist_instances','checklist_instance_values'] loop
    begin execute format('select count(*) from public.%I', t) into c;
    exception when insufficient_privilege then c := 0; end;
    if c <> 0 then raise exception 'F11 ISOLATION FAIL [anon]: sees % rows in %', c, t; end if;
  end loop;
  begin
    insert into checklist_templates (farm_id, name) values ('11111111-1111-1111-1111-111111111111', 'anon-hack');
    raise exception 'F11 ISOLATION FAIL [anon]: inserted a template';
  exception
    when insufficient_privilege then null;                    -- expected
    when others then if sqlstate = 'P0001' then raise; end if;
  end;
end $$;
reset role;

select 'ALL F11 CHECKLIST TESTS PASSED' as result;

-- ═══ F12b: WORK-REQUEST FLOW (0310–0311, appended section) ═══════
-- ═════════════════════════════════════════════════════════════════
-- Proves for work_requests + work_request_events:
--   (a) farm isolation — each farm sees only its own requests;
--   (b) the LINKED WORKSHOP sees AND can update its assigned farm's requests
--       (app.has_farm_access resolves the workshop_link) but never another farm's;
--   (c) cross-tenant writes are rejected;
--   (d) anon sees nothing and cannot write;
--   (e) INVOICE → COST with NO DOUBLE-COUNT: the invoice amount books exactly one
--       `invoice` cost_entry keyed (source_type='work_request', source_id), re-edits
--       update it in place, clearing it soft-deletes it, and a QUOTE never costs;
--   (f) a status change notifies the assigned farm's owner/manager (notify trigger).
-- Fresh fixtures (distinct ids) so earlier counts are undisturbed.

-- Seed as superuser (RLS bypassed): one Farm A request assigned to Workshop W (linked
-- to Farm A), one Farm B request. Opening events for each.
insert into work_requests (id, farm_id, machine_id, workshop_id, kind, status, priority, title, description, created_by) values
  ('d1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'repair', 'requested', 'high', 'A hydraulic leak', 'Fix the leak', 'a1111111-1111-1111-1111-111111111111'),
  ('d2000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', null,                                     'quote',  'requested', 'normal', 'B service quote', 'Quote a 250h service', 'b2222222-2222-2222-2222-222222222222');
insert into work_request_events (farm_id, work_request_id, from_status, to_status, note, by_user) values
  ('11111111-1111-1111-1111-111111111111', 'd1000000-0000-0000-0000-0000000000a1', null, 'requested', 'created', 'a1111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222', 'd2000000-0000-0000-0000-0000000000b1', null, 'requested', 'created', 'b2222222-2222-2222-2222-222222222222');

-- ── (a) farm isolation + (b) linked-workshop visibility ───────────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');       -- Owner A
  perform _t_assert('work_requests', 1, 'ownerA');
  perform _t_assert('work_request_events', 1, 'ownerA');
  execute $q$ select count(*) from work_requests where farm_id = '22222222-2222-2222-2222-222222222222' $q$ into c;
  if c <> 0 then raise exception 'WORK-REQ ISOLATION FAIL [ownerA]: sees % Farm B requests', c; end if;
end $$;
do $$ begin perform _t_login('b2222222-2222-2222-2222-222222222222'); perform _t_assert('work_requests', 1, 'ownerB'); perform _t_assert('work_request_events', 1, 'ownerB'); end $$;
do $$ begin perform _t_login('c3333333-3333-3333-3333-333333333333'); perform _t_assert('work_requests', 1, 'workshopW'); perform _t_assert('work_request_events', 1, 'workshopW'); end $$;  -- linked to Farm A
do $$ begin perform _t_login('d4444444-4444-4444-4444-444444444444'); perform _t_assert('work_requests', 2, 'rrAdmin');   perform _t_assert('work_request_events', 2, 'rrAdmin');   end $$;

-- ── (b) linked workshop UPDATES its assigned farm's request, and can NOT
--        touch another farm's — both under the workshopW login ──
do $$ declare st work_request_status; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');        -- Workshop W (linked to Farm A only)
  update work_requests set status = 'viewed', updated_at = now() where id = 'd1000000-0000-0000-0000-0000000000a1';
  select status into st from work_requests where id = 'd1000000-0000-0000-0000-0000000000a1';
  if st <> 'viewed' then raise exception 'WORK-REQ FAIL [workshopW]: could not advance its assigned request (status=%)', st; end if;
  update work_requests set status = 'closed' where id = 'd2000000-0000-0000-0000-0000000000b1';  -- RLS filters → 0 rows
end $$;
reset role;

-- Read back unfiltered (superuser): Farm B untouched; (f) the status-change notify
-- trigger queued at least one owner/manager alert on Farm A.
do $$ declare st work_request_status; c bigint; begin
  select status into st from work_requests where id = 'd2000000-0000-0000-0000-0000000000b1';
  if st <> 'requested' then raise exception 'WORK-REQ ISOLATION FAIL [workshopW]: mutated a Farm B request (status=%)', st; end if;
  select count(*) into c from notifications
    where farm_id = '11111111-1111-1111-1111-111111111111' and template = 'work_request_status';
  if c < 1 then raise exception 'WORK-REQ NOTIFY FAIL: status change queued % notifications', c; end if;
end $$;

-- ── (c) cross-tenant write denied (Owner A → a Farm B request) ────
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  begin
    insert into work_requests (farm_id, machine_id, kind) values ('22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 'repair');
  exception when others then ok := true; end;
  if not ok then raise exception 'WORK-REQ ISOLATION FAIL [ownerA]: wrote a Farm B request'; end if;
end $$;
reset role;

-- ── (d) anon sees nothing and cannot write ────────────────────────
set role anon;
do $$ declare t text; c bigint; begin
  perform set_config('request.jwt.claims', '', false);
  foreach t in array array['work_requests','work_request_events'] loop
    begin execute format('select count(*) from public.%I', t) into c;
    exception when insufficient_privilege then c := 0; end;
    if c <> 0 then raise exception 'F12b ISOLATION FAIL [anon]: sees % rows in %', c, t; end if;
  end loop;
  begin
    insert into work_requests (farm_id, machine_id, kind) values ('11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 'repair');
    raise exception 'F12b ISOLATION FAIL [anon]: inserted a request';
  exception
    when insufficient_privilege then null;                          -- expected
    when others then if sqlstate = 'P0001' then raise; end if;
  end;
end $$;
reset role;

-- ── (e) INVOICE → COST, NO DOUBLE-COUNT (the F1 invoice→TCO path) ──
-- Booking an invoice amount produces exactly ONE cost_entry; re-editing updates it in
-- place; clearing it soft-deletes it; a quote never costs. Mutate as superuser (RLS
-- bypassed) so the assertion is about the sync trigger alone.
do $$ declare c bigint; amt bigint; begin
  update work_requests set invoice_amount_cents = 100000, vat_rate_bps = 1500 where id = 'd1000000-0000-0000-0000-0000000000a1';
  select count(*), coalesce(max(amount_cents), 0) into c, amt
    from cost_entries where source_type = 'work_request' and source_id = 'd1000000-0000-0000-0000-0000000000a1' and deleted_at is null;
  if c <> 1 then raise exception 'F12b DOUBLE-COUNT FAIL: invoice booked % cost_entries (expected 1)', c; end if;
  if amt <> 100000 then raise exception 'F12b COST FAIL: invoice cost = % (expected 100000)', amt; end if;

  -- Re-edit the amount: still exactly one row, updated in place (no duplicate).
  update work_requests set invoice_amount_cents = 150000 where id = 'd1000000-0000-0000-0000-0000000000a1';
  select count(*), coalesce(max(amount_cents), 0) into c, amt
    from cost_entries where source_type = 'work_request' and source_id = 'd1000000-0000-0000-0000-0000000000a1' and deleted_at is null;
  if c <> 1 then raise exception 'F12b DOUBLE-COUNT FAIL: re-edit produced % live cost_entries (expected 1)', c; end if;
  if amt <> 150000 then raise exception 'F12b COST FAIL: re-edited cost = % (expected 150000)', amt; end if;

  -- Clearing the amount soft-deletes the entry (no live cost row remains).
  update work_requests set invoice_amount_cents = null where id = 'd1000000-0000-0000-0000-0000000000a1';
  select count(*) into c
    from cost_entries where source_type = 'work_request' and source_id = 'd1000000-0000-0000-0000-0000000000a1' and deleted_at is null;
  if c <> 0 then raise exception 'F12b FAIL: clearing the invoice left % live cost_entries', c; end if;

  -- A QUOTE is recorded but never creates a cost_entry.
  update work_requests set quote_amount_cents = 90000 where id = 'd2000000-0000-0000-0000-0000000000b1';
  select count(*) into c from cost_entries where source_type = 'work_request' and source_id = 'd2000000-0000-0000-0000-0000000000b1';
  if c <> 0 then raise exception 'F12b DOUBLE-COUNT FAIL: a quote booked % cost_entries (expected 0)', c; end if;
end $$;

select 'ALL F12b WORK-REQUEST-FLOW TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- ═══ F12c: CONTRACTOR AGGREGATED DASHBOARD (0320, appended) ══════
-- ═════════════════════════════════════════════════════════════════
-- The contractor dashboard (/contractor) shows EVERY work_request assigned to the
-- signed-in contractor's OWN workshop, across ALL the farms that workshop is linked to,
-- in ONE view. Its query is RLS(app.has_farm_access → linked farms) AND an explicit
-- `workshop_id = <my workshop>` filter. This section proves that combination is airtight:
--   (a) AGGREGATION — a workshop linked to TWO farms sees its requests from BOTH in the
--       one dashboard query;
--   (b) OWN-WORKSHOP ONLY — on a farm shared by two contractors, RLS alone is farm-scoped
--       (so W can SEE X's request row), but the dashboard's workshop_id filter excludes
--       another workshop's request — the app filter is load-bearing and is asserted;
--   (c) NEVER AN UNLINKED FARM — a request assigned to W but on a farm W is NOT linked to
--       stays invisible (RLS dominates the assignment); a workshop cannot update it;
--   (d) the `workshops.plan` gating column reads back with its default.
-- Fresh fixtures (Farm E, Workshop X, distinct request ids) leave earlier counts intact.

-- Farm E + a machine on it; a SECOND workshop X (plan 'pro'); X's staff user. Link W to
-- Farm E (so W is linked to Farm A AND Farm E) and link X to Farm A (shared with W).
insert into farms (id, name) values
  ('e1000000-0000-0000-0000-0000000000e1', 'Farm E');
insert into machines (id, farm_id, name, type) values
  ('ee100000-0000-0000-0000-0000000000e1', 'e1000000-0000-0000-0000-0000000000e1', 'Machine E1', 'tractor');
insert into workshops (id, name, kind, plan) values
  ('e3000000-0000-0000-0000-0000000000e3', 'Workshop X', 'parts_supplier', 'pro');
insert into workshop_links (workshop_id, farm_id, status) values
  ('33333333-3333-3333-3333-333333333333', 'e1000000-0000-0000-0000-0000000000e1', 'active'),  -- W → Farm E
  ('e3000000-0000-0000-0000-0000000000e3', '11111111-1111-1111-1111-111111111111', 'active');  -- X → Farm A
insert into auth.users (id, email) values
  ('e4000000-0000-0000-0000-0000000000e4', 'workshopX@test');
insert into users (id, farm_id, workshop_id, role, name) values
  ('e4000000-0000-0000-0000-0000000000e4', null, 'e3000000-0000-0000-0000-0000000000e3', 'workshop', 'Workshop X Staff');

-- Requests: one for W on Farm E (aggregation), one for X on the SHARED Farm A (own-only),
-- and one for W on Farm B — a farm W is NOT linked to (unlinked-farm isolation).
insert into work_requests (id, farm_id, machine_id, workshop_id, kind, status, priority, title, created_by) values
  ('d3000000-0000-0000-0000-0000000000e1', 'e1000000-0000-0000-0000-0000000000e1', 'ee100000-0000-0000-0000-0000000000e1', '33333333-3333-3333-3333-333333333333', 'repair', 'requested', 'normal', 'E tractor service', null),
  ('d4000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 'e3000000-0000-0000-0000-0000000000e3', 'parts',  'requested', 'normal', 'A parts order',     'a1111111-1111-1111-1111-111111111111'),
  ('d5000000-0000-0000-0000-0000000000b2', '22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'repair', 'requested', 'normal', 'B (unlinked)',      'b2222222-2222-2222-2222-222222222222');

-- ── (a) aggregation + (b) own-workshop-only + (c) unlinked-farm isolation ──
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');          -- Workshop W (linked to Farm A + Farm E)

  -- (a) The DASHBOARD query: own workshop across ALL linked farms → Farm A (d1..a1) +
  --     Farm E (d3..e1) = 2. The unlinked Farm B request (d5..b2) is NOT counted.
  execute $q$ select count(*) from work_requests where workshop_id = '33333333-3333-3333-3333-333333333333' and deleted_at is null $q$ into c;
  if c <> 2 then raise exception 'F12c FAIL [W dashboard]: aggregated own-workshop count=% (expected 2)', c; end if;

  -- (b) RLS alone is FARM-scoped, not workshop-scoped: on the shared Farm A, W can SEE
  --     X's request row — so the app-side workshop_id filter is what excludes it.
  execute $q$ select count(*) from work_requests where workshop_id = 'e3000000-0000-0000-0000-0000000000e3' $q$ into c;
  if c <> 1 then raise exception 'F12c FAIL [W sees shared farm]: X-request visibility=% (expected 1)', c; end if;

  -- Total RLS-visible to W = Farm A (d1..a1 W + d4..a2 X) + Farm E (d3..e1 W) = 3; the
  -- dashboard (2) is thus a strict subset, differing only by X's request.
  execute $q$ select count(*) from work_requests $q$ into c;
  if c <> 3 then raise exception 'F12c FAIL [W total visible]: %=(expected 3)', c; end if;

  -- (c) An unlinked farm's rows stay invisible even when a request is assigned to W.
  execute $q$ select count(*) from work_requests where farm_id = '22222222-2222-2222-2222-222222222222' $q$ into c;
  if c <> 0 then raise exception 'F12c FAIL [W unlinked farm]: sees % Farm B requests (expected 0)', c; end if;
end $$;

-- Workshop X: its dashboard shows only its own (Farm A parts order); it sees W's shared
-- Farm A request via RLS but never W's Farm E work (X is not linked to Farm E).
do $$ declare c bigint; begin
  perform _t_login('e4000000-0000-0000-0000-0000000000e4');          -- Workshop X (linked to Farm A only)
  execute $q$ select count(*) from work_requests where workshop_id = 'e3000000-0000-0000-0000-0000000000e3' and deleted_at is null $q$ into c;
  if c <> 1 then raise exception 'F12c FAIL [X dashboard]: own-workshop count=% (expected 1)', c; end if;
  execute $q$ select count(*) from work_requests where farm_id = 'e1000000-0000-0000-0000-0000000000e1' $q$ into c;
  if c <> 0 then raise exception 'F12c FAIL [X unlinked farm]: sees % Farm E requests (expected 0)', c; end if;
end $$;

-- (c) A workshop cannot UPDATE a request on a farm it is not linked to (RLS write guard).
do $$ declare st work_request_status; begin
  perform _t_login('e4000000-0000-0000-0000-0000000000e4');          -- Workshop X (NOT linked to Farm E)
  update work_requests set status = 'closed' where id = 'd3000000-0000-0000-0000-0000000000e1';  -- RLS → 0 rows
  perform _t_login('c3333333-3333-3333-3333-333333333333');
  select status into st from work_requests where id = 'd3000000-0000-0000-0000-0000000000e1';
  if st <> 'requested' then raise exception 'F12c ISOLATION FAIL [X]: mutated a Farm E request (status=%)', st; end if;
end $$;
reset role;

-- ── (d) the contractor-plan gating column reads back with its default ──
do $$ declare p workshop_plan; begin
  select plan into p from workshops where id = '33333333-3333-3333-3333-333333333333';  -- W (top fixture, no plan set)
  if p <> 'free' then raise exception 'F12c FAIL [plan default]: Workshop W plan=% (expected free)', p; end if;
  select plan into p from workshops where id = 'e3000000-0000-0000-0000-0000000000e3';  -- X (set 'pro')
  if p <> 'pro' then raise exception 'F12c FAIL [plan set]: Workshop X plan=% (expected pro)', p; end if;
end $$;

select 'ALL F12c CONTRACTOR-DASHBOARD TESTS PASSED' as result;

-- ═══ F13: OWNER INBOX — WORK-REQUEST REMINDERS (0330, appended) ══
-- ═════════════════════════════════════════════════════════════════
-- Proves the outstanding quote/invoice reminder engine (app.enqueue_work_request_
-- reminders):
--   (a) authenticated / anon CANNOT execute the app.* engine or its public.cron_* wrapper;
--   (b) a 'quoted' request enqueues `quote_awaiting` and an 'invoiced' request enqueues
--       `invoice_awaiting`, to that farm's owner/manager only — never cross-tenant;
--   (c) retired/sold machines are excluded (Scope §4.1);
--   (d) the 7-day queue dedupe means a second run enqueues nothing new.
-- Fresh fixtures (distinct ids) so earlier counts are undisturbed.

-- Seed as superuser (RLS bypassed). Inserting a status directly does NOT fire the 0311
-- AFTER-UPDATE notify trigger, so the only rows the reminder templates below can create
-- are the reminders themselves — keeping the assertion about this engine alone.
-- Manager A opted out of in-app earlier (F6 §e); re-enable so Farm A targets owner+manager.
update users set notify_inapp = true where id = 'a1111111-1111-1111-1111-1111111111aa';

insert into work_requests (id, farm_id, machine_id, workshop_id, kind, status, priority, quote_amount_cents, invoice_amount_cents, vat_rate_bps, created_by) values
  ('e1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'repair',     'quoted',   'normal', 95000,  null,   1500, 'a1111111-1111-1111-1111-111111111111'),
  ('e2000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'inspection', 'invoiced', 'normal', null,   180000, 1500, 'a1111111-1111-1111-1111-111111111111'),
  ('e3000000-0000-0000-0000-0000000000a3', '11111111-1111-1111-1111-111111111111', 'aa999999-9999-9999-9999-999999999999', '33333333-3333-3333-3333-333333333333', 'repair',     'quoted',   'normal', 50000,  null,   1500, 'a1111111-1111-1111-1111-111111111111'),
  ('e4000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', null,                                     'repair',     'invoiced', 'normal', null,   70000,  1500, 'b2222222-2222-2222-2222-222222222222');

-- ── (a) authenticated cannot execute the engine or its wrapper ────
set role authenticated;
do $$
declare calls text[] := array[
    'select app.enqueue_work_request_reminders()',
    'select public.cron_enqueue_work_request_reminders()'
  ]; c text;
begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  foreach c in array calls loop
    begin execute c;
      raise exception 'F13 PRIV FAIL: authenticated executed % without a privilege error', c;
    exception
      when insufficient_privilege then null;                    -- expected
      when others then if sqlstate = 'P0001' then raise; end if;
    end;
  end loop;
end $$;
reset role;

-- ── (b)+(c) enqueue reminders to the right farm's owner/manager ───
set role service_role;
do $$ begin perform app.enqueue_work_request_reminders(); end $$;
reset role;

do $$
declare fa uuid := '11111111-1111-1111-1111-111111111111';
        fb uuid := '22222222-2222-2222-2222-222222222222';
begin
  -- Farm A: owner + manager → 2 rows for the quoted request, 2 for the invoiced one.
  if _t_notif(fa,'quote_awaiting')   <> 2 then raise exception 'F13 ENQUEUE FAIL: Farm A quote_awaiting = % (expected 2)',   _t_notif(fa,'quote_awaiting'); end if;
  if _t_notif(fa,'invoice_awaiting') <> 2 then raise exception 'F13 ENQUEUE FAIL: Farm A invoice_awaiting = % (expected 2)', _t_notif(fa,'invoice_awaiting'); end if;
  -- Farm B: owner only → 1 invoice reminder, and it never saw a quote.
  if _t_notif(fb,'invoice_awaiting') <> 1 then raise exception 'F13 ENQUEUE FAIL: Farm B invoice_awaiting = % (expected 1)', _t_notif(fb,'invoice_awaiting'); end if;
  -- (c) the retired-machine quote (e3) contributed nothing — else Farm A quote_awaiting = 4.
  --     and no cross-tenant leak in either direction.
  if _t_notif(fb,'quote_awaiting')   <> 0 then raise exception 'F13 ISOLATION FAIL: Farm B leaked quote_awaiting = %',   _t_notif(fb,'quote_awaiting'); end if;
  if _t_notif(fa,'quote_awaiting')    = 4 then raise exception 'F13 RETIRED FAIL: retired-machine quote enqueued a reminder'; end if;
end $$;

-- ── (d) 7-day queue dedupe: a second run adds nothing new ─────────
set role service_role;
do $$ begin perform app.enqueue_work_request_reminders(); end $$;
reset role;

do $$
declare fa uuid := '11111111-1111-1111-1111-111111111111';
        fb uuid := '22222222-2222-2222-2222-222222222222';
begin
  if _t_notif(fa,'quote_awaiting')   <> 2 then raise exception 'F13 DEDUPE FAIL: Farm A quote_awaiting re-fired to %',   _t_notif(fa,'quote_awaiting'); end if;
  if _t_notif(fa,'invoice_awaiting') <> 2 then raise exception 'F13 DEDUPE FAIL: Farm A invoice_awaiting re-fired to %', _t_notif(fa,'invoice_awaiting'); end if;
  if _t_notif(fb,'invoice_awaiting') <> 1 then raise exception 'F13 DEDUPE FAIL: Farm B invoice_awaiting re-fired to %', _t_notif(fb,'invoice_awaiting'); end if;
end $$;

-- ── anon cannot execute the wrapper ───────────────────────────────
set role anon;
do $$ begin
  begin perform public.cron_enqueue_work_request_reminders();
    raise exception 'F13 ISOLATION FAIL [anon]: executed cron wrapper';
  exception
    when insufficient_privilege then null;                      -- expected
    when others then if sqlstate = 'P0001' then raise; end if;
  end;
end $$;
reset role;

select 'ALL F13 OWNER-INBOX REMINDER TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- F8 · POPIA data-subject rights (export + erasure RPCs)
-- Proves: (a) execute is REVOKED from anon on both RPCs (and the app.* guard is
-- revoked from public/anon/authenticated); (b) the RPCs are FARM-SCOPED — a farm's
-- owner/manager may only act on their OWN farm's people, cross-farm attempts raise;
-- (c) rr_admin may act cross-tenant and the access is logged; (d) erasure anonymises
-- the identity in place (name/email cleared, deactivated + soft-deleted) and nulls
-- the free-text name copies; (e) a user cannot erase their own account via the RPC.
-- ═════════════════════════════════════════════════════════════════

-- Disposable Farm A operator + a couple of authored records (seeded as superuser).
insert into auth.users (id, email) values
  ('e5111111-1111-1111-1111-111111111111', 'opa2@test');
insert into users (id, farm_id, workshop_id, role, name, email, phone) values
  ('e5111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', null,
   'operator', 'Operator A2', 'opa2@test', '+27820000001');
insert into meter_readings (farm_id, machine_id, reading, source, by_user) values
  ('11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 321, 'app',
   'e5111111-1111-1111-1111-111111111111');
insert into usage_logs (farm_id, machine_id, driver_user_id, driver_name, occurred_on, meter_reading, source) values
  ('11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111',
   'e5111111-1111-1111-1111-111111111111', 'Operator A2', current_date, 321, 'app');

-- ── (a) execute privileges ────────────────────────────────────────
do $$ begin
  if has_function_privilege('anon', 'public.export_personal_data(uuid)', 'execute')
    then raise exception 'F8 ISOLATION FAIL: anon can execute export_personal_data'; end if;
  if has_function_privilege('anon', 'public.erase_personal_data(uuid, text)', 'execute')
    then raise exception 'F8 ISOLATION FAIL: anon can execute erase_personal_data'; end if;
  if not has_function_privilege('authenticated', 'public.export_personal_data(uuid)', 'execute')
    then raise exception 'F8 FAIL: authenticated cannot execute export_personal_data'; end if;
  if not has_function_privilege('authenticated', 'public.erase_personal_data(uuid, text)', 'execute')
    then raise exception 'F8 FAIL: authenticated cannot execute erase_personal_data'; end if;
  if has_function_privilege('authenticated', 'app.assert_can_manage_person(uuid, text)', 'execute')
    then raise exception 'F8 ISOLATION FAIL: authenticated can call the internal guard directly'; end if;
end $$;

-- ── (b) farm scoping — Owner B may NOT export a Farm A person ──────
set role authenticated;
do $$ begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');   -- Owner B
  begin
    perform public.export_personal_data('e5111111-1111-1111-1111-111111111111');
    raise exception 'F8 ISOLATION FAIL [ownerB]: exported a Farm A person';
  exception when others then if sqlstate <> 'P0001' then raise; end if;
  end;
end $$;

-- Owner A CAN export their own farm's person; the bundle carries the profile + logs.
do $$ declare j jsonb; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  j := public.export_personal_data('e5111111-1111-1111-1111-111111111111');
  if (j -> 'profile' ->> 'id') <> 'e5111111-1111-1111-1111-111111111111'
    then raise exception 'F8 EXPORT FAIL: profile missing/wrong'; end if;
  if jsonb_array_length(j -> 'usage_logs') < 1
    then raise exception 'F8 EXPORT FAIL: usage_logs not included'; end if;
  if jsonb_array_length(j -> 'meter_readings') < 1
    then raise exception 'F8 EXPORT FAIL: meter_readings not included'; end if;
end $$;
reset role;

-- ── (c) rr_admin exports cross-tenant AND the access is logged ────
set role authenticated;
do $$ declare j jsonb; c int; begin
  perform _t_login('d4444444-4444-4444-4444-444444444444');   -- RR admin
  j := public.export_personal_data('e5111111-1111-1111-1111-111111111111');
  if j is null then raise exception 'F8 EXPORT FAIL: rr_admin got null'; end if;
  execute $q$ select count(*) from audit_log
              where entity = 'data_subject_export'
                and entity_id = 'e5111111-1111-1111-1111-111111111111' $q$ into c;
  if c < 1 then raise exception 'F8 AUDIT FAIL: rr_admin cross-tenant export not logged'; end if;
end $$;
reset role;

-- ── (e) self-erase is blocked ─────────────────────────────────────
set role authenticated;
do $$ begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  begin
    perform public.erase_personal_data('a1111111-1111-1111-1111-111111111111', 'test');
    raise exception 'F8 FAIL: a user erased their own account';
  exception when others then if sqlstate <> 'P0001' then raise; end if;
  end;
end $$;
reset role;

-- ── (b′) erasure scoping — Owner B may NOT erase a Farm A person ───
set role authenticated;
do $$ begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');   -- Owner B
  begin
    perform public.erase_personal_data('e5111111-1111-1111-1111-111111111111', 'test');
    raise exception 'F8 ISOLATION FAIL [ownerB]: erased a Farm A person';
  exception when others then if sqlstate <> 'P0001' then raise; end if;
  end;
end $$;
reset role;

-- ── (d) Owner A erases their farm's person → identity anonymised ──
set role authenticated;
do $$ declare r jsonb; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  r := public.erase_personal_data('e5111111-1111-1111-1111-111111111111', 'left the farm');
  if (r ->> 'erased') <> 'true' then raise exception 'F8 ERASE FAIL: not erased'; end if;
end $$;
reset role;

-- Verify the anonymisation as superuser (RLS bypassed).
do $$ declare u record; c int; begin
  select name, email, phone, active, deleted_at, whatsapp_opt_in into u
    from users where id = 'e5111111-1111-1111-1111-111111111111';
  if u.name <> '[erased]'   then raise exception 'F8 ERASE FAIL: name not anonymised (%)', u.name; end if;
  if u.email is not null    then raise exception 'F8 ERASE FAIL: email not cleared'; end if;
  if u.phone is not null    then raise exception 'F8 ERASE FAIL: phone not cleared'; end if;
  if u.active               then raise exception 'F8 ERASE FAIL: account still active'; end if;
  if u.deleted_at is null   then raise exception 'F8 ERASE FAIL: not soft-deleted'; end if;
  select count(*) into c from usage_logs
    where driver_user_id = 'e5111111-1111-1111-1111-111111111111' and driver_name is not null;
  if c <> 0 then raise exception 'F8 ERASE FAIL: % usage_log name copies survived', c; end if;
  execute $q$ select count(*) from audit_log
              where entity = 'data_subject_erasure'
                and entity_id = 'e5111111-1111-1111-1111-111111111111' $q$ into c;
  if c < 1 then raise exception 'F8 AUDIT FAIL: erasure not logged'; end if;
end $$;

select 'ALL F8 POPIA DATA-SUBJECT-RIGHTS TESTS PASSED' as result;
