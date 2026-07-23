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
