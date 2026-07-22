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
    'fuel_issues','job_card_service_lines','audit_log'
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
