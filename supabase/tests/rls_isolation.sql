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
-- Persona: WORKSHOP W → only its linked farm (A), never Farm B —
-- and, since F16 (0400), only the part of Farm A it is working on.
-- ═════════════════════════════════════════════════════════════════
--
-- Until 0400 an active link handed a contractor the same view as the farm's own staff:
-- every vehicle, every cost entry, the whole team directory and the farm's other
-- contractors. The counts below encode the NEW default — the minimum needed to do a job
-- — and the F16 section further down proves each grant turns its own slice back on.
--
-- W has no work request and no document against Farm A's machine, so at this point it is
-- working on nothing there: it can see the farm exists and that it is linked, and that
-- is all.
set role authenticated;
do $$ begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');
  perform _t_assert('farms',              1, 'workshopW');  -- Farm A only
  perform _t_assert('machines',           0, 'workshopW');  -- none of them are its work
  perform _t_assert('meter_readings',     0, 'workshopW');  -- history not granted
  perform _t_assert('service_plan_lines', 0, 'workshopW');
  perform _t_assert('service_templates',  2, 'workshopW');  -- Farm A + GLOBAL (unchanged)
  perform _t_assert('faults',             0, 'workshopW');
  perform _t_assert('job_cards',          0, 'workshopW');
  perform _t_assert('job_card_lines',     0, 'workshopW');  -- costs not granted
  perform _t_assert('job_card_service_lines', 1, 'workshopW');
  perform _t_assert('watch_items',        0, 'workshopW');
  perform _t_assert('attachments',        1, 'workshopW');
  -- 0403: a notification is addressed to a PERSON, and these are addressed to Farm A's
  -- owner. Before 0403 the policy was farm-wide, so the contractor could read the
  -- payloads — quote totals, fault descriptions, fuel anomalies — of everything 0400
  -- had just gated. The narrower rule applies to everyone, not only contractors.
  perform _t_assert('notifications',      0, 'workshopW');
  perform _t_assert('fuel_tanks',         0, 'workshopW');  -- costs not granted
  perform _t_assert('fuel_deliveries',    0, 'workshopW');
  perform _t_assert('fuel_issues',        0, 'workshopW');
  perform _t_assert('users',              1, 'workshopW');  -- itself only; team not granted
  perform _t_assert('workshops',          1, 'workshopW');  -- self
  perform _t_assert('workshop_links',     1, 'workshopW');
  perform _t_assert('sync_log',           1, 'workshopW');  -- Farm A only
  perform _t_assert('usage_logs',         0, 'workshopW');
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

-- ── S10 support mode: the paired 'exit' row ──────────────────────
-- "Act into farm" used to write one row and change nothing else. Support mode now
-- pins a farm-context cookie on enter and clears it on leave, and leaving writes a
-- matching 'exit' row so the log shows DURATION rather than only that someone looked.
-- The cookie is app-layer (a narrowing of what the UI queries — rr_admin already reads
-- every farm through app.is_rr_admin()), so what must hold in SQL is: the exit action
-- is admin-only, and it lands as its own audit row alongside the enter.

-- (d) a non-admin cannot write an 'exit' row either.
do $$
begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A (not admin)
  begin
    perform public.log_admin_farm_access('11111111-1111-1111-1111-111111111111', 'exit');
    raise exception 'ADMIN FAIL: non-admin was allowed to log a support exit';
  exception
    when others then
      if sqlstate = 'P0001' and sqlerrm like 'ADMIN FAIL%' then raise; end if;
      null;
  end;
end $$;

-- (e) rr_admin's exit appends its own row, so enter+exit pair up for the same farm.
do $$ declare entered bigint; exited bigint; begin
  perform _t_login('d4444444-4444-4444-4444-444444444444');   -- RR admin
  perform public.log_admin_farm_access('11111111-1111-1111-1111-111111111111', 'exit');
  select count(*) into entered from audit_log
    where entity = 'admin_farm_access' and action = 'impersonate'
      and farm_id = '11111111-1111-1111-1111-111111111111';
  select count(*) into exited from audit_log
    where entity = 'admin_farm_access' and action = 'exit'
      and farm_id = '11111111-1111-1111-1111-111111111111';
  if entered <> 1 then raise exception 'ADMIN FAIL: expected 1 impersonate row, got %', entered; end if;
  if exited  <> 1 then raise exception 'ADMIN FAIL: expected 1 exit row, got %', exited; end if;
end $$;

-- (f) the exit row stays farm-scoped like every other audit row.
do $$ declare c bigint; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');   -- Owner B
  select count(*) into c from audit_log where entity = 'admin_farm_access' and action = 'exit';
  if c <> 0 then raise exception 'ADMIN FAIL: Owner B sees % support-exit rows (expected 0)', c; end if;
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
-- A contractor sees no costs at all by default (F16 / 0400): what the farm paid is not
-- job information. The F16 section proves `see_costs` turns it back on.
do $$ begin perform _t_login('c3333333-3333-3333-3333-333333333333'); perform _t_assert('cost_entries', 0, 'workshopW'); end $$;
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
do $$ begin perform _t_login('c3333333-3333-3333-3333-333333333333'); -- Compliance paperwork rides the same vehicle-scope rule now (F16 / 0400): W is not
-- working on Farm A's machine, so it sees none of its licences either.
  perform _t_assert('licences', 0, 'workshopW'); end $$;
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
-- A contractor sees ONLY the global suggested rows — never the farm's own partner list
-- (F16 / 0400). That list is a competitor directory with phone numbers, and there is no
-- setting that makes it part of fixing a tractor.
do $$ declare c bigint; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');
  perform _t_assert('partners', 1, 'workshopW');                    -- GLOBAL only
  execute $q$ select count(*) from partners where farm_id is not null $q$ into c;
  if c <> 0 then
    raise exception 'COMPETITOR-LIST LEAK: a contractor sees % of the farm''s own partners', c;
  end if;
end $$;
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
--   (b) OWN-WORKSHOP ONLY — on a farm shared by two contractors, RLS is now workshop-scoped
--       (F7/0341): W can NO LONGER see X's request row even though both are linked to the
--       shared farm. What used to be an app-only workshop_id filter is now an RLS guarantee;
--   (c) NEVER AN UNLINKED FARM — a request assigned to W but on a farm W is NOT linked to
--       stays invisible (RLS dominates the assignment); a workshop cannot update it;
--   (d) the `workshops.plan` gating column reads back with its default.
-- Fresh fixtures (Farm E, Workshop X, distinct request ids) leave earlier counts intact.

-- Farm E + a machine on it; a SECOND workshop X (plan 'managed'); X's staff user. Link W to
-- Farm E (so W is linked to Farm A AND Farm E) and link X to Farm A (shared with W).
insert into farms (id, name) values
  ('e1000000-0000-0000-0000-0000000000e1', 'Farm E');
insert into machines (id, farm_id, name, type) values
  ('ee100000-0000-0000-0000-0000000000e1', 'e1000000-0000-0000-0000-0000000000e1', 'Machine E1', 'tractor');
insert into workshops (id, name, kind, plan) values
  ('e3000000-0000-0000-0000-0000000000e3', 'Workshop X', 'parts_supplier', 'managed');
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

  -- (b) F7 STRENGTHENING: RLS is now workshop-scoped, not merely farm-scoped. On the
  --     shared Farm A, W can NO LONGER see X's request — the RLS predicate (0341) enforces
  --     what used to be only an app-side workshop_id filter. This is the F12c gap closed.
  execute $q$ select count(*) from work_requests where workshop_id = 'e3000000-0000-0000-0000-0000000000e3' $q$ into c;
  if c <> 0 then raise exception 'F12c FAIL [W sees shared farm]: X-request visibility=% (expected 0 after F7 RLS workshop-scoping)', c; end if;

  -- Total RLS-visible to W now EQUALS the dashboard set: Farm A (d1..a1 W) + Farm E
  -- (d3..e1 W) = 2. X's Farm A request (d4..a2) is excluded by RLS, not just the app query.
  execute $q$ select count(*) from work_requests $q$ into c;
  if c <> 2 then raise exception 'F12c FAIL [W total visible]: %=(expected 2 after F7 RLS workshop-scoping)', c; end if;

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
  if p <> 'portal' then raise exception 'F12c FAIL [plan default]: Workshop W plan=% (expected portal)', p; end if;
  select plan into p from workshops where id = 'e3000000-0000-0000-0000-0000000000e3';  -- X (set 'managed')
  if p <> 'managed' then raise exception 'F12c FAIL [plan set]: Workshop X plan=% (expected managed)', p; end if;
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
-- ═══ F7: MULTI-SITE + PER-ROLE VISIBILITY (0340–0341, appended) ══
-- ═════════════════════════════════════════════════════════════════
-- Proves the three F7 access paths, each ADDITIVE to (never weakening) the model above:
--   (A) MULTI-SITE — a user whose PRIMARY farm is F and who holds an ACTIVE
--       user_farm_membership to G sees exactly F ∪ G (machines + child rows), never a
--       third farm H; revoking the membership immediately removes G (dynamic scoping,
--       like workshop_links); the memberships table is itself tenant/own-user isolated
--       and anon-denied.
--   (B) OPERATOR — a user whose role is `operator` sees ONLY machines assigned to them
--       (assigned_operator_id = auth.uid()) and only those machines' child rows; a
--       non-assigned machine (and its readings/faults/work) is invisible. Owner/manager
--       keep full-farm access (operator gating never leaks upward).
--   (C) CONTRACTOR — a `workshop` user sees (and may update) ONLY the work_requests
--       assigned to its own workshop, even on a farm shared with another contractor;
--       another workshop's request on the SAME farm is invisible and un-updatable.
-- Fresh fixtures (Farms F/G/H, distinct ids) leave every earlier count intact.

-- ── Fixtures (superuser; RLS bypassed) ────────────────────────────
insert into farms (id, name) values
  ('f0000000-0000-0000-0000-0000000000f1', 'Farm F'),
  ('f0000000-0000-0000-0000-0000000000f2', 'Farm G'),
  ('f0000000-0000-0000-0000-0000000000f3', 'Farm H');

insert into auth.users (id, email) values
  ('f5000000-0000-0000-0000-0000000000f1', 'multisite@test'),   -- MS: owner F + member G
  ('f5000000-0000-0000-0000-0000000000f2', 'operatorF@test'),   -- OP: operator on F, assigned F1
  ('f4000000-0000-0000-0000-0000000000f1', 'wsM@test'),         -- Workshop M staff
  ('f4000000-0000-0000-0000-0000000000f2', 'wsN@test');         -- Workshop N staff

insert into users (id, farm_id, workshop_id, role, name) values
  ('f5000000-0000-0000-0000-0000000000f1', 'f0000000-0000-0000-0000-0000000000f1', null, 'owner',    'MultiSite Owner'),
  ('f5000000-0000-0000-0000-0000000000f2', 'f0000000-0000-0000-0000-0000000000f1', null, 'operator', 'Operator F');

insert into workshops (id, name) values
  ('f3000000-0000-0000-0000-0000000000f1', 'Workshop M'),
  ('f3000000-0000-0000-0000-0000000000f2', 'Workshop N');
insert into users (id, farm_id, workshop_id, role, name) values
  ('f4000000-0000-0000-0000-0000000000f1', null, 'f3000000-0000-0000-0000-0000000000f1', 'workshop', 'Workshop M Staff'),
  ('f4000000-0000-0000-0000-0000000000f2', null, 'f3000000-0000-0000-0000-0000000000f2', 'workshop', 'Workshop N Staff');
-- Both contractors are linked to the SHARED Farm F.
insert into workshop_links (workshop_id, farm_id, status) values
  ('f3000000-0000-0000-0000-0000000000f1', 'f0000000-0000-0000-0000-0000000000f1', 'active'),
  ('f3000000-0000-0000-0000-0000000000f2', 'f0000000-0000-0000-0000-0000000000f1', 'active');

-- Machines: F1 (assigned to OP) + F2 (unassigned) on Farm F; G1 on Farm G; H1 on Farm H.
insert into machines (id, farm_id, name, type, assigned_operator_id) values
  ('f1000000-0000-0000-0000-0000000000f1', 'f0000000-0000-0000-0000-0000000000f1', 'F1 (assigned)',   'tractor', 'f5000000-0000-0000-0000-0000000000f2'),
  ('f1000000-0000-0000-0000-0000000000f2', 'f0000000-0000-0000-0000-0000000000f1', 'F2 (unassigned)', 'tractor', null),
  ('f1000000-0000-0000-0000-0000000000f9', 'f0000000-0000-0000-0000-0000000000f2', 'G1',              'tractor', null),
  ('f1000000-0000-0000-0000-0000000000fa', 'f0000000-0000-0000-0000-0000000000f3', 'H1',              'tractor', null);

-- One reading + one fault on EACH Farm F machine (child-row scoping fixtures).
insert into meter_readings (farm_id, machine_id, reading, source) values
  ('f0000000-0000-0000-0000-0000000000f1', 'f1000000-0000-0000-0000-0000000000f1', 10, 'manual'),
  ('f0000000-0000-0000-0000-0000000000f1', 'f1000000-0000-0000-0000-0000000000f2', 20, 'manual');
insert into faults (farm_id, machine_id, description, urgency, status) values
  ('f0000000-0000-0000-0000-0000000000f1', 'f1000000-0000-0000-0000-0000000000f1', 'F1 fault', 'limping', 'open'),
  ('f0000000-0000-0000-0000-0000000000f1', 'f1000000-0000-0000-0000-0000000000f2', 'F2 fault', 'limping', 'open');

-- MS's cross-site access: an ACTIVE membership to Farm G (role manager). MS reaches Farm F
-- via users.farm_id (primary) and Farm G via this membership — proving the UNION.
insert into user_farm_memberships (id, user_id, farm_id, role, active) values
  ('f7000000-0000-0000-0000-0000000000f1', 'f5000000-0000-0000-0000-0000000000f1', 'f0000000-0000-0000-0000-0000000000f2', 'manager', true);

-- Work requests on the SHARED Farm F: one for Workshop M, one for Workshop N (both on F1),
-- and one on the unassigned F2 (for the operator negative test).
insert into work_requests (id, farm_id, machine_id, workshop_id, kind, status) values
  ('f6000000-0000-0000-0000-0000000000f1', 'f0000000-0000-0000-0000-0000000000f1', 'f1000000-0000-0000-0000-0000000000f1', 'f3000000-0000-0000-0000-0000000000f1', 'repair', 'requested'),
  ('f6000000-0000-0000-0000-0000000000f2', 'f0000000-0000-0000-0000-0000000000f1', 'f1000000-0000-0000-0000-0000000000f1', 'f3000000-0000-0000-0000-0000000000f2', 'repair', 'requested'),
  ('f6000000-0000-0000-0000-0000000000f3', 'f0000000-0000-0000-0000-0000000000f1', 'f1000000-0000-0000-0000-0000000000f2', null,                                   'repair', 'requested');
insert into work_request_events (farm_id, work_request_id, from_status, to_status, note) values
  ('f0000000-0000-0000-0000-0000000000f1', 'f6000000-0000-0000-0000-0000000000f1', null, 'requested', 'M created'),
  ('f0000000-0000-0000-0000-0000000000f1', 'f6000000-0000-0000-0000-0000000000f2', null, 'requested', 'N created');

-- ── (A) MULTI-SITE: MS sees Farm F ∪ Farm G, never Farm H ─────────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('f5000000-0000-0000-0000-0000000000f1');       -- MS (owner F + member G)
  -- farms: F + G (not H).
  execute $q$ select count(*) from farms where id in
    ('f0000000-0000-0000-0000-0000000000f1','f0000000-0000-0000-0000-0000000000f2','f0000000-0000-0000-0000-0000000000f3') $q$ into c;
  if c <> 2 then raise exception 'F7 MULTISITE FAIL [MS farms]: sees % of F/G/H (expected 2)', c; end if;
  -- machines across the union: F1 + F2 (Farm F) + G1 (Farm G) = 3; H1 invisible.
  execute $q$ select count(*) from machines where farm_id in
    ('f0000000-0000-0000-0000-0000000000f1','f0000000-0000-0000-0000-0000000000f2') $q$ into c;
  if c <> 3 then raise exception 'F7 MULTISITE FAIL [MS machines]: sees % (expected 3: F1+F2+G1)', c; end if;
  execute $q$ select count(*) from machines where farm_id = 'f0000000-0000-0000-0000-0000000000f3' $q$ into c;
  if c <> 0 then raise exception 'F7 MULTISITE FAIL [MS Farm H]: sees % Farm H machines (expected 0)', c; end if;
  -- owner sees BOTH Farm F machines' child rows (operator gating never leaks upward).
  execute $q$ select count(*) from meter_readings where farm_id = 'f0000000-0000-0000-0000-0000000000f1' $q$ into c;
  if c <> 2 then raise exception 'F7 MULTISITE FAIL [MS readings]: owner sees % Farm F readings (expected 2)', c; end if;
  -- owner sees ALL Farm F work_requests (workshop-scoping never narrows a farm owner).
  execute $q$ select count(*) from work_requests where farm_id = 'f0000000-0000-0000-0000-0000000000f1' $q$ into c;
  if c <> 3 then raise exception 'F7 MULTISITE FAIL [MS work]: owner sees % Farm F requests (expected 3)', c; end if;
end $$;
reset role;

-- ── (A) membership table isolation + own-user visibility ──────────
set role authenticated;
do $$ begin
  perform _t_login('f5000000-0000-0000-0000-0000000000f1');       -- MS sees its own membership row
  perform _t_assert('user_farm_memberships', 1, 'MS');
end $$;
do $$ begin
  perform _t_login('f5000000-0000-0000-0000-0000000000f2');       -- Operator F: no memberships, not an admin
  perform _t_assert('user_farm_memberships', 0, 'operatorF');
end $$;
do $$ begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');       -- Owner B: unrelated tenant
  perform _t_assert('user_farm_memberships', 0, 'ownerB');
end $$;
do $$ begin
  perform _t_login('d4444444-4444-4444-4444-444444444444');       -- RR admin sees the only membership row
  perform _t_assert('user_farm_memberships', 1, 'rrAdmin');
end $$;
reset role;

-- ── (A) dynamic scoping: revoking the membership removes Farm G ────
update user_farm_memberships set active = false where id = 'f7000000-0000-0000-0000-0000000000f1';
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('f5000000-0000-0000-0000-0000000000f1');       -- MS after revoke
  execute $q$ select count(*) from machines where farm_id = 'f0000000-0000-0000-0000-0000000000f2' $q$ into c;
  if c <> 0 then raise exception 'F7 MULTISITE FAIL [MS after revoke]: still sees % Farm G machines (expected 0)', c; end if;
  execute $q$ select count(*) from machines where farm_id = 'f0000000-0000-0000-0000-0000000000f1' $q$ into c;
  if c <> 2 then raise exception 'F7 MULTISITE FAIL [MS after revoke]: lost primary Farm F (sees %, expected 2)', c; end if;
end $$;
reset role;
update user_farm_memberships set active = true where id = 'f7000000-0000-0000-0000-0000000000f1';

-- ── (A) anon: memberships table denies read + write ───────────────
set role anon;
do $$ declare c bigint; begin
  perform set_config('request.jwt.claims', '', false);
  begin execute 'select count(*) from public.user_farm_memberships' into c;
  exception when insufficient_privilege then c := 0; end;
  if c <> 0 then raise exception 'F7 ISOLATION FAIL [anon]: sees % memberships', c; end if;
  begin
    insert into user_farm_memberships (user_id, farm_id, role)
      values ('f5000000-0000-0000-0000-0000000000f1', 'f0000000-0000-0000-0000-0000000000f2', 'operator');
    raise exception 'F7 ISOLATION FAIL [anon]: inserted a membership';
  exception
    when insufficient_privilege then null;                        -- expected
    when others then if sqlstate = 'P0001' then raise; end if;
  end;
end $$;
reset role;

-- ── (A) a non-admin cannot grant themselves a membership to another farm ──
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('f5000000-0000-0000-0000-0000000000f2');       -- Operator F (no admin rights anywhere)
  begin insert into user_farm_memberships (user_id, farm_id, role)
    values ('f5000000-0000-0000-0000-0000000000f2', 'f0000000-0000-0000-0000-0000000000f3', 'operator');   -- self → Farm H
  exception when others then ok := true; end;
  if not ok then raise exception 'F7 ISOLATION FAIL [operatorF]: granted itself a Farm H membership'; end if;
end $$;
reset role;

-- ── (B) OPERATOR: sees ONLY the assigned machine + its child rows ──
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('f5000000-0000-0000-0000-0000000000f2');       -- Operator F (assigned F1 only)
  -- machines: only F1.
  execute $q$ select count(*) from machines where farm_id = 'f0000000-0000-0000-0000-0000000000f1' $q$ into c;
  if c <> 1 then raise exception 'F7 OPERATOR FAIL [machines]: sees % Farm F machines (expected 1: F1)', c; end if;
  -- explicitly: the UNASSIGNED machine F2 is invisible (denied).
  execute $q$ select count(*) from machines where id = 'f1000000-0000-0000-0000-0000000000f2' $q$ into c;
  if c <> 0 then raise exception 'F7 OPERATOR FAIL [non-assigned machine]: F2 visible (count=%, expected 0)', c; end if;
  -- child rows follow the machine: F1's reading + fault visible, F2's are not.
  execute $q$ select count(*) from meter_readings where farm_id = 'f0000000-0000-0000-0000-0000000000f1' $q$ into c;
  if c <> 1 then raise exception 'F7 OPERATOR FAIL [readings]: sees % (expected 1: F1 only)', c; end if;
  execute $q$ select count(*) from faults where farm_id = 'f0000000-0000-0000-0000-0000000000f1' $q$ into c;
  if c <> 1 then raise exception 'F7 OPERATOR FAIL [faults]: sees % (expected 1: F1 only)', c; end if;
  -- work_requests: the two on F1 are visible; the one on F2 is not.
  execute $q$ select count(*) from work_requests where farm_id = 'f0000000-0000-0000-0000-0000000000f1' $q$ into c;
  if c <> 2 then raise exception 'F7 OPERATOR FAIL [work]: sees % Farm F requests (expected 2: both on F1)', c; end if;
  execute $q$ select count(*) from work_requests where machine_id = 'f1000000-0000-0000-0000-0000000000f2' $q$ into c;
  if c <> 0 then raise exception 'F7 OPERATOR FAIL [work on non-assigned]: sees % (expected 0)', c; end if;
end $$;
reset role;

-- ── (C) CONTRACTOR: each workshop sees ONLY its own assigned requests on the SHARED farm ──
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('f4000000-0000-0000-0000-0000000000f1');       -- Workshop M (linked to Farm F)
  -- Only M's request (f6..f1), NOT N's (f6..f2) — even though BOTH are on the shared Farm F.
  perform _t_assert('work_requests', 1, 'workshopM');
  execute $q$ select count(*) from work_requests where workshop_id = 'f3000000-0000-0000-0000-0000000000f2' $q$ into c;
  if c <> 0 then raise exception 'F7 CONTRACTOR FAIL [M sees N]: workshop M sees % of N''s requests (expected 0)', c; end if;
  -- events follow the request: M sees only its own request's event.
  perform _t_assert('work_request_events', 1, 'workshopM');
end $$;
do $$ begin
  perform _t_login('f4000000-0000-0000-0000-0000000000f2');       -- Workshop N
  perform _t_assert('work_requests', 1, 'workshopN');             -- only N's request
end $$;
reset role;

-- ── (C) a workshop cannot UPDATE another workshop's request on the shared farm ──
do $$ declare st work_request_status; begin
  set role authenticated;
  perform _t_login('f4000000-0000-0000-0000-0000000000f1');       -- Workshop M
  update work_requests set status = 'closed' where id = 'f6000000-0000-0000-0000-0000000000f2';  -- N's request → RLS filters to 0 rows
  reset role;
  select status into st from work_requests where id = 'f6000000-0000-0000-0000-0000000000f2';    -- read back unfiltered
  if st <> 'requested' then raise exception 'F7 CONTRACTOR FAIL [M mutated N]: N''s request status=% (expected requested)', st; end if;
end $$;

-- ── (C) but a workshop CAN update its OWN assigned request (positive path) ──
set role authenticated;
do $$ declare st work_request_status; begin
  perform _t_login('f4000000-0000-0000-0000-0000000000f1');       -- Workshop M
  update work_requests set status = 'viewed', updated_at = now() where id = 'f6000000-0000-0000-0000-0000000000f1';
  select status into st from work_requests where id = 'f6000000-0000-0000-0000-0000000000f1';
  if st <> 'viewed' then raise exception 'F7 CONTRACTOR FAIL [M own request]: could not advance own request (status=%)', st; end if;
end $$;
reset role;

select 'ALL F7 MULTI-SITE & PER-ROLE TESTS PASSED' as result;

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

-- ═══ G2: AARTO FINE WORKFLOW (0370–0371, appended section) ═══════
-- Proves:
--   (a) `fines` is tenant-isolated (own-farm visible, cross-tenant = 0, workshop scoped to
--       its linked farm, rr_admin sees all; anon covered in the anon sweep below).
--   (b) a cross-tenant fine WRITE is rejected.
--   (c) authenticated CANNOT execute the nomination-reminder engine / its cron wrapper.
--   (d) app.enqueue_aarto_nomination_reminders enqueues `aarto_nomination_due` to the right
--       farm's owner+manager for a fine still owing a nomination whose deadline is due, and
--       NEVER for a fine already nominated, on a retired machine, or with a distant deadline;
--       it dedupes on re-run.
-- Fresh fixtures avoid disturbing earlier counts. Nothing above this line is modified.
-- ═════════════════════════════════════════════════════════════════

-- Manager A opted out of in-app in F6 §e (re-enabled in F13); re-assert so Farm A targets
-- owner+manager for the enqueue assertion below.
update users set notify_inapp = true where id = 'a1111111-1111-1111-1111-1111111111aa';

-- Vehicles: Farm A active, Farm B active, Farm A RETIRED (its fine must never enqueue).
insert into machines (id, farm_id, name, type, status) values
  ('aa720000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'Fine A', 'tractor', 'active'),
  ('bb720000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'Fine B', 'tractor', 'active'),
  ('aa720000-0000-0000-0000-0000000000f0', '11111111-1111-1111-1111-111111111111', 'Retired Fine A', 'tractor', 'retired');

-- Fines: Farm A due (enqueues), Farm A already nominated (silent), Farm B distant deadline
-- (silent), Farm A retired-machine (excluded).
insert into fines (id, farm_id, machine_id, notice_number, offence, offence_date, nomination_deadline, status) values
  ('f1720000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'aa720000-0000-0000-0000-0000000000a1', 'NA-DUE',  'Speeding', current_date - 30, current_date - 2,   'received'),
  ('f1720000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'aa720000-0000-0000-0000-0000000000a1', 'NA-NOM',  'Speeding', current_date - 30, current_date - 2,   'nominated'),
  ('f2720000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'bb720000-0000-0000-0000-0000000000b1', 'NB-OK',   'Speeding', current_date - 30, current_date + 200, 'received'),
  ('f1720000-0000-0000-0000-0000000000f0', '11111111-1111-1111-1111-111111111111', 'aa720000-0000-0000-0000-0000000000f0', 'NA-RET',  'Speeding', current_date - 30, current_date - 2,   'received');

-- ── (a) fines isolation ───────────────────────────────────────────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  perform _t_assert('fines', 3, 'ownerA');                    -- all three Farm A fines (incl. retired-machine one)
  execute $q$ select count(*) from fines where farm_id <> '11111111-1111-1111-1111-111111111111' $q$ into c;
  if c <> 0 then raise exception 'FINES ISOLATION FAIL [ownerA]: sees % non-Farm-A fines', c; end if;
end $$;
do $$ begin perform _t_login('b2222222-2222-2222-2222-222222222222'); perform _t_assert('fines', 1, 'ownerB');    end $$;
-- Fines name a DRIVER (the AARTO nomination), so a contractor seeing the farm's fines
-- was personal data with no job attached to it. They ride the vehicle-scope rule now
-- (F16 / 0400): W is working on none of Farm A's machines, so it sees none.
do $$ begin perform _t_login('c3333333-3333-3333-3333-333333333333'); perform _t_assert('fines', 0, 'workshopW'); end $$;
do $$ begin perform _t_login('d4444444-4444-4444-4444-444444444444'); perform _t_assert('fines', 4, 'rrAdmin');   end $$;
reset role;

-- (a) cross-tenant fine WRITE is rejected.
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  begin
    insert into fines (farm_id, machine_id, offence)
      values ('22222222-2222-2222-2222-222222222222', 'bb720000-0000-0000-0000-0000000000b1', 'Illegal parking');
  exception when others then ok := true; end;
  if not ok then raise exception 'FINES ISOLATION FAIL [ownerA]: wrote a fine into Farm B'; end if;
end $$;
reset role;

-- (a) anon sees no fines and cannot write.
set role anon;
do $$ declare c bigint; begin
  perform set_config('request.jwt.claims', '', false);
  begin execute 'select count(*) from public.fines' into c;
  exception when insufficient_privilege then c := 0; end;
  if c <> 0 then raise exception 'FINES ISOLATION FAIL [anon]: sees % fines', c; end if;
  begin
    insert into fines (farm_id, machine_id, offence)
      values ('11111111-1111-1111-1111-111111111111', 'aa720000-0000-0000-0000-0000000000a1', 'x');
    raise exception 'FINES ISOLATION FAIL [anon]: inserted a fine';
  exception
    when insufficient_privilege then null;                   -- expected
    when others then if sqlstate = 'P0001' then raise; end if;
  end;
end $$;
reset role;

-- ── (b) authenticated CANNOT execute the reminder engine / cron wrapper ──
set role authenticated;
do $$
declare calls text[] := array[
  'select app.enqueue_aarto_nomination_reminders()',
  'select public.cron_enqueue_aarto_nominations()'
]; c text;
begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  foreach c in array calls loop
    begin
      execute c;
      raise exception 'AARTO PRIV FAIL: authenticated executed % without a privilege error', c;
    exception
      when insufficient_privilege then null;                 -- expected
      when others then if sqlstate = 'P0001' then raise; end if;
    end;
  end loop;
end $$;
reset role;

-- ── (c) run the engine as the service role (the nightly route's identity) ──
set role service_role;
do $$ begin perform app.enqueue_aarto_nomination_reminders(); end $$;
reset role;

do $$
declare
  fa uuid := '11111111-1111-1111-1111-111111111111';
  fb uuid := '22222222-2222-2222-2222-222222222222';
  expected bigint;
begin
  -- Expected recipients = Farm A owner+manager who accept in-app notifications.
  select count(*) into expected from users
    where farm_id = fa and role in ('owner','manager') and active and deleted_at is null and coalesce(notify_inapp, true);
  if expected < 1 then raise exception 'AARTO TEST SETUP FAIL: Farm A has no in-app owner/manager recipients'; end if;

  -- Only the due, still-owed Farm A fine fires (nominated + retired-machine excluded).
  if _t_notif(fa, 'aarto_nomination_due') <> expected then
    raise exception 'AARTO ENQUEUE FAIL: Farm A aarto_nomination_due = % (expected % = owner+manager for one due fine)',
      _t_notif(fa, 'aarto_nomination_due'), expected;
  end if;
  -- Farm B's fine has a distant deadline → silent.
  if _t_notif(fb, 'aarto_nomination_due') <> 0 then
    raise exception 'AARTO ENQUEUE FAIL: Farm B enqueued % (expected 0 — deadline not near)', _t_notif(fb, 'aarto_nomination_due');
  end if;
end $$;

-- (c) dedupe: a second run enqueues nothing new.
set role service_role;
do $$ begin perform app.enqueue_aarto_nomination_reminders(); end $$;
reset role;
do $$
declare fa uuid := '11111111-1111-1111-1111-111111111111'; expected bigint;
begin
  select count(*) into expected from users
    where farm_id = fa and role in ('owner','manager') and active and deleted_at is null and coalesce(notify_inapp, true);
  if _t_notif(fa, 'aarto_nomination_due') <> expected then
    raise exception 'AARTO DEDUPE FAIL: Farm A count changed on re-run (now %, expected %)',
      _t_notif(fa, 'aarto_nomination_due'), expected;
  end if;
end $$;

select 'ALL G2 AARTO-FINE-WORKFLOW TESTS PASSED' as result;

-- ═══ G1: BUDGETS & UTILISATION/DOWNTIME ANALYTICS (0360–0361, appended) ═══
-- Proves:
--   (a) `budgets` is tenant-isolated (own-farm visible, cross-tenant = 0, workshop scoped
--       to its linked farm, rr_admin sees all, anon covered in the anon sweep); a
--       cross-tenant budget WRITE is rejected.
--   (b) downtime (0361) is reconstructed from the audit_log status trail under RLS: a
--       Farm A owner sees a Farm A machine's down-days; a Farm B owner sees 0 for it
--       (audit_log is farm-scoped); anon cannot execute the function.
-- Fresh fixtures appended at the end — nothing above is disturbed.
-- ═════════════════════════════════════════════════════════════════

-- ── Fixtures (superuser; RLS bypassed) ────────────────────────────
-- Farm A: one machine-scoped budget + one whole-farm budget; Farm B: one machine budget.
insert into budgets (id, farm_id, machine_id, category, period_type, period_start, period_end, amount_cents) values
  ('b6a00000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 'parts', 'month',   date '2026-06-01', date '2026-06-30', 500000),
  ('b6a00000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', null,                                   null,    'quarter', date '2026-04-01', date '2026-06-30', 5000000),
  ('b6b00000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 'parts', 'month',   date '2026-06-01', date '2026-06-30', 400000);

-- ── (a) budgets isolation ─────────────────────────────────────────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A
  perform _t_assert('budgets', 2, 'ownerA');                  -- both Farm A budgets
  execute $q$ select count(*) from budgets where farm_id <> '11111111-1111-1111-1111-111111111111' $q$ into c;
  if c <> 0 then raise exception 'BUDGET ISOLATION FAIL [ownerA]: sees % non-Farm-A budgets', c; end if;
end $$;
do $$ begin perform _t_login('b2222222-2222-2222-2222-222222222222'); perform _t_assert('budgets', 1, 'ownerB');    end $$;
do $$ begin perform _t_login('c3333333-3333-3333-3333-333333333333'); -- Budgets are the farm's spending targets. A contractor seeing them could price against
-- what the farm has left in the year — off by default (F16 / 0400).
  perform _t_assert('budgets', 0, 'workshopW'); end $$;
do $$ begin perform _t_login('d4444444-4444-4444-4444-444444444444'); perform _t_assert('budgets', 3, 'rrAdmin');   end $$;
reset role;

-- (a) cross-tenant budget WRITE is rejected (Owner A → a Farm B budget).
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  begin
    insert into budgets (farm_id, machine_id, period_type, period_start, period_end, amount_cents)
      values ('22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 'month', date '2026-07-01', date '2026-07-31', 100000);
  exception when others then ok := true; end;
  if not ok then raise exception 'BUDGET ISOLATION FAIL [ownerA]: wrote a budget into Farm B'; end if;
end $$;
reset role;

-- (a) anon sees nothing and cannot write budgets.
set role anon;
do $$ declare c bigint; begin
  perform set_config('request.jwt.claims', '', false);
  begin execute 'select count(*) from public.budgets' into c;
  exception when insufficient_privilege then c := 0; end;
  if c <> 0 then raise exception 'BUDGET ISOLATION FAIL [anon]: sees % budgets', c; end if;
  begin
    insert into budgets (farm_id, machine_id, period_type, period_start, period_end, amount_cents)
      values ('11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 'month', date '2026-07-01', date '2026-07-31', 100000);
    raise exception 'BUDGET ISOLATION FAIL [anon]: inserted a budget';
  exception
    when insufficient_privilege then null;                    -- expected
    when others then if sqlstate = 'P0001' then raise; end if;
  end;
end $$;
reset role;

-- ── (b) downtime reconstruction + isolation (0361) ────────────────
-- A fresh Farm A machine that went into the workshop 10 days ago (synthetic audit trail).
insert into machines (id, farm_id, name, type, status) values
  ('a6100000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Downtime A', 'tractor', 'active');
insert into audit_log (farm_id, entity, entity_id, action, diff, at) values
  ('11111111-1111-1111-1111-111111111111', 'machines', 'a6100000-0000-0000-0000-000000000001', 'update',
   jsonb_build_object('old', jsonb_build_object('status','active'), 'new', jsonb_build_object('status','in_workshop')),
   now() - interval '10 days');

set role authenticated;
do $$ declare d numeric; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');   -- Owner A (same farm)
  d := app.machine_downtime_days('a6100000-0000-0000-0000-000000000001', (current_date - 90), current_date);
  if d is null or d < 5 or d > 15 then
    raise exception 'DOWNTIME FAIL [ownerA]: down_days = % (expected ~10)', d;
  end if;
end $$;
do $$ declare d numeric; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');   -- Owner B (other farm)
  d := app.machine_downtime_days('a6100000-0000-0000-0000-000000000001', (current_date - 90), current_date);
  if d <> 0 then
    raise exception 'DOWNTIME ISOLATION FAIL [ownerB]: sees % down-days for a Farm A machine (expected 0)', d;
  end if;
end $$;
reset role;

-- (b) anon cannot execute the downtime functions (execute revoked).
set role anon;
do $$
declare calls text[] := array[
  'select public.machine_downtime_days(''a6100000-0000-0000-0000-000000000001'', current_date - 90, current_date)',
  'select * from public.fleet_downtime(current_date - 90, current_date)'
]; c text;
begin
  perform set_config('request.jwt.claims', '', false);
  foreach c in array calls loop
    begin
      execute c;
      raise exception 'DOWNTIME PRIV FAIL: anon executed % without a privilege error', c;
    exception
      when insufficient_privilege then null;                  -- expected
      when others then if sqlstate = 'P0001' then raise; end if;
    end;
  end loop;
end $$;
reset role;

select 'ALL G1 BUDGETS & ANALYTICS TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- F14 — PARTNER DOCUMENTS (quotes & invoices, branding, plans)
-- ═════════════════════════════════════════════════════════════════
-- What this section has to prove, because the app relies on all of it:
--   (a) a farm sees the documents raised against IT and nobody else's;
--   (b) two contractors serving the SAME farm never see each other's pricing;
--   (c) an operator sees no documents at all — a driver is not in the payables;
--   (d) an invoice reaches the cost ledger EXACTLY ONCE, and a quote never does;
--   (e) a partner invoice document standing over a work request's own amount does not
--       double-count that job;
--   (f) totals are derived, not typed — lines roll up, payments roll up, status follows;
--   (g) anon can do nothing, and cannot allocate a document number;
--   (h) a partner cannot promote its own plan, and cannot burn another partner's
--       numbering sequence;
--   (i) a partner may edit its OWN letterhead and no other workshop's.
--
-- Reuses the F12c fixtures: Workshop W (portal, linked to Farm A + Farm E) and
-- Workshop X (managed, linked to the SHARED Farm A).

-- Documents: W bills Farm A; X quotes Farm A (the shared-farm privacy case); W quotes
-- Farm E. The W→Farm A invoice is attached to X's… no: to W's own Farm A request, so the
-- double-count rule has something real to stand over.
insert into partner_documents
  (id, farm_id, workshop_id, machine_id, work_request_id, kind, status, source, number, subject, vat_rate_bps, created_by)
values
  ('f1400000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333', 'aa111111-1111-1111-1111-111111111111',
   'd1000000-0000-0000-0000-0000000000a1', 'invoice', 'draft', 'built', 'INV-9001', 'W bills Farm A', 1500, null),
  ('f1400000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'e3000000-0000-0000-0000-0000000000e3', null, null,
   'quote', 'sent', 'built', 'QTE-9002', 'X quotes Farm A', 1500, null),
  ('f1400000-0000-0000-0000-000000000003', 'e1000000-0000-0000-0000-0000000000e1',
   '33333333-3333-3333-3333-333333333333', 'ee100000-0000-0000-0000-0000000000e1', null,
   'quote', 'sent', 'built', 'QTE-9003', 'W quotes Farm E', 1500, null);

-- (f) Lines roll up: 2 × R500 + 3.5h × R400 = R1000 + R1400 = R2400 ex-VAT, R2760 incl.
insert into partner_document_lines (farm_id, document_id, sort_order, kind, description, qty, unit_price_cents)
values
  ('11111111-1111-1111-1111-111111111111', 'f1400000-0000-0000-0000-000000000001', 0, 'part',   'Filter kit', 2,   50000),
  ('11111111-1111-1111-1111-111111111111', 'f1400000-0000-0000-0000-000000000001', 1, 'labour', 'Workshop hours', 3.5, 40000);

do $$ declare sub bigint; vat bigint; tot bigint; begin
  select subtotal_cents, vat_cents, total_cents into sub, vat, tot
    from partner_documents where id = 'f1400000-0000-0000-0000-000000000001';
  if sub <> 240000 then raise exception 'F14 FAIL [subtotal]: % (expected 240000)', sub; end if;
  if vat <> 36000  then raise exception 'F14 FAIL [vat]: % (expected 36000)', vat; end if;
  if tot <> 276000 then raise exception 'F14 FAIL [total]: % (expected 276000)', tot; end if;
end $$;

-- (d) A DRAFT invoice is not money owed — nothing in the ledger yet.
do $$ declare c bigint; begin
  select count(*) into c from cost_entries
   where source_type = 'partner_document' and source_id = 'f1400000-0000-0000-0000-000000000001' and deleted_at is null;
  if c <> 0 then raise exception 'F14 FAIL [draft costed]: % ledger rows for a draft invoice (expected 0)', c; end if;
end $$;

-- (d) A sent QUOTE is never costed either.
do $$ declare c bigint; begin
  select count(*) into c from cost_entries
   where source_type = 'partner_document' and source_id = 'f1400000-0000-0000-0000-000000000002' and deleted_at is null;
  if c <> 0 then raise exception 'F14 FAIL [quote costed]: a quote reached the cost ledger'; end if;
end $$;

-- (e) Set the work request's own invoice amount FIRST, so 0311 books an entry — then
-- issue the partner invoice over the top and prove the job is costed exactly once.
update work_requests set invoice_amount_cents = 999900, vat_rate_bps = 1500
  where id = 'd1000000-0000-0000-0000-0000000000a1';

do $$ declare c bigint; begin
  select count(*) into c from cost_entries
   where source_type = 'work_request' and source_id = 'd1000000-0000-0000-0000-0000000000a1' and deleted_at is null;
  if c <> 1 then raise exception 'F14 FAIL [precondition]: work-request entry count=% (expected 1)', c; end if;
end $$;

update partner_documents set status = 'sent', sent_at = now()
  where id = 'f1400000-0000-0000-0000-000000000001';

do $$ declare wr bigint; pd bigint; amt bigint; begin
  select count(*) into wr from cost_entries
   where source_type = 'work_request' and source_id = 'd1000000-0000-0000-0000-0000000000a1' and deleted_at is null;
  select count(*) into pd from cost_entries
   where source_type = 'partner_document' and source_id = 'f1400000-0000-0000-0000-000000000001' and deleted_at is null;
  if wr <> 0 then raise exception 'F14 FAIL [double count]: the work-request entry survived (%) alongside the invoice document', wr; end if;
  if pd <> 1 then raise exception 'F14 FAIL [invoice once]: partner-document entries=% (expected 1)', pd; end if;

  -- Booked EX-VAT, like every other entry in the ledger.
  select amount_cents into amt from cost_entries
   where source_type = 'partner_document' and source_id = 'f1400000-0000-0000-0000-000000000001' and deleted_at is null;
  if amt <> 240000 then raise exception 'F14 FAIL [ex-VAT]: booked % (expected 240000 ex-VAT)', amt; end if;
end $$;

-- Re-firing the trigger must not duplicate.
update partner_documents set subject = 'W bills Farm A (edited)' where id = 'f1400000-0000-0000-0000-000000000001';
do $$ declare c bigint; begin
  select count(*) into c from cost_entries
   where source_type = 'partner_document' and source_id = 'f1400000-0000-0000-0000-000000000001';
  if c <> 1 then raise exception 'F14 FAIL [idempotent]: % ledger rows after re-fire (expected 1)', c; end if;
end $$;

-- (f) Payments roll up and move the status; a part payment is part_paid, the rest paid.
insert into partner_payments (farm_id, document_id, amount_cents, paid_on, method)
values ('11111111-1111-1111-1111-111111111111', 'f1400000-0000-0000-0000-000000000001', 100000, current_date, 'eft');
do $$ declare s text; paid bigint; begin
  select status, amount_paid_cents into s, paid from partner_documents where id = 'f1400000-0000-0000-0000-000000000001';
  if s <> 'part_paid' then raise exception 'F14 FAIL [part_paid]: status=% (expected part_paid)', s; end if;
  if paid <> 100000 then raise exception 'F14 FAIL [paid rollup]: % (expected 100000)', paid; end if;
end $$;
insert into partner_payments (farm_id, document_id, amount_cents, paid_on, method)
values ('11111111-1111-1111-1111-111111111111', 'f1400000-0000-0000-0000-000000000001', 176000, current_date, 'eft');
do $$ declare s text; begin
  select status into s from partner_documents where id = 'f1400000-0000-0000-0000-000000000001';
  if s <> 'paid' then raise exception 'F14 FAIL [paid]: status=% (expected paid)', s; end if;
end $$;
-- Paid in full is still a cost — it does not vanish from the ledger once settled.
do $$ declare c bigint; begin
  select count(*) into c from cost_entries
   where source_type = 'partner_document' and source_id = 'f1400000-0000-0000-0000-000000000001' and deleted_at is null;
  if c <> 1 then raise exception 'F14 FAIL [paid still costed]: % (expected 1)', c; end if;
end $$;

-- Cancelling stands the ledger entry down without erasing the document.
update partner_documents set status = 'cancelled' where id = 'f1400000-0000-0000-0000-000000000001';
do $$ declare c bigint; begin
  select count(*) into c from cost_entries
   where source_type = 'partner_document' and source_id = 'f1400000-0000-0000-0000-000000000001' and deleted_at is null;
  if c <> 0 then raise exception 'F14 FAIL [cancel]: cancelled invoice still costed'; end if;
end $$;
update partner_documents set status = 'sent' where id = 'f1400000-0000-0000-0000-000000000001';  -- restore

-- ── (a)(b)(c) visibility ──────────────────────────────────────────
set role authenticated;

-- Farm A's owner sees BOTH documents raised against Farm A (W's invoice + X's quote) and
-- neither of Farm E's.
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');            -- Owner A
  select count(*) into c from partner_documents;
  if c <> 2 then raise exception 'F14 FAIL [ownerA]: sees % documents (expected 2)', c; end if;
end $$;

-- A partner's DRAFT is their working copy, not correspondence (0383). Found by driving
-- the built app: an unsent draft was showing in the farmer's list while the partner was
-- still pricing it.
reset role;
insert into partner_documents
  (id, farm_id, workshop_id, kind, status, source, number, subject, vat_rate_bps)
values
  ('f1400000-0000-0000-0000-00000000000d', '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333', 'invoice', 'draft', 'built', 'INV-9004',
   'W still pricing this', 1500);
insert into partner_document_lines (farm_id, document_id, sort_order, kind, description, qty, unit_price_cents)
values ('11111111-1111-1111-1111-111111111111', 'f1400000-0000-0000-0000-00000000000d', 0, 'part', 'Secret pricing', 1, 99999);
set role authenticated;

do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');            -- Owner A
  select count(*) into c from partner_documents where id = 'f1400000-0000-0000-0000-00000000000d';
  if c <> 0 then raise exception 'F14 FAIL [DRAFT LEAK]: the farmer can see the partner''s unsent draft'; end if;
  -- …and not its line items either, which is the number that actually matters.
  select count(*) into c from partner_document_lines where description = 'Secret pricing';
  if c <> 0 then raise exception 'F14 FAIL [DRAFT LINE LEAK]: the farmer can see an unsent draft''s pricing'; end if;

  perform _t_login('c3333333-3333-3333-3333-333333333333');            -- Workshop W
  select count(*) into c from partner_documents where id = 'f1400000-0000-0000-0000-00000000000d';
  if c <> 1 then raise exception 'F14 FAIL [own draft]: the issuing partner cannot see its own draft'; end if;
end $$;

-- Farm B's owner sees none of them.
do $$ declare c bigint; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');            -- Owner B
  select count(*) into c from partner_documents;
  if c <> 0 then raise exception 'F14 FAIL [ownerB cross-tenant]: sees % documents (expected 0)', c; end if;
end $$;

-- (b) THE PRIVACY CASE. Workshop W is linked to Farm A, and so is Workshop X. W must see
-- its OWN two documents (Farm A invoice + Farm E quote) and NOT X's Farm A quote — even
-- though W has full farm access to Farm A.
do $$ declare c bigint; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');            -- Workshop W
  select count(*) into c from partner_documents;
  -- Its Farm A invoice, its Farm E quote, and its own unsent draft.
  if c <> 3 then raise exception 'F14 FAIL [W scope]: sees % documents (expected its own 3)', c; end if;
  select count(*) into c from partner_documents where id = 'f1400000-0000-0000-0000-000000000002';
  if c <> 0 then raise exception 'F14 FAIL [PRICING LEAK]: Workshop W can see Workshop X''s quote on a shared farm';
  end if;
end $$;

-- X sees only its own, on the one farm it serves.
do $$ declare c bigint; begin
  perform _t_login('e4000000-0000-0000-0000-0000000000e4');            -- Workshop X
  select count(*) into c from partner_documents;
  if c <> 1 then raise exception 'F14 FAIL [X scope]: sees % documents (expected 1)', c; end if;
end $$;

-- (c) An operator on Farm A sees no documents at all.
do $$ declare c bigint; begin
  perform _t_login('a0000000-0000-0000-0000-0000000000a9');            -- Operator A
  select count(*) into c from partner_documents;
  if c <> 0 then raise exception 'F14 FAIL [operator]: a driver sees % documents (expected 0)', c; end if;
  select count(*) into c from partner_document_lines;
  if c <> 0 then raise exception 'F14 FAIL [operator lines]: a driver sees % lines (expected 0)', c; end if;
  select count(*) into c from partner_payments;
  if c <> 0 then raise exception 'F14 FAIL [operator payments]: a driver sees % payments (expected 0)', c; end if;
end $$;

-- Child rows follow the parent: Owner A sees the invoice's 2 lines; Workshop X sees none
-- of them (they belong to W's document).
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');
  select count(*) into c from partner_document_lines;
  if c <> 2 then raise exception 'F14 FAIL [ownerA lines]: % (expected 2)', c; end if;
  perform _t_login('e4000000-0000-0000-0000-0000000000e4');            -- Workshop X
  select count(*) into c from partner_document_lines;
  if c <> 0 then raise exception 'F14 FAIL [X lines leak]: % (expected 0)', c; end if;
end $$;

-- ── Cross-tenant writes are rejected ──────────────────────────────
do $$ begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');            -- Owner B
  begin
    insert into partner_documents (farm_id, workshop_id, kind, status, source, number, vat_rate_bps)
    values ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
            'invoice', 'draft', 'built', 'INV-HACK', 1500);
    raise exception 'F14 FAIL [cross-tenant insert]: Owner B raised a document on Farm A';
  exception
    when insufficient_privilege then null;
    when others then if sqlstate <> '42501' then raise; end if;
  end;
end $$;

-- An operator cannot raise one on their own farm either.
do $$ begin
  perform _t_login('a0000000-0000-0000-0000-0000000000a9');            -- Operator A
  begin
    insert into partner_documents (farm_id, workshop_id, kind, status, source, number, vat_rate_bps)
    values ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
            'invoice', 'draft', 'built', 'INV-OP', 1500);
    raise exception 'F14 FAIL [operator insert]: a driver raised an invoice';
  exception
    when insufficient_privilege then null;
    when others then if sqlstate <> '42501' then raise; end if;
  end;
end $$;

-- (h) A partner cannot promote its own plan (the 0380/0382 guard trigger).
do $$ begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');            -- Workshop W
  begin
    update workshops set plan = 'managed' where id = '33333333-3333-3333-3333-333333333333';
    raise exception 'F14 FAIL [self-upgrade]: a partner set its own plan';
  exception
    when raise_exception then
      if position('set by Rapid Rise' in sqlerrm) = 0 then raise; end if;
  end;
end $$;

-- (i) …but it MAY maintain its own letterhead, and only its own.
do $$ declare c bigint; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');            -- Workshop W
  update workshops set trading_name = 'W Diesel & Turbo', brand_primary = '#0f3d2e'
    where id = '33333333-3333-3333-3333-333333333333';
  select count(*) into c from workshops
   where id = '33333333-3333-3333-3333-333333333333' and trading_name = 'W Diesel & Turbo';
  if c <> 1 then raise exception 'F14 FAIL [own branding]: a partner could not set its own letterhead'; end if;

  -- Workshop X's row is not W's to touch. RLS makes it invisible to the UPDATE, so the
  -- statement affects zero rows rather than raising — assert the value did not move.
  update workshops set trading_name = 'HACKED' where id = 'e3000000-0000-0000-0000-0000000000e3';
end $$;
reset role;
do $$ declare n text; begin
  select trading_name into n from workshops where id = 'e3000000-0000-0000-0000-0000000000e3';
  if n is not distinct from 'HACKED' then
    raise exception 'F14 FAIL [BRANDING LEAK]: Workshop W rewrote Workshop X''s letterhead';
  end if;
end $$;

-- (h) A partner cannot burn another partner's numbering sequence.
set role authenticated;
do $$ declare v text; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');            -- Workshop W
  v := public.next_document_number('33333333-3333-3333-3333-333333333333', 'invoice');
  if v is null or v = '' then raise exception 'F14 FAIL [own numbering]: W could not allocate its own number'; end if;
  begin
    v := public.next_document_number('e3000000-0000-0000-0000-0000000000e3', 'invoice');
    raise exception 'F14 FAIL [numbering leak]: W allocated a number on X''s sequence';
  exception
    when raise_exception then
      if position('not your numbering' in sqlerrm) = 0 then raise; end if;
  end;
end $$;

-- Numbers are per-partner and never repeat.
do $$ declare a text; b text; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');
  a := public.next_document_number('33333333-3333-3333-3333-333333333333', 'quote');
  b := public.next_document_number('33333333-3333-3333-3333-333333333333', 'quote');
  if a = b then raise exception 'F14 FAIL [numbering repeat]: two allocations both returned %', a; end if;
end $$;

-- 0384: the allocator SKIPS a number already in use. Found by driving the built app —
-- the counter and the rows had drifted apart (demo rows inserted directly; the same
-- happens after a restore or an import), and pressing "Start it" failed with a raw
-- Postgres unique-violation and created nothing.
reset role;
-- Park a document on the number the counter is about to hand out.
do $$ declare v_next int; v_prefix text; begin
  select next_invoice_no, doc_prefix_invoice into v_next, v_prefix
    from workshops where id = '33333333-3333-3333-3333-333333333333';
  insert into partner_documents (farm_id, workshop_id, kind, status, source, number, vat_rate_bps)
  values ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
          'invoice', 'draft', 'built', v_prefix || '-' || lpad(v_next::text, 4, '0'), 1500);
end $$;
set role authenticated;
do $$ declare v text; c bigint; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');
  v := public.next_document_number('33333333-3333-3333-3333-333333333333', 'invoice');
  select count(*) into c from partner_documents
   where workshop_id = '33333333-3333-3333-3333-333333333333' and kind = 'invoice' and number = v;
  if c <> 0 then
    raise exception 'F14 FAIL [numbering collision]: allocator returned %, which is already in use', v;
  end if;
end $$;
reset role;
set role authenticated;
reset role;

-- ── (g) anon can do nothing ───────────────────────────────────────
set role anon;
do $$ declare c bigint; begin
  perform set_config('request.jwt.claims', '', false);
  begin
    select count(*) into c from partner_documents;
    if c <> 0 then raise exception 'F14 FAIL [anon read]: anon saw % documents', c; end if;
  exception
    when insufficient_privilege then null;                              -- also acceptable
  end;
end $$;
do $$ begin
  begin
    perform public.next_document_number('33333333-3333-3333-3333-333333333333', 'invoice');
    raise exception 'F14 FAIL [anon numbering]: anon allocated a document number';
  exception
    when insufficient_privilege then null;                              -- expected
    when others then if sqlstate = 'P0001' then raise; end if;
  end;
end $$;
reset role;

select 'ALL F14 PARTNER-DOCUMENT TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- F15 — PARTNER CLIENT BOOK + the connect handshake
-- ═════════════════════════════════════════════════════════════════
-- `partner_clients` / `partner_client_vehicles` are the FIRST tables scoped to a
-- WORKSHOP rather than a farm, so the claims that matter are:
--   (a) a partner sees only its own book — not another partner's;
--   (b) a FARM user cannot read a partner's private notes about them;
--   (c) writing a client row grants NOTHING: setting farm_id on one does not let the
--       partner read that farm;
--   (d) a partner may RAISE a pending link, and pending grants nothing;
--   (e) a partner CANNOT promote its own request to active — only the farm can;
--   (f) anon sees nothing.
--
-- Reuses Workshop W (linked to Farm A + Farm E) and Workshop X (linked to Farm A).

insert into partner_clients (id, workshop_id, name, email) values
  ('f1500000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'W''s client — Farm B', 'ownerB@test'),
  ('f1500000-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333', 'W''s offline client', null),
  ('f1500000-0000-0000-0000-000000000003', 'e3000000-0000-0000-0000-0000000000e3', 'X''s own client', null);

insert into partner_client_vehicles (id, workshop_id, client_id, name, reg_no) values
  ('f1510000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333',
   'f1500000-0000-0000-0000-000000000002', 'Blue Hilux', 'ADT 441 FS');

set role authenticated;

-- (a) Each partner sees only its own book.
do $$ declare c bigint; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');            -- Workshop W
  select count(*) into c from partner_clients;
  if c <> 2 then raise exception 'F15 FAIL [W book]: sees % clients (expected its own 2)', c; end if;
  select count(*) into c from partner_client_vehicles;
  if c <> 1 then raise exception 'F15 FAIL [W vehicles]: sees % (expected 1)', c; end if;

  perform _t_login('e4000000-0000-0000-0000-0000000000e4');            -- Workshop X
  select count(*) into c from partner_clients;
  if c <> 1 then raise exception 'F15 FAIL [X book]: sees % clients (expected its own 1)', c; end if;
  select count(*) into c from partner_client_vehicles;
  if c <> 0 then raise exception 'F15 FAIL [BOOK LEAK]: X sees W''s notebook vehicles'; end if;
end $$;

-- (b) A farm user cannot read a partner's private notes about them — including the
--     farm that is literally the subject of the row.
do $$ declare c bigint; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');            -- Owner B (the subject)
  select count(*) into c from partner_clients;
  if c <> 0 then raise exception 'F15 FAIL [farm reads partner notes]: sees % rows (expected 0)', c; end if;

  perform _t_login('a1111111-1111-1111-1111-111111111111');            -- Owner A
  select count(*) into c from partner_clients;
  if c <> 0 then raise exception 'F15 FAIL [farm reads partner notes]: Owner A sees % rows', c; end if;
end $$;

-- A partner cannot write into another partner's book.
do $$ begin
  perform _t_login('e4000000-0000-0000-0000-0000000000e4');            -- Workshop X
  begin
    insert into partner_clients (workshop_id, name)
    values ('33333333-3333-3333-3333-333333333333', 'planted by X');
    raise exception 'F15 FAIL [cross-partner write]: X wrote into W''s book';
  exception
    when insufficient_privilege then null;
    when others then if sqlstate <> '42501' then raise; end if;
  end;
end $$;

-- (c) THE LOAD-BEARING ONE. A partner setting farm_id on its own client row must gain
--     nothing: access comes from an ACTIVE workshop_link and nowhere else.
do $$ declare c bigint; begin
  perform _t_login('e4000000-0000-0000-0000-0000000000e4');            -- Workshop X (NOT linked to Farm B)
  update partner_clients set farm_id = '22222222-2222-2222-2222-222222222222'
    where id = 'f1500000-0000-0000-0000-000000000003';

  select count(*) into c from machines where farm_id = '22222222-2222-2222-2222-222222222222';
  if c <> 0 then
    raise exception 'F15 FAIL [PRIVILEGE ESCALATION]: pointing a client row at Farm B let X see % of its machines', c;
  end if;
  if app.has_farm_access('22222222-2222-2222-2222-222222222222') then
    raise exception 'F15 FAIL [PRIVILEGE ESCALATION]: has_farm_access true for a farm X only wrote a note about';
  end if;
end $$;
reset role;
update partner_clients set farm_id = null where id = 'f1500000-0000-0000-0000-000000000003';
set role authenticated;

-- (d) A partner may RAISE a pending link — and pending grants nothing.
do $$ declare c bigint; begin
  perform _t_login('e4000000-0000-0000-0000-0000000000e4');            -- Workshop X
  insert into workshop_links (workshop_id, farm_id, status)
  values ('e3000000-0000-0000-0000-0000000000e3', '22222222-2222-2222-2222-222222222222', 'pending');

  if app.has_farm_access('22222222-2222-2222-2222-222222222222') then
    raise exception 'F15 FAIL [pending grants access]: a pending link opened Farm B to X';
  end if;
  select count(*) into c from machines where farm_id = '22222222-2222-2222-2222-222222222222';
  if c <> 0 then raise exception 'F15 FAIL [pending grants access]: X sees % Farm B machines', c; end if;
end $$;

-- …and cannot raise an ACTIVE one, nor one for somebody else's workshop.
do $$ begin
  perform _t_login('e4000000-0000-0000-0000-0000000000e4');
  begin
    insert into workshop_links (workshop_id, farm_id, status)
    values ('e3000000-0000-0000-0000-0000000000e3', 'e1000000-0000-0000-0000-0000000000e1', 'active');
    raise exception 'F15 FAIL [self-grant]: a partner inserted an ACTIVE link';
  exception
    when insufficient_privilege then null;
    when others then if sqlstate <> '42501' then raise; end if;
  end;

  begin
    insert into workshop_links (workshop_id, farm_id, status)
    values ('33333333-3333-3333-3333-333333333333', 'e1000000-0000-0000-0000-0000000000e1', 'pending');
    raise exception 'F15 FAIL [impersonation]: X raised a request on behalf of W';
  exception
    when insufficient_privilege then null;
    when others then if sqlstate <> '42501' then raise; end if;
  end;
end $$;

-- (e) A partner cannot PROMOTE its own pending request. Only the farm can. RLS makes the
--     row invisible to X's UPDATE rather than raising, so assert the value did not move.
do $$ begin
  perform _t_login('e4000000-0000-0000-0000-0000000000e4');
  update workshop_links set status = 'active'
    where workshop_id = 'e3000000-0000-0000-0000-0000000000e3'
      and farm_id = '22222222-2222-2222-2222-222222222222';
end $$;
reset role;
do $$ declare s text; begin
  select status into s from workshop_links
   where workshop_id = 'e3000000-0000-0000-0000-0000000000e3'
     and farm_id = '22222222-2222-2222-2222-222222222222';
  if s <> 'pending' then
    raise exception 'F15 FAIL [SELF-APPROVAL]: a partner promoted its own request to %', s;
  end if;
end $$;

-- The FARM can, and that is what actually opens the door.
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');            -- Owner B
  update workshop_links set status = 'active'
    where workshop_id = 'e3000000-0000-0000-0000-0000000000e3'
      and farm_id = '22222222-2222-2222-2222-222222222222';

  perform _t_login('e4000000-0000-0000-0000-0000000000e4');            -- Workshop X again
  if not app.has_farm_access('22222222-2222-2222-2222-222222222222') then
    raise exception 'F15 FAIL [approval]: the farm approved but X still has no access';
  end if;
  -- …but approval alone is not a key to the whole farm (F16 / 0400). X is working on
  -- nothing there yet, and the farm granted no extra scope, so the fleet stays closed.
  select count(*) into c from machines where farm_id = '22222222-2222-2222-2222-222222222222';
  if c <> 0 then
    raise exception 'F16 FAIL [approval too broad]: a bare approval showed X % machines', c;
  end if;
end $$;

-- The farm turning ON "see the whole fleet" is what opens it — and only that.
reset role;
update workshop_links set see_all_vehicles = true
  where workshop_id = 'e3000000-0000-0000-0000-0000000000e3'
    and farm_id = '22222222-2222-2222-2222-222222222222';
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('e4000000-0000-0000-0000-0000000000e4');
  select count(*) into c from machines where farm_id = '22222222-2222-2222-2222-222222222222';
  if c < 1 then raise exception 'F16 FAIL [grant ignored]: see_all_vehicles did not open the fleet'; end if;
  -- Costs are a separate grant and were NOT given.
  select count(*) into c from cost_entries where farm_id = '22222222-2222-2222-2222-222222222222';
  if c <> 0 then raise exception 'F16 FAIL [grant bleed]: the vehicles grant also exposed % cost rows', c; end if;
end $$;
reset role;
update workshop_links set see_all_vehicles = false
  where workshop_id = 'e3000000-0000-0000-0000-0000000000e3'
    and farm_id = '22222222-2222-2222-2222-222222222222';
set role authenticated;
reset role;
-- Put Farm B back as it was, so later sections keep their counts.
update workshop_links set status = 'revoked'
  where workshop_id = 'e3000000-0000-0000-0000-0000000000e3'
    and farm_id = '22222222-2222-2222-2222-222222222222';

-- (g) 0391: a farm can READ the card of a contractor asking to connect — otherwise the
--     request renders as an empty row and cannot be decided. It is the contractor's own
--     business card, offered to the one farm they asked, and it grants nothing.
-- X's request to Farm B was revoked above; put it back to pending for this check.
update workshop_links set status = 'pending'
  where workshop_id = 'e3000000-0000-0000-0000-0000000000e3'
    and farm_id = '22222222-2222-2222-2222-222222222222';

set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');            -- Owner B
  select count(*) into c from workshops where id = 'e3000000-0000-0000-0000-0000000000e3';
  if c <> 1 then
    raise exception 'F15 FAIL [nameless request]: the farm cannot see who is asking to connect';
  end if;
  -- …and reading the card still grants nothing.
  if app.has_farm_access('e1000000-0000-0000-0000-0000000000e1') then
    raise exception 'F15 FAIL [card grants access]: reading a contractor card widened farm access';
  end if;
end $$;

-- The negative: a farm with NO link of any status to a contractor still cannot see them.
-- Farm B has never been linked to Workshop W.
do $$ declare c bigint; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');            -- Owner B
  select count(*) into c from workshops where id = '33333333-3333-3333-3333-333333333333';
  if c <> 0 then
    raise exception 'F15 FAIL [card leak]: Farm B can read Workshop W, which never asked it';
  end if;
end $$;
reset role;
update workshop_links set status = 'revoked'
  where workshop_id = 'e3000000-0000-0000-0000-0000000000e3'
    and farm_id = '22222222-2222-2222-2222-222222222222';

-- (f) anon sees nothing.
set role anon;
do $$ declare c bigint; begin
  perform set_config('request.jwt.claims', '', false);
  begin
    select count(*) into c from partner_clients;
    if c <> 0 then raise exception 'F15 FAIL [anon]: anon saw % client rows', c; end if;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- (h) 0392: a contractor must NOT be able to read a competitor's card.
--     `app.has_farm_access` returns true for a workshop with an active link, so the
--     workshops_sel link clause had to be gated on being farm-side. Both W and X are
--     linked to Farm A, which is exactly the shape that leaked.
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');            -- Workshop W
  select count(*) into c from workshops where id = 'e3000000-0000-0000-0000-0000000000e3';
  if c <> 0 then
    raise exception 'F15 FAIL [COMPETITOR CARD LEAK]: W can read X''s card on their shared farm';
  end if;

  -- …while still reading its OWN row, which the portal depends on.
  select count(*) into c from workshops where id = '33333333-3333-3333-3333-333333333333';
  if c <> 1 then raise exception 'F15 FAIL [own card]: a partner cannot read its own workshop row'; end if;
end $$;

-- The farm side still sees the contractors it works with — that must not have broken.
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');            -- Owner A
  select count(*) into c from workshops where id = 'e3000000-0000-0000-0000-0000000000e3';
  if c <> 1 then raise exception 'F15 FAIL [farm blinded]: Owner A cannot read a contractor linked to Farm A'; end if;
end $$;
reset role;

-- (i) 0392: an approval binds EXACTLY the client the request was aimed at. Two
--     outstanding requests from one workshop used to collide on (workshop_id, farm_id)
--     and abort the whole update after the link had already gone active.
insert into partner_clients (id, workshop_id, name, link_status, requested_farm_id, requested_at) values
  ('f1500000-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333',
   'W asks Farm A', 'requested', '11111111-1111-1111-1111-111111111111', now()),
  ('f1500000-0000-0000-0000-00000000000b', '33333333-3333-3333-3333-333333333333',
   'W asks Farm E', 'requested', 'e1000000-0000-0000-0000-0000000000e1', now());

-- What approveLinkRequest does for Farm A: bind only the row aimed at Farm A.
update partner_clients
   set farm_id = '11111111-1111-1111-1111-111111111111', link_status = 'linked', linked_at = now()
 where workshop_id = '33333333-3333-3333-3333-333333333333'
   and requested_farm_id = '11111111-1111-1111-1111-111111111111'
   and farm_id is null;

do $$ declare a text; b text; begin
  select link_status into a from partner_clients where id = 'f1500000-0000-0000-0000-00000000000a';
  select link_status into b from partner_clients where id = 'f1500000-0000-0000-0000-00000000000b';
  if a <> 'linked' then
    raise exception 'F15 FAIL [approval bound nothing]: the client aimed at Farm A is still %', a;
  end if;
  if b <> 'requested' then
    raise exception 'F15 FAIL [approval bound the wrong client]: the Farm E request became %', b;
  end if;
end $$;

select 'ALL F15 PARTNER-CLIENT-BOOK TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- F16 — PARTNER ACCESS SCOPE (0400)
-- ═════════════════════════════════════════════════════════════════
-- The claim: an active link is permission to do a JOB, not a key to the farm. What a
-- contractor sees is the farm's choice, defaulting to the minimum, and each grant opens
-- exactly its own slice and nothing else.
--
-- Fresh fixtures so the personas above keep their counts: Farm P, two machines, a
-- contractor (Workshop Y) linked to it with a work request on ONE of them.

insert into farms (id, name) values ('f1600000-0000-0000-0000-000000000001', 'Farm P');
insert into machines (id, farm_id, name, type) values
  ('f1610000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000001', 'P — theirs',     'tractor'),
  ('f1610000-0000-0000-0000-000000000002', 'f1600000-0000-0000-0000-000000000001', 'P — not theirs', 'bakkie');
insert into workshops (id, name, kind) values
  ('f1620000-0000-0000-0000-000000000001', 'Workshop Y', 'mechanic');
insert into workshop_links (workshop_id, farm_id, status) values
  ('f1620000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000001', 'active');
insert into auth.users (id, email) values ('f1630000-0000-0000-0000-000000000001', 'workshopY@test');
insert into users (id, farm_id, workshop_id, role, name, email, phone) values
  ('f1630000-0000-0000-0000-000000000001', null, 'f1620000-0000-0000-0000-000000000001', 'workshop', 'Y Staff', 'y@test', '+27820000009');
-- Farm P's own people, whose contact details are not the contractor's business.
insert into auth.users (id, email) values ('f1640000-0000-0000-0000-000000000001', 'ownerP@test');
insert into users (id, farm_id, role, name, email, phone) values
  ('f1640000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000001', 'owner', 'Owner P', 'ownerp@test', '+27820000010');
-- Y is assigned ONE machine.
insert into work_requests (id, farm_id, machine_id, workshop_id, kind, status, priority, title) values
  ('f1650000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000001',
   'f1610000-0000-0000-0000-000000000001', 'f1620000-0000-0000-0000-000000000001',
   'repair', 'requested', 'normal', 'Y works on this one');
-- Things the contractor must not see by default.
insert into cost_entries (farm_id, machine_id, type, amount_cents) values
  ('f1600000-0000-0000-0000-000000000001', 'f1610000-0000-0000-0000-000000000001', 'parts', 123400);
insert into meter_readings (farm_id, machine_id, reading, source) values
  ('f1600000-0000-0000-0000-000000000001', 'f1610000-0000-0000-0000-000000000001', 100, 'manual');
insert into partners (farm_id, is_suggested, name, kind, phone) values
  ('f1600000-0000-0000-0000-000000000001', false, 'A COMPETITOR', 'tyre', '+27820000011');

set role authenticated;

-- ── (a) The default: only the vehicle they were given ────────────────────────
do $$ declare c bigint; begin
  perform _t_login('f1630000-0000-0000-0000-000000000001');            -- Workshop Y
  select count(*) into c from machines where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 1 then raise exception 'F16 FAIL [default vehicles]: sees % (expected only the 1 it works on)', c; end if;

  select count(*) into c from machines where id = 'f1610000-0000-0000-0000-000000000002';
  if c <> 0 then raise exception 'F16 FAIL [default vehicles]: the machine it has no work on is visible'; end if;

  select count(*) into c from cost_entries where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 0 then raise exception 'F16 FAIL [default costs]: sees % cost rows (expected 0)', c; end if;

  select count(*) into c from meter_readings where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 0 then raise exception 'F16 FAIL [default history]: sees % meter readings (expected 0)', c; end if;

  -- Fuel draws carry a price, so they follow the money grant too (0402).
  select count(*) into c from fuel_issues where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 0 then raise exception 'F16 FAIL [default fuel]: sees % fuel draws (expected 0)', c; end if;

  select count(*) into c from users where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 0 then raise exception 'F16 FAIL [default team]: sees % of the farm''s people (expected 0)', c; end if;

  select count(*) into c from partners where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 0 then raise exception 'F16 FAIL [COMPETITOR LEAK]: sees % of the farm''s other contractors', c; end if;

  -- It can still do its job: its own work request is right there.
  select count(*) into c from work_requests where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 1 then raise exception 'F16 FAIL [too tight]: a contractor cannot see its own work request'; end if;
end $$;

-- ── (b) Each grant opens exactly its own slice ───────────────────────────────
reset role;
update workshop_links set see_all_vehicles = true
  where workshop_id = 'f1620000-0000-0000-0000-000000000001';
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('f1630000-0000-0000-0000-000000000001');
  select count(*) into c from machines where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 2 then raise exception 'F16 FAIL [vehicles grant]: sees % (expected the whole fleet, 2)', c; end if;
  select count(*) into c from cost_entries where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 0 then raise exception 'F16 FAIL [bleed]: the vehicles grant leaked % cost rows', c; end if;
  select count(*) into c from users where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 0 then raise exception 'F16 FAIL [bleed]: the vehicles grant leaked % people', c; end if;
end $$;

reset role;
update workshop_links set see_costs = true
  where workshop_id = 'f1620000-0000-0000-0000-000000000001';
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('f1630000-0000-0000-0000-000000000001');
  select count(*) into c from cost_entries where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 1 then raise exception 'F16 FAIL [costs grant]: sees % cost rows (expected 1)', c; end if;
  select count(*) into c from users where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 0 then raise exception 'F16 FAIL [bleed]: the costs grant leaked % people', c; end if;
end $$;

reset role;
update workshop_links set see_team = true, see_service_history = true
  where workshop_id = 'f1620000-0000-0000-0000-000000000001';
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('f1630000-0000-0000-0000-000000000001');
  select count(*) into c from users where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 1 then raise exception 'F16 FAIL [team grant]: sees % of the farm''s people (expected 1)', c; end if;
  select count(*) into c from meter_readings where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 1 then raise exception 'F16 FAIL [history grant]: sees % readings (expected 1)', c; end if;
  -- Even with EVERY grant on, the farm's other contractors stay invisible. There is no
  -- setting for it, by design.
  select count(*) into c from partners where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 0 then
    raise exception 'F16 FAIL [COMPETITOR LEAK]: with all grants on, a contractor sees % of the farm''s partners', c;
  end if;
end $$;

-- ── (c) A contractor cannot grant itself anything ────────────────────────────
do $$ begin
  perform _t_login('f1630000-0000-0000-0000-000000000001');
  update workshop_links set see_costs = true, see_team = true
    where workshop_id = 'f1620000-0000-0000-0000-000000000001';
end $$;
reset role;
update workshop_links set see_costs = false, see_team = false, see_service_history = false, see_all_vehicles = false
  where workshop_id = 'f1620000-0000-0000-0000-000000000001';
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('f1630000-0000-0000-0000-000000000001');
  -- Re-granting itself must not work: wl_upd covers rr_admin and the farm, never a
  -- workshop, so the write above affected nothing and this stays shut.
  update workshop_links set see_costs = true where workshop_id = 'f1620000-0000-0000-0000-000000000001';
  select count(*) into c from cost_entries where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 0 then
    raise exception 'F16 FAIL [SELF-GRANT]: a contractor granted itself cost visibility';
  end if;
end $$;
reset role;

-- ── (d) The farm side is completely unaffected ───────────────────────────────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('f1640000-0000-0000-0000-000000000001');            -- Owner P
  select count(*) into c from machines where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 2 then raise exception 'F16 FAIL [farm narrowed]: Owner P sees % of their own machines', c; end if;
  select count(*) into c from cost_entries where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 1 then raise exception 'F16 FAIL [farm narrowed]: Owner P sees % of their own costs', c; end if;
  select count(*) into c from partners where farm_id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 1 then raise exception 'F16 FAIL [farm narrowed]: Owner P sees % of their own partners', c; end if;
end $$;
reset role;

select 'ALL F16 PARTNER-ACCESS-SCOPE TESTS PASSED' as result;

-- ── F16b: a partner who is not VAT registered cannot issue VAT (0401) ────────
insert into workshops (id, name, kind, vat_registered) values
  ('f1660000-0000-0000-0000-000000000001', 'Small Operator', 'mechanic', false);
insert into workshop_links (workshop_id, farm_id, status) values
  ('f1660000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000001', 'active');

-- Try to issue at 15% anyway — the guard forces it to zero.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number, vat_rate_bps)
values ('f1670000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000001',
        'f1660000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'SO-0001', 1500);
insert into partner_document_lines (farm_id, document_id, sort_order, kind, description, qty, unit_price_cents)
values ('f1600000-0000-0000-0000-000000000001', 'f1670000-0000-0000-0000-000000000001', 0, 'labour', 'Two hours', 2, 50000);

do $$ declare r int; v bigint; tot bigint; sub bigint; begin
  select vat_rate_bps, vat_cents, total_cents, subtotal_cents into r, v, tot, sub
    from partner_documents where id = 'f1670000-0000-0000-0000-000000000001';
  if r <> 0 then raise exception 'F16b FAIL [vat forced]: a non-registered partner issued at % bps', r; end if;
  if v <> 0 then raise exception 'F16b FAIL [vat charged]: vat_cents = % on a non-registered partner''s invoice', v; end if;
  if tot <> sub then
    raise exception 'F16b FAIL [total]: total % <> subtotal % with no VAT', tot, sub;
  end if;
end $$;

-- A registered partner is untouched.
do $$ declare r int; begin
  update partner_documents set vat_rate_bps = 1500 where id = 'f1400000-0000-0000-0000-000000000001';
  select vat_rate_bps into r from partner_documents where id = 'f1400000-0000-0000-0000-000000000001';
  if r <> 1500 then raise exception 'F16b FAIL [registered partner]: rate forced to % on a VAT-registered issuer', r; end if;
end $$;

select 'ALL F16b VAT-REGISTRATION TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- F16c — THE SIDE DOORS (0403)
-- ═════════════════════════════════════════════════════════════════
-- Five ways round the F16 scope, all found by review of 0400–0402. The lesson is the
-- same in each: narrowing the tables a contractor can READ is not the same as narrowing
-- what they can REACH. These assertions exist so the doors stay shut.

-- ── (a) A notification is addressed to a person ──────────────────────────────
--
-- `notifications_sel` was farm-wide, so a linked contractor could read the payloads of
-- everything 0400 had just gated: quote and invoice totals, fault descriptions, fuel
-- anomalies, whole-farm weekly digests. One row per recipient is how they are written,
-- so the recipient is who may read them.
insert into notifications (farm_id, user_id, channel, template, payload) values
  ('f1600000-0000-0000-0000-000000000001', 'f1640000-0000-0000-0000-000000000001',
   'inapp', 'fuel_anomaly', '{"amount":"R12 340","machine":"P — not theirs"}'),
  ('f1600000-0000-0000-0000-000000000001', 'f1630000-0000-0000-0000-000000000001',
   'inapp', 'work_request_status', '{"title":"Y works on this one"}');

set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('f1630000-0000-0000-0000-000000000001');            -- Workshop Y
  select count(*) into c from notifications
   where farm_id = 'f1600000-0000-0000-0000-000000000001'
     and user_id <> 'f1630000-0000-0000-0000-000000000001';
  if c <> 0 then
    raise exception 'F16c FAIL [PAYLOAD LEAK]: a contractor reads % notifications addressed to the farm', c;
  end if;

  -- Its own alerts still arrive, or the contractor dashboard goes blank.
  select count(*) into c from notifications where user_id = 'f1630000-0000-0000-0000-000000000001';
  if c <> 1 then raise exception 'F16c FAIL [too tight]: a contractor sees % of its own alerts (expected 1)', c; end if;
end $$;

do $$ declare c bigint; begin
  perform _t_login('f1640000-0000-0000-0000-000000000001');            -- Owner P
  select count(*) into c from notifications where user_id = 'f1640000-0000-0000-0000-000000000001';
  if c <> 1 then raise exception 'F16c FAIL [own alerts]: Owner P sees % of their own alerts', c; end if;
  select count(*) into c from notifications where user_id <> 'f1640000-0000-0000-0000-000000000001';
  if c <> 0 then raise exception 'F16c FAIL: Owner P reads % alerts addressed to someone else', c; end if;
end $$;
reset role;

-- ── (b) Storage resolves to the same decision the tables make ────────────────
--
-- 0382's object policies were farm-scoped only, so a contractor could list and download
-- every file under a farm they were linked to: other contractors' invoice PDFs out of
-- `partner-docs`, photos of vehicles they have nothing to do with, fault voice notes.
--
-- The local test Postgres has no `storage` schema, so 0403 skipped the policies. The
-- DECISION function is what carries the rule, and it is testable here with a two-line
-- stand-in for `storage.foldername` (which splits an object key into its folder path).
create schema if not exists storage;
create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1 : greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)];
$$;

-- A photo of the vehicle Y works on, and one of the vehicle it does not.
insert into attachments (id, farm_id, parent_type, parent_id, kind, url) values
  ('f16a0000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000001',
   'machine', 'f1610000-0000-0000-0000-000000000001', 'photo', 'x'),
  ('f16a0000-0000-0000-0000-000000000002', 'f1600000-0000-0000-0000-000000000001',
   'machine', 'f1610000-0000-0000-0000-000000000002', 'photo', 'x');

set role authenticated;
do $$
declare
  ok_key   text := 'f1600000-0000-0000-0000-000000000001/f1610000-0000-0000-0000-000000000001/p.jpg';
  bad_key  text := 'f1600000-0000-0000-0000-000000000001/f1610000-0000-0000-0000-000000000002/p.jpg';
  far_key  text := '11111111-1111-1111-1111-111111111111/aa111111-1111-1111-1111-111111111111/p.jpg';
  mine_doc text;
  theirs   text;
begin
  perform _t_login('f1630000-0000-0000-0000-000000000001');            -- Workshop Y

  if not app.storage_object_visible('machine-photos', ok_key) then
    raise exception 'F16c FAIL [too tight]: a contractor cannot open a photo of the vehicle it is working on';
  end if;
  if app.storage_object_visible('machine-photos', bad_key) then
    raise exception 'F16c FAIL [STORAGE LEAK]: a contractor can open a photo of a vehicle it has no work on';
  end if;
  if app.storage_object_visible('machine-photos', far_key) then
    raise exception 'F16c FAIL [STORAGE LEAK]: a contractor can open a file on a farm it is not linked to';
  end if;
  if app.storage_object_visible('machine-photos', 'not-a-uuid/whatever.jpg') then
    raise exception 'F16c FAIL: an unrecognised object key was judged readable';
  end if;

  -- partner-docs: a contractor reaches the PDFs of documents it issued, and no others.
  -- 'Small Operator' (F16b) issued SO-0001 on this same farm; Y must not reach it.
  theirs := 'f1600000-0000-0000-0000-000000000001/f1670000-0000-0000-0000-000000000001/invoice.pdf';
  if app.storage_object_visible('partner-docs', theirs) then
    raise exception 'F16c FAIL [STORAGE LEAK]: a contractor can download another contractor''s invoice PDF';
  end if;

  perform _t_login('f1640000-0000-0000-0000-000000000001');            -- Owner P
  mine_doc := 'f1600000-0000-0000-0000-000000000001/f1670000-0000-0000-0000-000000000001/invoice.pdf';
  if app.storage_object_visible('machine-photos', bad_key) is not true then
    raise exception 'F16c FAIL [farm narrowed]: the farm''s own owner cannot open their own vehicle photo';
  end if;
  if app.storage_object_visible('partner-docs', mine_doc) is not true then
    raise exception 'F16c FAIL [farm narrowed]: the farm''s owner cannot open an invoice raised against them';
  end if;
end $$;
reset role;

-- ── (c) The VAT guard fires on the update that matters ───────────────────────
--
-- 0401 fired only when `vat_rate_bps` or `workshop_id` was in the UPDATE. Sending a draft
-- touches `status` and `sent_at` — so a document priced at 15% while the partner was
-- registered went OUT at 15% after they deregistered. And because trigger order is
-- alphabetical, the totals trigger ran first: the money was computed WITH VAT and only
-- the rate was zeroed, leaving a row that shows no VAT line while still charging it.
insert into workshops (id, name, kind, vat_registered) values
  ('f16b0000-0000-0000-0000-000000000001', 'Was Registered', 'mechanic', true);
insert into workshop_links (workshop_id, farm_id, status) values
  ('f16b0000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000001', 'active');
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number, vat_rate_bps)
values ('f16c0000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000001',
        'f16b0000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'WR-0001', 1500);
insert into partner_document_lines (farm_id, document_id, sort_order, kind, description, qty, unit_price_cents)
values ('f1600000-0000-0000-0000-000000000001', 'f16c0000-0000-0000-0000-000000000001',
        0, 'labour', 'Two hours', 2, 50000);

do $$ declare v bigint; begin
  select vat_cents into v from partner_documents where id = 'f16c0000-0000-0000-0000-000000000001';
  if v <= 0 then raise exception 'F16c FAIL [fixture]: a registered partner''s draft carries no VAT (%)', v; end if;
end $$;

-- They deregister, then send the draft. Sending touches neither the rate nor the workshop.
update workshops set vat_registered = false where id = 'f16b0000-0000-0000-0000-000000000001';
update partner_documents set status = 'sent', sent_at = now()
  where id = 'f16c0000-0000-0000-0000-000000000001';

do $$ declare r int; v bigint; tot bigint; sub bigint; begin
  select vat_rate_bps, vat_cents, total_cents, subtotal_cents into r, v, tot, sub
    from partner_documents where id = 'f16c0000-0000-0000-0000-000000000001';
  if r <> 0 or v <> 0 then
    raise exception 'F16c FAIL [VAT ON SEND]: sent at % bps charging % cents of VAT the partner may not collect', r, v;
  end if;
  if tot <> sub then
    raise exception 'F16c FAIL [VAT IN THE TOTAL]: total % <> subtotal % — the VAT line is hidden but still billed', tot, sub;
  end if;
end $$;

-- An `uploaded` document's totals are typed by hand, not derived, so the guard has to
-- correct those too — this is the case where a stray vat_cents simply survived.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number, upload_path,
                               vat_rate_bps, subtotal_cents, vat_cents, total_cents)
values ('f16c0000-0000-0000-0000-000000000002', 'f1600000-0000-0000-0000-000000000001',
        'f16b0000-0000-0000-0000-000000000001', 'invoice', 'sent', 'uploaded', 'WR-0002',
        'f1600000-0000-0000-0000-000000000001/f16c0000-0000-0000-0000-000000000002/inv.pdf',
        1500, 100000, 15000, 115000);
do $$ declare r int; v bigint; tot bigint; begin
  select vat_rate_bps, vat_cents, total_cents into r, v, tot
    from partner_documents where id = 'f16c0000-0000-0000-0000-000000000002';
  if r <> 0 or v <> 0 or tot <> 100000 then
    raise exception 'F16c FAIL [uploaded]: typed totals kept VAT — % bps, % cents, total %', r, v, tot;
  end if;
end $$;

-- ── (d) An owner looking at a second site can actually change it ─────────────
--
-- `wl_upd` (0101) allowed an update only on the PRIMARY farm. Since F7 an owner can be
-- looking at a second site through `user_farm_memberships`, and both the access card and
-- the disconnect button write against the farm being VIEWED. On a secondary farm that
-- update matched zero rows, raised nothing, and redirected saying it had worked — so an
-- owner could be told a contractor was disconnected while their access carried on.
insert into farms (id, name) values ('f16d0000-0000-0000-0000-000000000001', 'Farm Q');
insert into auth.users (id, email) values ('f16d0000-0000-0000-0000-000000000002', 'ownerQ@test');
insert into users (id, farm_id, role, name, email) values
  ('f16d0000-0000-0000-0000-000000000002', 'f16d0000-0000-0000-0000-000000000001', 'owner', 'Owner Q', 'ownerq@test');
-- Q also runs Farm P as a second site.
insert into user_farm_memberships (user_id, farm_id, role) values
  ('f16d0000-0000-0000-0000-000000000002', 'f1600000-0000-0000-0000-000000000001', 'owner');

set role authenticated;
do $$ declare st text; begin
  perform _t_login('f16d0000-0000-0000-0000-000000000002');            -- Owner Q, on site P
  update workshop_links set status = 'revoked'
   where workshop_id = 'f1620000-0000-0000-0000-000000000001'
     and farm_id = 'f1600000-0000-0000-0000-000000000001';
  select status into st from workshop_links
   where workshop_id = 'f1620000-0000-0000-0000-000000000001'
     and farm_id = 'f1600000-0000-0000-0000-000000000001';
  if st <> 'revoked' then
    raise exception 'F16c FAIL [SILENT NO-OP]: disconnecting on a second site left the link %', st;
  end if;
end $$;

-- And the disconnection actually took: Y loses the farm entirely.
do $$ declare c bigint; begin
  perform _t_login('f1630000-0000-0000-0000-000000000001');            -- Workshop Y
  select count(*) into c from farms where id = 'f1600000-0000-0000-0000-000000000001';
  if c <> 0 then raise exception 'F16c FAIL: a revoked contractor still reaches the farm'; end if;
end $$;
reset role;

-- A contractor still cannot re-scope or re-activate itself under the widened policy.
set role authenticated;
do $$ declare st text; begin
  perform _t_login('f1630000-0000-0000-0000-000000000001');
  update workshop_links set status = 'active', see_costs = true
   where workshop_id = 'f1620000-0000-0000-0000-000000000001';
  perform _t_login('d4444444-4444-4444-4444-444444444444');            -- rr_admin reads the truth
  select status into st from workshop_links
   where workshop_id = 'f1620000-0000-0000-0000-000000000001'
     and farm_id = 'f1600000-0000-0000-0000-000000000001';
  if st <> 'revoked' then
    raise exception 'F16c FAIL [SELF-REACTIVATE]: a contractor turned its own link back %', st;
  end if;
end $$;
reset role;

select 'ALL F16c SIDE-DOOR TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- F16d — NOBODY PROMOTES THEMSELVES (0404)
-- ═════════════════════════════════════════════════════════════════
-- The row that decides what you may read was writable by you. `users_upd` (0101) lets a
-- person edit their own row, `role` sits on that row, and `app.is_rr_admin()` is defined
-- as that column. One UPDATE and an ordinary login read every tenant in the system.
--
-- `users_scope_ck` blocks the naive version (an rr_admin holds no farm and no workshop),
-- so the exploit nulls both columns in the same statement — which is why this was not
-- obvious from reading the policy.

-- A farm-side person for Owner P to administer. (A contractor's staff account belongs to
-- the workshop, not to any farm, so no farmer may touch it — asserted below.)
insert into auth.users (id, email) values ('f16f0000-0000-0000-0000-000000000001', 'driverR@test');
insert into users (id, farm_id, role, name, email) values
  ('f16f0000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000001', 'operator', 'Driver R', 'driverr@test');

set role authenticated;

-- ── (a) A contractor cannot promote itself ───────────────────────────────────
do $$ declare r text; c bigint; begin
  perform _t_login('f1630000-0000-0000-0000-000000000001');            -- Workshop Y staff
  begin
    update users set role = 'rr_admin', farm_id = null, workshop_id = null
     where id = 'f1630000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then null;                     -- expected
  end;
  perform _t_login('d4444444-4444-4444-4444-444444444444');            -- rr_admin reads the truth
  select role into r from users where id = 'f1630000-0000-0000-0000-000000000001';
  if r <> 'workshop' then
    raise exception 'F16d FAIL [PRIVILEGE ESCALATION]: a contractor made itself %', r;
  end if;
end $$;

-- ── (b) Nor can a farm owner, an operator, or anyone else ────────────────────
do $$ declare r text; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');            -- Owner B
  begin
    update users set role = 'rr_admin', farm_id = null
     where id = 'b2222222-2222-2222-2222-222222222222';
  exception when insufficient_privilege then null;
  end;
  perform _t_login('d4444444-4444-4444-4444-444444444444');
  select role into r from users where id = 'b2222222-2222-2222-2222-222222222222';
  if r <> 'owner' then
    raise exception 'F16d FAIL [PRIVILEGE ESCALATION]: a farm owner made themselves %', r;
  end if;
end $$;

-- ── (c) You cannot quietly reassign yourself to another farm either ──────────
do $$ declare f uuid; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');
  begin
    update users set farm_id = '11111111-1111-1111-1111-111111111111'
     where id = 'b2222222-2222-2222-2222-222222222222';
  exception when insufficient_privilege then null;
  end;
  perform _t_login('d4444444-4444-4444-4444-444444444444');
  select farm_id into f from users where id = 'b2222222-2222-2222-2222-222222222222';
  if f <> '22222222-2222-2222-2222-222222222222' then
    raise exception 'F16d FAIL [FARM HOP]: Owner B moved themselves to %', f;
  end if;
end $$;

-- ── (d) The profile edits the app actually makes still work ──────────────────
do $$ declare n text; l text; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');
  update users set name = 'Owner B (renamed)', language = 'af', phone = '+27820001234'
   where id = 'b2222222-2222-2222-2222-222222222222';
  select name, language into n, l from users where id = 'b2222222-2222-2222-2222-222222222222';
  if n <> 'Owner B (renamed)' or l <> 'af' then
    raise exception 'F16d FAIL [too tight]: a person can no longer edit their own profile (% / %)', n, l;
  end if;
end $$;

-- ── (e) An owner can still deactivate someone on their own farm ──────────────
-- This is the one administrative write the app makes (`/team`), and the POPIA erasure
-- RPC depends on it too.
do $$ declare a boolean; begin
  perform _t_login('f1640000-0000-0000-0000-000000000001');            -- Owner P
  update users set active = false where id = 'f16f0000-0000-0000-0000-000000000001';
  perform _t_login('d4444444-4444-4444-4444-444444444444');
  select active into a from users where id = 'f16f0000-0000-0000-0000-000000000001';
  if a is not false then
    raise exception 'F16d FAIL [too tight]: an owner can no longer deactivate a person on their farm';
  end if;
end $$;
reset role;
update users set active = true where id = 'f16f0000-0000-0000-0000-000000000001';
set role authenticated;

-- ── (f) …but not mint an rr_admin, not reach another farm's people, and not ──
--        touch a contractor's staff account, which belongs to the workshop ───
do $$ declare r text; begin
  perform _t_login('f1640000-0000-0000-0000-000000000001');            -- Owner P
  begin
    update users set role = 'rr_admin', farm_id = null
     where id = 'f16f0000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then null;
  end;
  perform _t_login('d4444444-4444-4444-4444-444444444444');
  select role into r from users where id = 'f16f0000-0000-0000-0000-000000000001';
  if r <> 'operator' then
    raise exception 'F16d FAIL [MINTED ADMIN]: a farm owner created an rr_admin (%)', r;
  end if;
end $$;

do $$ declare a boolean; begin
  perform _t_login('f1640000-0000-0000-0000-000000000001');            -- Owner P
  begin
    update users set active = false where id = 'f1630000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then null;
  end;
  perform _t_login('d4444444-4444-4444-4444-444444444444');
  select active into a from users where id = 'f1630000-0000-0000-0000-000000000001';
  if a is not true then
    raise exception 'F16d FAIL: a farmer disabled a contractor''s own staff account';
  end if;
end $$;

do $$ declare a boolean; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');            -- Owner B
  begin
    update users set active = false where id = 'a1111111-1111-1111-1111-111111111111';
  exception when insufficient_privilege then null;
  end;
  perform _t_login('d4444444-4444-4444-4444-444444444444');
  select active into a from users where id = 'a1111111-1111-1111-1111-111111111111';
  if a is not true then
    raise exception 'F16d FAIL [CROSS-TENANT]: Owner B deactivated Farm A''s owner';
  end if;
end $$;

-- ── (g) rr_admin is unaffected ───────────────────────────────────────────────
do $$ declare a boolean; begin
  perform _t_login('d4444444-4444-4444-4444-444444444444');
  update users set active = false where id = 'b2222222-2222-2222-2222-222222222222';
  select active into a from users where id = 'b2222222-2222-2222-2222-222222222222';
  if a is not false then raise exception 'F16d FAIL: rr_admin can no longer administer a user'; end if;
  update users set active = true where id = 'b2222222-2222-2222-2222-222222222222';
end $$;

-- ── (h) A contractor cannot mark the farm's alerts read ──────────────────────
-- `notifications_upd` was farm-wide, and an UPDATE naming no columns in its WHERE clause
-- never consults the SELECT policy — so 0403's narrowing did not cover this by itself.
do $$ declare c bigint; begin
  perform _t_login('f1630000-0000-0000-0000-000000000001');
  update notifications set read_at = now();
  perform _t_login('d4444444-4444-4444-4444-444444444444');
  select count(*) into c from notifications
   where user_id = 'f1640000-0000-0000-0000-000000000001' and read_at is not null;
  if c <> 0 then
    raise exception 'F16d FAIL: a contractor marked % of the farm owner''s alerts read', c;
  end if;
end $$;
reset role;

select 'ALL F16d PRIVILEGE-ESCALATION TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- G2 — CORRECTIONS, RECIPIENTS AND STATEMENTS (0410–0414)
-- ═════════════════════════════════════════════════════════════════
-- The claim: a mistake can be fixed without pretending it never happened, a partner can
-- bill someone who is not on FleetWise, and a statement of account adds up.
--
-- Fresh fixtures: Workshop Z, one linked farm (S), one client-book customer, and a
-- walk-in with no record at all.

insert into farms (id, name, vat_number, billing_address) values
  ('62000000-0000-0000-0000-000000000001', 'Farm S', '4123456789', '12 Mill Rd, Bethlehem');
insert into workshops (id, name, kind, vat_registered, default_vat_rate_bps) values
  ('62100000-0000-0000-0000-000000000001', 'Workshop Z', 'mechanic', true, 1500);
insert into workshop_links (workshop_id, farm_id, status) values
  ('62100000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 'active');
insert into auth.users (id, email) values ('62200000-0000-0000-0000-000000000001', 'zstaff@test');
insert into users (id, farm_id, workshop_id, role, name, email) values
  ('62200000-0000-0000-0000-000000000001', null, '62100000-0000-0000-0000-000000000001', 'workshop', 'Z Staff', 'z@test');
insert into auth.users (id, email) values ('62300000-0000-0000-0000-000000000001', 'ownerS@test');
insert into users (id, farm_id, role, name, email) values
  ('62300000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 'owner', 'Owner S', 'owners@test');
insert into auth.users (id, email) values ('62400000-0000-0000-0000-000000000001', 'opS@test');
insert into users (id, farm_id, role, name, email) values
  ('62400000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 'operator', 'Operator S', 'ops@test');
insert into partner_clients (id, workshop_id, name, vat_number, payment_terms_days) values
  ('62400000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001', 'Off-grid Farming CC', '4987654321', 7);

-- ── (a) The bill-to seeds itself, which is what makes it a tax invoice ────────
-- Before 0410 the recipient block was `farm.name` and nothing else, so a supply over
-- R5 000 was not a full tax invoice under VAT Act s20(4) and the farmer could not claim.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number, issue_date, due_date)
values ('62500000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
        '62100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'ZI-0001',
        current_date - 40, current_date - 10);
insert into partner_document_lines (farm_id, document_id, sort_order, kind, description, qty, unit_price_cents)
values ('62000000-0000-0000-0000-000000000001', '62500000-0000-0000-0000-000000000001', 0, 'labour', 'Gearbox', 1, 1000000);

do $$ declare n text; v text; a text; begin
  select bill_to_name, bill_to_vat_number, bill_to_address into n, v, a
    from partner_documents where id = '62500000-0000-0000-0000-000000000001';
  if n is null then raise exception 'G2 FAIL [addressee]: no bill-to name was seeded'; end if;
  if v <> '4123456789' then
    raise exception 'G2 FAIL [TAX INVOICE]: the recipient VAT number is % — without it the farmer cannot claim', coalesce(v, 'missing');
  end if;
  if a is null then raise exception 'G2 FAIL [TAX INVOICE]: no recipient address on the document'; end if;
end $$;

-- ── (b) A partner can bill someone who is not on FleetWise ───────────────────
-- `farm_id` was `not null`, so a partner could only invoice a FleetWise tenant — they
-- could record a client-book customer, phone them, and not bill them.
-- Built as a draft, then sent — the same order the app enforces, because 0412 freezes
-- the items the moment a document is issued.
insert into partner_documents (id, farm_id, partner_client_id, workshop_id, kind, status, source, number, issue_date, due_date)
values ('62500000-0000-0000-0000-000000000002', null, '62400000-0000-0000-0000-000000000001',
        '62100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'ZI-0002',
        current_date - 20, current_date - 5);
insert into partner_document_lines (document_id, sort_order, kind, description, qty, unit_price_cents)
values ('62500000-0000-0000-0000-000000000002', 0, 'part', 'Belt', 2, 25000);
update partner_documents set status = 'sent', sent_at = now()
 where id = '62500000-0000-0000-0000-000000000002';

-- And a walk-in, with no record anywhere.
insert into partner_documents (id, farm_id, partner_client_id, workshop_id, kind, status, source,
                               number, issue_date, due_date, bill_to_name)
values ('62500000-0000-0000-0000-000000000003', null, null,
        '62100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'ZI-0003',
        current_date - 3, current_date + 27, 'Cash customer');
insert into partner_document_lines (document_id, sort_order, kind, description, qty, unit_price_cents)
values ('62500000-0000-0000-0000-000000000003', 0, 'labour', 'Roadside', 1, 60000);
update partner_documents set status = 'sent', sent_at = now()
 where id = '62500000-0000-0000-0000-000000000003';

do $$ declare c bigint; begin
  select count(*) into c from partner_documents
   where workshop_id = '62100000-0000-0000-0000-000000000001' and farm_id is null;
  if c <> 2 then raise exception 'G2 FAIL [recipients]: % documents with no farm (expected 2)', c; end if;
  -- A document with no farm books NO farm cost — that money is the partner's revenue.
  select count(*) into c from cost_entries
   where source_type = 'partner_document'
     and source_id in ('62500000-0000-0000-0000-000000000002', '62500000-0000-0000-0000-000000000003');
  if c <> 0 then raise exception 'G2 FAIL [ledger]: a farmless document booked % farm costs', c; end if;
end $$;

-- ── (c) Nothing issued can be deleted or quietly re-priced ───────────────────
-- AutoVault HARD DELETES an invoice with the service-role client
-- (`admin.from('invoices').delete()`), so a statement printed last month and one printed
-- today disagree with nothing to explain why.
update partner_documents set status = 'sent', sent_at = now()
 where id = '62500000-0000-0000-0000-000000000001';

do $$ declare ok boolean := false; begin
  begin
    delete from partner_documents where id = '62500000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'G2 FAIL [ERASURE]: an issued invoice was deleted outright'; end if;
end $$;

do $$ declare ok boolean := false; begin
  begin
    update partner_documents set deleted_at = now() where id = '62500000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'G2 FAIL [ERASURE]: an issued invoice was soft-deleted'; end if;
end $$;

do $$ declare ok boolean := false; begin
  begin
    update partner_documents set subtotal_cents = 1 where id = '62500000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'G2 FAIL [RE-PRICE]: an issued invoice was re-priced in place'; end if;
end $$;

do $$ declare ok boolean := false; begin
  begin
    update partner_document_lines set unit_price_cents = 1
     where document_id = '62500000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'G2 FAIL [RE-PRICE]: the items on an issued invoice were changed'; end if;
end $$;

-- ── (d) A credit note is the correction, and it nets off the ledger ──────────
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                               corrects_document_id, issue_date)
values ('62600000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
        '62100000-0000-0000-0000-000000000001', 'credit_note', 'draft', 'built', 'ZC-0001',
        '62500000-0000-0000-0000-000000000001', current_date - 30);
insert into partner_document_lines (farm_id, document_id, sort_order, kind, description, qty, unit_price_cents)
values ('62000000-0000-0000-0000-000000000001', '62600000-0000-0000-0000-000000000001', 0, 'labour', 'Overcharge', 1, 200000);
update partner_documents set status = 'sent', sent_at = now()
 where id = '62600000-0000-0000-0000-000000000001';

do $$ declare inv bigint; cred bigint; begin
  select amount_cents into inv from cost_entries
   where source_type = 'partner_document' and source_id = '62500000-0000-0000-0000-000000000001' and deleted_at is null;
  select amount_cents into cred from cost_entries
   where source_type = 'partner_document' and source_id = '62600000-0000-0000-0000-000000000001' and deleted_at is null;
  if inv is null or inv <= 0 then raise exception 'G2 FAIL: the invoice is not in the farm ledger (%)', inv; end if;
  if cred is null or cred >= 0 then
    raise exception 'G2 FAIL [CREDIT]: a credit note booked % — it must be NEGATIVE so the correction nets out of TCO instead of erasing it', cred;
  end if;
end $$;

-- A credit note must name what it corrects, and credits cannot exceed the invoice.
do $$ declare ok boolean := false; begin
  begin
    insert into partner_documents (farm_id, workshop_id, kind, status, source, number, issue_date, bill_to_name)
    values ('62000000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001',
            'credit_note', 'draft', 'built', 'ZC-ORPHAN', current_date, 'Farm S');
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'G2 FAIL: a credit note was issued against nothing'; end if;
end $$;

do $$ declare ok boolean := false; v_total bigint; begin
  select total_cents into v_total from partner_documents where id = '62500000-0000-0000-0000-000000000001';
  begin
    insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                                   corrects_document_id, issue_date, subtotal_cents, total_cents)
    values ('62600000-0000-0000-0000-000000000009', '62000000-0000-0000-0000-000000000001',
            '62100000-0000-0000-0000-000000000001', 'credit_note', 'sent', 'uploaded', 'ZC-TOOBIG',
            '62500000-0000-0000-0000-000000000001', current_date, v_total, v_total);
  exception when others then ok := true;
  end;
  if not ok then
    raise exception 'G2 FAIL [OVER-CREDIT]: credits against this invoice were allowed to exceed it';
  end if;
end $$;

-- ── (e) A void keeps the record and stands the money down ────────────────────
do $$ declare ok boolean := false; begin
  begin
    update partner_documents set status = 'void' where id = '62500000-0000-0000-0000-000000000003';
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'G2 FAIL: a document was voided with no reason recorded'; end if;
end $$;

update partner_documents
   set status = 'void', void_reason = 'Raised against the wrong customer', voided_at = now()
 where id = '62500000-0000-0000-0000-000000000003';

do $$ declare st text; c bigint; begin
  select status into st from partner_documents where id = '62500000-0000-0000-0000-000000000003';
  if st <> 'void' then raise exception 'G2 FAIL: the void did not take (%)', st; end if;
  -- The row is still there. That is the whole point: AutoVault deletes it.
  select count(*) into c from partner_documents
   where id = '62500000-0000-0000-0000-000000000003' and deleted_at is null;
  if c <> 1 then raise exception 'G2 FAIL: voiding destroyed the record instead of keeping it'; end if;
end $$;

-- ── (f) The statement adds up, and carries a balance forward ─────────────────
-- Payments: two part-payments against the Farm S invoice, one in each period.
insert into partner_payments (farm_id, document_id, amount_cents, paid_on, method) values
  ('62000000-0000-0000-0000-000000000001', '62500000-0000-0000-0000-000000000001', 300000, current_date - 35, 'eft'),
  ('62000000-0000-0000-0000-000000000001', '62500000-0000-0000-0000-000000000001', 100000, current_date - 2,  'eft');

set role authenticated;
do $$
declare
  v_open   bigint;
  v_close  bigint;
  v_rows   bigint;
  v_quotes bigint;
begin
  perform _t_login('62200000-0000-0000-0000-000000000001');        -- Workshop Z

  -- A window that starts AFTER the invoice: everything before it must arrive as an
  -- opening balance. AutoVault starts the running balance at zero here, so its closing
  -- figure is what the customer was billed in the period, not what they owe.
  select debit_cents - credit_cents into v_open
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 7, current_date)
   where kind = 'opening';
  if v_open is null then
    raise exception 'G2 FAIL [NO OPENING BALANCE]: a statement that starts mid-account showed nothing brought forward';
  end if;

  -- Closing balance = invoice − credit note − payments, whatever window we ask for.
  select coalesce(sum(debit_cents - credit_cents), 0) into v_close
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 7, current_date);
  if v_close is distinct from (
    select d.total_cents - c.total_cents - 400000
      from partner_documents d, partner_documents c
     where d.id = '62500000-0000-0000-0000-000000000001'
       and c.id = '62600000-0000-0000-0000-000000000001'
  ) then
    raise exception 'G2 FAIL [STATEMENT]: closing balance is % — it must equal invoice minus credits minus payments', v_close;
  end if;

  -- A part-payment appears. AutoVault only emits a payment row when the invoice is FULLY
  -- paid, so a half-paid invoice shows its whole debit and no credit.
  select count(*) into v_rows
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 400, current_date)
   where kind = 'payment';
  if v_rows <> 2 then
    raise exception 'G2 FAIL [PART PAYMENTS]: % payment rows (expected 2) — a part-paid invoice must show what was received', v_rows;
  end if;

  -- A quote is not a financial event and has no place on a statement of account.
  select count(*) into v_quotes
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 400, current_date)
   where kind = 'quote';
  if v_quotes <> 0 then raise exception 'G2 FAIL: % quotes on a statement of account', v_quotes; end if;
end $$;

-- ── (g) Ageing measures from the DUE date, and nets credits off ──────────────
do $$ declare cur bigint; over bigint; tot bigint; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  select current_cents, d30_cents + d60_cents + d90_cents, total_cents into cur, over, tot
    from app.partner_ageing('62100000-0000-0000-0000-000000000001',
                            '62000000-0000-0000-0000-000000000001', null, current_date);
  if over <= 0 then
    raise exception 'G2 FAIL [AGEING]: an invoice due % days ago is not showing as overdue', 10;
  end if;
  if cur <> 0 then raise exception 'G2 FAIL [AGEING]: % in the not-yet-due bucket', cur; end if;
  if tot <> over then raise exception 'G2 FAIL [AGEING]: buckets (%) do not sum to the total (%)', over, tot; end if;
end $$;

-- ── (h) A statement is still farm-isolated ───────────────────────────────────
do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');        -- Owner A, another farm
  select count(*) into c
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 400, current_date);
  if c <> 0 then
    raise exception 'G2 FAIL [CROSS-TENANT]: another farm''s owner read % rows of Farm S''s account', c;
  end if;
end $$;

-- The farm the account belongs to reads its own.
do $$ declare c bigint; begin
  perform _t_login('62300000-0000-0000-0000-000000000001');        -- Owner S
  select count(*) into c
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 400, current_date);
  if c = 0 then raise exception 'G2 FAIL: a farm cannot read the account a partner keeps for them'; end if;
end $$;
reset role;

-- ── (i) Anon reaches none of it ──────────────────────────────────────────────
set role anon;
do $$ declare ok boolean := false; begin
  begin perform app.partner_statement(null, null, null, current_date, current_date);
  exception when others then ok := true; end;
  if not ok then raise exception 'G2 FAIL: anon executed the statement engine'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform public.notify_workshop_document(null, null, 'x', '{}'::jsonb);
  exception when others then ok := true; end;
  if not ok then raise exception 'G2 FAIL: anon queued a notification into a partner''s feed'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform public.cron_enqueue_document_reminders();
  exception when others then ok := true; end;
  if not ok then raise exception 'G2 FAIL: anon ran the reminder engine'; end if;
end $$;
reset role;

-- ── (j) Quotes expire, and overdue invoices get chased ───────────────────────
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number, issue_date, due_date)
values ('62700000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
        '62100000-0000-0000-0000-000000000001', 'quote', 'sent', 'built', 'ZQ-0001',
        current_date - 30, current_date - 1);

do $$ begin perform app.expire_partner_quotes(); end $$;
do $$ declare st text; begin
  select status into st from partner_documents where id = '62700000-0000-0000-0000-000000000001';
  if st <> 'expired' then
    raise exception 'G2 FAIL: a quote past its validity date is still % — `expired` has been in the enum since 0381 with nothing ever setting it', st;
  end if;
end $$;

do $$ begin perform app.enqueue_document_reminders(); end $$;
do $$ declare c_farm bigint; c_shop bigint; begin
  select count(*) into c_farm from notifications
   where template = 'invoice_overdue'
     and payload->>'document_id' = '62500000-0000-0000-0000-000000000001'
     and user_id = '62300000-0000-0000-0000-000000000001';
  if c_farm = 0 then raise exception 'G2 FAIL: the farm was not told about an overdue invoice'; end if;

  select count(*) into c_shop from notifications
   where template = 'invoice_overdue_partner'
     and payload->>'document_id' = '62500000-0000-0000-0000-000000000001'
     and user_id = '62200000-0000-0000-0000-000000000001';
  if c_shop = 0 then raise exception 'G2 FAIL: the partner was not told their invoice is overdue'; end if;
end $$;

-- Twice in one week is once. (0330's dedupe pattern, read from the queue itself.)
do $$ declare before_c bigint; after_c bigint; begin
  select count(*) into before_c from notifications where template like 'invoice_overdue%';
  perform app.enqueue_document_reminders();
  select count(*) into after_c from notifications where template like 'invoice_overdue%';
  if after_c <> before_c then
    raise exception 'G2 FAIL [DEDUPE]: a second run added % more reminders', after_c - before_c;
  end if;
end $$;

-- ── (k) A partner never sees another partner's account ───────────────────────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');        -- Workshop W, unrelated
  select count(*) into c
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 400, current_date);
  if c <> 0 then
    raise exception 'G2 FAIL [COMPETITOR]: another partner read % rows of Workshop Z''s account with Farm S', c;
  end if;
end $$;
reset role;

select 'ALL G2 CORRECTION & STATEMENT TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- G3 — EDITS WITH HISTORY, AND DEBIT NOTES (0416–0418)
-- ═════════════════════════════════════════════════════════════════
-- The claim: an issued document can be CORRECTED, and cannot be corrected quietly.
-- The guarantee moved from "it cannot change" to "it cannot change without leaving the
-- version it replaced" — so every assertion here is about the door being single.

set role authenticated;

-- ── (a) The correction works, and the old version survives ───────────────────
do $$
declare v_before bigint; v_after bigint; v_rev int; v_snapshot jsonb;
begin
  perform _t_login('62200000-0000-0000-0000-000000000001');        -- Workshop Z

  select total_cents into v_before from partner_documents
   where id = '62500000-0000-0000-0000-000000000001';

  perform public.revise_document(
    '62500000-0000-0000-0000-000000000001',
    'Charged for a gearbox we did not fit',
    jsonb_build_object('subject', 'Gearbox — corrected'),
    jsonb_build_array(jsonb_build_object(
      'kind', 'labour', 'description', 'Gearbox (corrected)', 'qty', 1, 'unit_price_cents', 600000
    ))
  );

  select total_cents, revision into v_after, v_rev from partner_documents
   where id = '62500000-0000-0000-0000-000000000001';

  if v_after = v_before then
    raise exception 'G3 FAIL: the correction did not change the total (still %)', v_after;
  end if;
  if v_rev <> 2 then raise exception 'G3 FAIL: revision is % (expected 2)', v_rev; end if;

  -- The version it replaced is on file, lines and all.
  select snapshot into v_snapshot from partner_document_revisions
   where document_id = '62500000-0000-0000-0000-000000000001' and version = 1;
  if v_snapshot is null then
    raise exception 'G3 FAIL [NO HISTORY]: the document was corrected with no record of what it said';
  end if;
  if (v_snapshot->'document'->>'total_cents')::bigint <> v_before then
    raise exception 'G3 FAIL: the snapshot total is % but the document was %',
      v_snapshot->'document'->>'total_cents', v_before;
  end if;
  if jsonb_array_length(v_snapshot->'lines') = 0 then
    raise exception 'G3 FAIL: the snapshot kept no lines, so the old document cannot be reproduced';
  end if;
end $$;

-- ── (b) There is no second door ──────────────────────────────────────────────
do $$ declare ok boolean := false; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  begin
    update partner_documents set subtotal_cents = 1
     where id = '62500000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then ok := true; end;
  if not ok then
    raise exception 'G3 FAIL [BACK DOOR]: an issued invoice was re-priced directly, with no version kept';
  end if;
end $$;

do $$ declare ok boolean := false; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  begin
    update partner_document_lines set unit_price_cents = 1
     where document_id = '62500000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then ok := true; end;
  if not ok then
    raise exception 'G3 FAIL [BACK DOOR]: the lines of an issued invoice were changed directly';
  end if;
end $$;

-- Deleting an issued document is STILL refused. This is the one thing that stays shut:
-- it is what makes AutoVault's statements disagree between two printings.
do $$ declare ok boolean := false; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  begin
    delete from partner_documents where id = '62500000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G3 FAIL [ERASURE]: an issued invoice was deleted'; end if;
end $$;

-- ── (c) A correction has to say what it is ───────────────────────────────────
do $$ declare ok boolean := false; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  begin
    perform public.revise_document('62500000-0000-0000-0000-000000000001', '  ', '{}'::jsonb, null);
  exception when others then ok := true; end;
  if not ok then raise exception 'G3 FAIL: a document was corrected with no reason given'; end if;
end $$;

-- ── (d) You cannot correct an invoice below what has been paid ───────────────
-- That is a refund, and a refund has to be visible as its own event.
do $$ declare ok boolean := false; v_total bigint; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  begin
    perform public.revise_document(
      '62500000-0000-0000-0000-000000000001', 'Try to go below the payments',
      '{}'::jsonb,
      jsonb_build_array(jsonb_build_object('kind','labour','description','Tiny','qty',1,'unit_price_cents',100))
    );
  exception when others then ok := true; end;
  if not ok then
    raise exception 'G3 FAIL [REFUND BY STEALTH]: an invoice was corrected below what the customer already paid';
  end if;
  -- and the failed attempt left nothing behind
  select total_cents into v_total from partner_documents where id = '62500000-0000-0000-0000-000000000001';
  if v_total < 400000 then
    raise exception 'G3 FAIL: the refused correction was applied anyway (total %)', v_total;
  end if;
end $$;

-- ── (e) Another partner cannot correct your paperwork ────────────────────────
do $$ declare ok boolean := false; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');        -- Workshop W
  begin
    perform public.revise_document('62500000-0000-0000-0000-000000000001', 'Not mine to touch', '{}'::jsonb, null);
  exception when others then ok := true; end;
  if not ok then
    raise exception 'G3 FAIL [CROSS-PARTNER]: another workshop corrected Workshop Z''s invoice';
  end if;
end $$;

-- ── (f) The customer can see how it changed ──────────────────────────────────
do $$ declare c bigint; begin
  perform _t_login('62300000-0000-0000-0000-000000000001');        -- Owner S, the customer
  select count(*) into c from partner_document_revisions
   where document_id = '62500000-0000-0000-0000-000000000001';
  if c = 0 then
    raise exception 'G3 FAIL: the customer cannot see that an invoice sent to them was changed';
  end if;
end $$;

do $$ declare c bigint; begin
  perform _t_login('a1111111-1111-1111-1111-111111111111');        -- another farm
  select count(*) into c from partner_document_revisions;
  if c <> 0 then
    raise exception 'G3 FAIL [CROSS-TENANT]: another farm read % revision rows', c;
  end if;
end $$;
reset role;

-- ── (g) A debit note adds, where a credit note subtracts ─────────────────────
do $$ declare v_num text; v_id uuid; v_ledger bigint; begin
  select app.next_document_number('62100000-0000-0000-0000-000000000001', 'debit_note') into v_num;
  insert into partner_documents
    (id, farm_id, workshop_id, kind, status, source, number, subject,
     corrects_document_id, issue_date, vat_rate_bps)
  values ('62800000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
          '62100000-0000-0000-0000-000000000001', 'debit_note', 'draft', 'built', v_num,
          'Part left off the invoice', '62500000-0000-0000-0000-000000000001', current_date - 1, 1500)
  returning id into v_id;
  insert into partner_document_lines (farm_id, document_id, sort_order, kind, description, qty, unit_price_cents)
  values ('62000000-0000-0000-0000-000000000001', v_id, 0, 'part', 'Seal kit', 1, 80000);
  update partner_documents set status = 'sent', sent_at = now() where id = v_id;

  select amount_cents into v_ledger from cost_entries
   where source_type = 'partner_document' and source_id = v_id and deleted_at is null;
  if v_ledger is null or v_ledger <= 0 then
    raise exception 'G3 FAIL [DEBIT NOTE]: booked % — a debit note must ADD to the farm''s costs', v_ledger;
  end if;
end $$;

-- A note of either kind must say what it adjusts.
do $$ declare ok boolean := false; begin
  begin
    insert into partner_documents (farm_id, workshop_id, kind, status, source, number, issue_date, bill_to_name)
    values ('62000000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001',
            'debit_note', 'draft', 'built', 'DN-ORPHAN', current_date, 'Farm S');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'G3 FAIL: a debit note was issued against nothing'; end if;
end $$;

-- ── (h) The statement still adds up, with both notes and a correction ────────
set role authenticated;
do $$
declare v_close bigint; v_indep bigint; v_debits bigint;
begin
  perform _t_login('62200000-0000-0000-0000-000000000001');

  select coalesce(sum(debit_cents - credit_cents), 0) into v_close
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 400, current_date);

  select coalesce(sum(case when kind = 'credit_note' then -total_cents else total_cents end), 0)
       - coalesce((select sum(p.amount_cents) from partner_payments p
                    join partner_documents d2 on d2.id = p.document_id
                   where d2.workshop_id = '62100000-0000-0000-0000-000000000001'
                     and d2.farm_id = '62000000-0000-0000-0000-000000000001'
                     and p.deleted_at is null), 0)
    into v_indep
    from partner_documents
   where workshop_id = '62100000-0000-0000-0000-000000000001'
     and farm_id = '62000000-0000-0000-0000-000000000001'
     and deleted_at is null
     and kind in ('invoice','credit_note','debit_note')
     and status not in ('draft','void','cancelled');

  if v_close is distinct from v_indep then
    raise exception 'G3 FAIL [STATEMENT]: closing % <> independent % after a correction and a debit note',
      v_close, v_indep;
  end if;

  -- The corrected invoice appears ONCE, at its current value — not once per version.
  select count(*) into v_debits
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 400, current_date)
   where document_id = '62500000-0000-0000-0000-000000000001' and kind = 'invoice';
  if v_debits <> 1 then
    raise exception 'G3 FAIL: a corrected invoice appears % times on the statement (expected 1)', v_debits;
  end if;

  -- The debit note is a DEBIT.
  select coalesce(sum(debit_cents), 0) into v_debits
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 400, current_date)
   where kind = 'debit_note';
  if v_debits <= 0 then
    raise exception 'G3 FAIL: a debit note is not charged on the statement';
  end if;
end $$;

-- ── (i) Anon reaches none of it ──────────────────────────────────────────────
reset role;
set role anon;
do $$ declare ok boolean := false; begin
  begin perform public.revise_document('62500000-0000-0000-0000-000000000001', 'anon edit', '{}'::jsonb, null);
  exception when others then ok := true; end;
  if not ok then raise exception 'G3 FAIL: anon corrected an invoice'; end if;
end $$;
reset role;

-- ── (j) A correction cannot slip under the credits already issued ───────────
-- The cap in 0412 only ever ran when a NOTE was written. 0417 made the INVOICE editable,
-- which reopened the same hole from the other side: shrink the invoice under its credits
-- and the customer's balance goes negative with nothing to explain it. Reproduced locally
-- before it was fixed; it did NOT show on the demo project only because that invoice had
-- a payment and the "below what has been paid" guard caught it first — luck, not cover.
set role authenticated;
do $$
declare v_inv uuid; v_cn uuid; ok boolean := false; v_after bigint; v_credits bigint;
begin
  reset role;
  -- A clean invoice with NO payments, most of it credited back.
  insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number, issue_date, due_date)
  values ('63000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
          '62100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'GAP-0001',
          current_date, current_date + 30) returning id into v_inv;
  insert into partner_document_lines (farm_id, document_id, sort_order, kind, description, qty, unit_price_cents)
  values ('62000000-0000-0000-0000-000000000001', v_inv, 0, 'labour', 'Big job', 1, 1000000);
  update partner_documents set status = 'sent', sent_at = now() where id = v_inv;

  insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                                 corrects_document_id, issue_date, vat_rate_bps)
  values ('63000000-0000-0000-0000-000000000002', '62000000-0000-0000-0000-000000000001',
          '62100000-0000-0000-0000-000000000001', 'credit_note', 'draft', 'built', 'GAPCN-0001',
          v_inv, current_date, 1500) returning id into v_cn;
  insert into partner_document_lines (farm_id, document_id, sort_order, kind, description, qty, unit_price_cents)
  values ('62000000-0000-0000-0000-000000000001', v_cn, 0, 'other', 'Credited back', 1, 900000);
  update partner_documents set status = 'sent', sent_at = now() where id = v_cn;

  set role authenticated;
  perform _t_login('62200000-0000-0000-0000-000000000001');
  begin
    perform public.revise_document(v_inv, 'Shrink it under the credit', '{}'::jsonb,
      jsonb_build_array(jsonb_build_object('kind','labour','description','Tiny','qty',1,'unit_price_cents',10000)));
  exception when others then ok := true; end;

  if not ok then
    select total_cents into v_after from partner_documents where id = v_inv;
    select coalesce(sum(total_cents),0) into v_credits from partner_documents
     where corrects_document_id = v_inv and kind = 'credit_note' and status not in ('draft','void');
    raise exception 'G3 FAIL [NEGATIVE BALANCE]: invoice corrected to % under % of credits — the customer''s balance is %',
      v_after, v_credits, v_after - v_credits;
  end if;

  -- Raising it, or leaving it alone, is still fine.
  perform public.revise_document(v_inv, 'Put it up instead', '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('kind','labour','description','Bigger','qty',1,'unit_price_cents',1200000)));
end $$;
reset role;

select 'ALL G3 REVISION & DEBIT-NOTE TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- G4 — THE HISTORY IS APPEND-ONLY (0420)
-- ═════════════════════════════════════════════════════════════════
-- The version history is what makes editing an issued document safe, so "can anyone
-- remove it?" is the load-bearing question. Before 0420 the honest answer was "not
-- really, by accident": UPDATE and DELETE matched no rows because 0417 defined only a
-- SELECT policy, so they ran, changed nothing, and RAISED NOTHING. Measured that way on
-- the live project. These assertions are about it refusing out loud.

set role authenticated;

-- ── (a) A partner cannot empty or rewrite their own history ─────────────────
do $$ declare ok boolean := false; c_before bigint; c_after bigint; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');        -- Workshop Z
  select count(*) into c_before from partner_document_revisions;
  if c_before = 0 then raise exception 'G4 FAIL [fixture]: no revisions to protect'; end if;

  begin
    delete from partner_document_revisions;
  exception when insufficient_privilege then ok := true; end;
  if not ok then
    raise exception 'G4 FAIL [SILENT]: deleting the version history did not even raise — an audit trail that can be quietly emptied is not one';
  end if;

  ok := false;
  begin
    update partner_document_revisions set reason = 'rewritten', total_cents_before = 0;
  exception when insufficient_privilege then ok := true; end;
  if not ok then
    raise exception 'G4 FAIL [SILENT]: rewriting the version history did not even raise';
  end if;

  select count(*) into c_after from partner_document_revisions;
  if c_after <> c_before then raise exception 'G4 FAIL: % revisions became %', c_before, c_after; end if;
  if not (select bool_and(reason <> 'rewritten') from partner_document_revisions) then
    raise exception 'G4 FAIL: a reason was rewritten';
  end if;
end $$;

-- ── (b) Nor forge one ────────────────────────────────────────────────────────
do $$ declare ok boolean := false; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  begin
    insert into partner_document_revisions (document_id, workshop_id, version, reason, snapshot, total_cents_before)
    select id, workshop_id, 99, 'forged', '{}'::jsonb, 0 from partner_documents
     where workshop_id = '62100000-0000-0000-0000-000000000001' limit 1;
  exception when others then ok := true; end;
  if not ok then raise exception 'G4 FAIL: a partner wrote a version by hand'; end if;
end $$;

-- ── (c) Neither can rr_admin, and neither can the farm ───────────────────────
-- Nobody has this. The trigger has no exception for a role — only for the one function
-- that writes it, from inside itself.
do $$ declare ok boolean := false; begin
  perform _t_login('d4444444-4444-4444-4444-444444444444');        -- rr_admin
  begin
    delete from partner_document_revisions;
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G4 FAIL: rr_admin emptied the version history'; end if;
end $$;
reset role;

-- ── (d) A draft has no history to lose ───────────────────────────────────────
-- `document_id` cascades and a DRAFT can still be deleted, so "revise a draft, then
-- delete it" would have taken its versions with it. Closed by refusing to revise a draft
-- at all — it is directly editable, so the correction machinery is redundant there.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number, issue_date, bill_to_name)
values ('64000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
        '62100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'DRAFT-0001',
        current_date, 'Farm S');

set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  begin
    perform public.revise_document('64000000-0000-0000-0000-000000000001', 'correct a draft', '{}'::jsonb, null);
  exception when insufficient_privilege then ok := true; end;
  if not ok then
    raise exception 'G4 FAIL: a draft was put through the correction machinery, so deleting it would take history with it';
  end if;
end $$;
reset role;

-- The draft can still be deleted, and there is no history for it to take.
delete from partner_documents where id = '64000000-0000-0000-0000-000000000001';
do $$ declare c bigint; begin
  select count(*) into c from partner_document_revisions
   where document_id = '64000000-0000-0000-0000-000000000001';
  if c <> 0 then raise exception 'G4 FAIL: a deleted draft left % orphan versions', c; end if;
end $$;

-- ── (e) And correcting an issued document still works ────────────────────────
-- The point of all the above is to make the edit safe, not to make it impossible.
set role authenticated;
do $$ declare v_rev int; v_versions bigint; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  perform public.revise_document('62500000-0000-0000-0000-000000000001',
    'Still works after the history was locked down', jsonb_build_object('subject', 'Locked down'), null);
  select revision into v_rev from partner_documents where id = '62500000-0000-0000-0000-000000000001';
  select count(*) into v_versions from partner_document_revisions
   where document_id = '62500000-0000-0000-0000-000000000001';
  if v_versions < 2 then
    raise exception 'G4 FAIL: the correction did not add a version (% on file, now revision %)', v_versions, v_rev;
  end if;
  -- and the outcome was stamped onto it, which needs the trigger to stand aside exactly once
  if exists (select 1 from partner_document_revisions
              where document_id = '62500000-0000-0000-0000-000000000001'
                and version = v_rev - 1 and total_cents_after is null) then
    raise exception 'G4 FAIL: the version was written but its outcome never recorded';
  end if;
end $$;
reset role;

select 'ALL G4 APPEND-ONLY-HISTORY TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- G5 — REFUNDS AND WRITE-OFFS (0422–0423)
-- ═════════════════════════════════════════════════════════════════
-- Two ways a balance goes to zero that the statement could not express, and both matter
-- for the same reason: a balance that cannot be cleared CORRECTLY sits on the page for
-- ever, and a customer who cannot reconcile their own statement stops reading it.
--
--   a refund     money going back after they had already paid. A negative payment, so the
--                running balance climbs back.
--   a write-off  they are never going to pay. The invoice stays at full value — the work
--                was done — but stops being outstanding, stops being chased, and posts a
--                matching credit so the account nets to zero.
--
-- The claim under test is that neither can be used to move money quietly: a refund cannot
-- exceed what was paid, a write-off needs a reason and keeps a version, and neither can be
-- done by a partner who did not issue the invoice.

-- A clean invoice of its own, so the assertions do not lean on G2/G3's arithmetic.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                               issue_date, due_date, vat_rate_bps, bill_to_name)
values ('65000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
        '62100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'ZI-9001',
        current_date - 120, current_date - 90, 1500, 'Farm S');

insert into partner_document_lines (document_id, farm_id, sort_order, kind,
                                    description, qty, unit_price_cents)
values ('65000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
        1, 'labour', 'Gearbox strip and rebuild', 1, 1000000);

update partner_documents set status = 'sent', sent_at = now()
 where id = '65000000-0000-0000-0000-000000000001';

do $$ declare v_total bigint; begin
  select total_cents into v_total from partner_documents where id = '65000000-0000-0000-0000-000000000001';
  if v_total <> 1150000 then
    raise exception 'G5 SETUP: the fixture invoice totals % (expected 1150000 incl VAT)', v_total;
  end if;
end $$;

-- ── (a) A refund is negative and a payment is positive ───────────────────────
-- Stated as a constraint so no code path — ours or a future one — can write a payment
-- whose sign disagrees with what it claims to be.
do $$ declare ok boolean := false; begin
  begin
    insert into partner_payments (farm_id, document_id, amount_cents, is_refund, paid_on)
    values ('62000000-0000-0000-0000-000000000001', '65000000-0000-0000-0000-000000000001',
            50000, true, current_date);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'G5 FAIL: a POSITIVE refund was accepted — the sign says money came in'; end if;
end $$;

do $$ declare ok boolean := false; begin
  begin
    insert into partner_payments (farm_id, document_id, amount_cents, is_refund, paid_on)
    values ('62000000-0000-0000-0000-000000000001', '65000000-0000-0000-0000-000000000001',
            -50000, false, current_date);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'G5 FAIL: a NEGATIVE payment was accepted without being called a refund'; end if;
end $$;

-- ── (b) You cannot refund money that never arrived ───────────────────────────
do $$ declare ok boolean := false; v_paid bigint; begin
  begin
    insert into partner_payments (farm_id, document_id, amount_cents, is_refund, paid_on)
    values ('62000000-0000-0000-0000-000000000001', '65000000-0000-0000-0000-000000000001',
            -20000, true, current_date);
  exception when check_violation then ok := true; end;
  if not ok then
    raise exception 'G5 FAIL: an invoice with no payments was refunded — the account now shows a negative receipt';
  end if;
  select amount_paid_cents into v_paid from partner_documents where id = '65000000-0000-0000-0000-000000000001';
  if v_paid <> 0 then raise exception 'G5 FAIL: the refused refund still moved amount_paid to %', v_paid; end if;
end $$;

-- ── (c) A real payment, then a real refund ───────────────────────────────────
insert into partner_payments (farm_id, document_id, amount_cents, is_refund, paid_on, method)
values ('62000000-0000-0000-0000-000000000001', '65000000-0000-0000-0000-000000000001',
        400000, false, current_date - 60, 'eft');
insert into partner_payments (farm_id, document_id, amount_cents, is_refund, paid_on, method)
values ('62000000-0000-0000-0000-000000000001', '65000000-0000-0000-0000-000000000001',
        -100000, true, current_date - 30, 'eft');

do $$ declare v_paid bigint; v_status text; v_credit bigint; begin
  select amount_paid_cents, status::text into v_paid, v_status
    from partner_documents where id = '65000000-0000-0000-0000-000000000001';
  if v_paid <> 300000 then
    raise exception 'G5 FAIL: after R4 000 in and R1 000 back, the invoice shows % paid (expected 300000)', v_paid;
  end if;
  if v_status <> 'part_paid' then raise exception 'G5 FAIL: the invoice is % after a partial payment', v_status; end if;

  -- On the statement the refund is a NEGATIVE credit, so the balance climbs back.
  select credit_cents into v_credit
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 400, current_date)
   where kind = 'refund' and document_id = '65000000-0000-0000-0000-000000000001';
  if v_credit is null or v_credit >= 0 then
    raise exception 'G5 FAIL: the refund reads as % on the statement — it has to reduce what was received', v_credit;
  end if;
end $$;

-- ── (d) Writing off needs a reason, and belongs to the issuer ────────────────
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');        -- Workshop Z, the issuer
  begin
    perform public.write_off_document('65000000-0000-0000-0000-000000000001', '  ');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'G5 FAIL: an invoice was written off with no reason given'; end if;
end $$;

do $$ declare ok boolean := false; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');        -- Workshop W, unrelated
  begin
    perform public.write_off_document('65000000-0000-0000-0000-000000000001', 'not my invoice');
  exception when insufficient_privilege or no_data_found then ok := true; end;
  if not ok then
    raise exception 'G5 FAIL [CROSS-PARTNER]: another workshop wrote off Workshop Z''s invoice';
  end if;
end $$;

-- The farm cannot write off its own debt either — it is the partner's decision to stop
-- asking for the money, not the debtor's.
do $$ declare ok boolean := false; begin
  perform _t_login('62300000-0000-0000-0000-000000000001');        -- Farm S owner
  begin
    perform public.write_off_document('65000000-0000-0000-0000-000000000001', 'we are not paying this');
  exception when insufficient_privilege or no_data_found then ok := true; end;
  if not ok then raise exception 'G5 FAIL: the customer wrote off their own bill'; end if;
end $$;
reset role;

-- ── (e) The write-off itself ─────────────────────────────────────────────────
do $$ declare v_before bigint; begin
  select total_cents into v_before from app.partner_ageing(
    '62100000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', null, current_date);
  create temp table _t_g5_ageing as select v_before as cents;
end $$;

set role authenticated;
do $$ declare v_versions bigint; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  perform public.write_off_document('65000000-0000-0000-0000-000000000001',
                                    'Business liquidated, three letters unanswered');
  select count(*) into v_versions from partner_document_revisions
   where document_id = '65000000-0000-0000-0000-000000000001';
  if v_versions <> 1 then
    raise exception 'G5 FAIL: writing off left % versions on file (expected 1) — the decision has no before-picture', v_versions;
  end if;
end $$;
reset role;

do $$ declare v_status text; v_reason text; begin
  select status::text, written_off_reason into v_status, v_reason
    from partner_documents where id = '65000000-0000-0000-0000-000000000001';
  if v_status <> 'written_off' then raise exception 'G5 FAIL: the invoice is % after a write-off', v_status; end if;
  if v_reason is null then raise exception 'G5 FAIL: the reason was not kept'; end if;
end $$;

-- It stops being money anyone is waiting for …
do $$ declare v_after bigint; v_before bigint; begin
  select cents into v_before from _t_g5_ageing;
  select total_cents into v_after from app.partner_ageing(
    '62100000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', null, current_date);
  if v_after <> v_before - 850000 then
    raise exception 'G5 FAIL [AGEING]: outstanding went % → % ; the R8 500 still owed on a written-off invoice is still being counted',
      v_before, v_after;
  end if;
end $$;

-- … and stops being chased.
do $$ declare c bigint; begin
  perform app.enqueue_document_reminders();
  select count(*) into c from notifications
   where payload->>'document_id' = '65000000-0000-0000-0000-000000000001'
     and template like 'invoice_%';
  if c <> 0 then
    raise exception 'G5 FAIL: % reminders were queued for an invoice nobody is collecting', c;
  end if;
end $$;

-- ── (f) The statement stays readable, and nets to zero ───────────────────────
-- The invoice is still there at full value, because the customer really was billed it.
-- The write-off posts its own credit line, so the account does not carry a balance for a
-- debt everyone has given up on.
do $$ declare v_net bigint; v_writeoff bigint; v_rows bigint; begin
  select coalesce(sum(debit_cents - credit_cents), 0), count(*) into v_net, v_rows
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 400, current_date)
   where document_id = '65000000-0000-0000-0000-000000000001';
  if v_rows < 4 then
    raise exception 'G5 FAIL: the written-off invoice shows only % lines — invoice, payment, refund and write-off are all part of what happened', v_rows;
  end if;
  if v_net <> 0 then
    raise exception 'G5 FAIL [STATEMENT]: the written-off invoice leaves % on the account — a statement that cannot be cleared is one nobody can reconcile', v_net;
  end if;

  select credit_cents into v_writeoff
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 400, current_date)
   where kind = 'write_off' and document_id = '65000000-0000-0000-0000-000000000001';
  if v_writeoff <> 850000 then
    raise exception 'G5 FAIL: the write-off credited % (expected the 850000 still owed)', v_writeoff;
  end if;
end $$;

-- ── (g) The farm still carries the cost ──────────────────────────────────────
-- Not paying a bill does not un-do the work. The machine's cost of ownership keeps it.
do $$ declare v_cents bigint; begin
  select amount_cents into v_cents from cost_entries
   where source_type = 'partner_document' and source_id = '65000000-0000-0000-0000-000000000001'
     and deleted_at is null;
  if v_cents is null then
    raise exception 'G5 FAIL [LEDGER]: writing the invoice off deleted the farm''s cost entry — the work still happened';
  end if;
  if v_cents <> 1000000 then
    raise exception 'G5 FAIL: the cost entry is % (expected the 1000000 ex-VAT that was billed)', v_cents;
  end if;
end $$;

-- ── (h) It cannot be written off twice, or quietly reopened ──────────────────
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  begin
    perform public.write_off_document('65000000-0000-0000-0000-000000000001', 'again for luck');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G5 FAIL: the same invoice was written off twice'; end if;
end $$;
reset role;

-- Removing a payment must not quietly put it back into the ageing …
delete from partner_payments
 where document_id = '65000000-0000-0000-0000-000000000001' and is_refund;
do $$ declare v_status text; begin
  select status::text into v_status from partner_documents where id = '65000000-0000-0000-0000-000000000001';
  if v_status <> 'written_off' then
    raise exception 'G5 FAIL: touching a payment reopened a written-off invoice (now %)', v_status;
  end if;
end $$;

-- … but real money arriving after all does reopen it, which is the honest answer.
insert into partner_payments (farm_id, document_id, amount_cents, is_refund, paid_on, method)
values ('62000000-0000-0000-0000-000000000001', '65000000-0000-0000-0000-000000000001',
        750000, false, current_date, 'eft');
do $$ declare v_status text; begin
  select status::text into v_status from partner_documents where id = '65000000-0000-0000-0000-000000000001';
  if v_status <> 'paid' then
    raise exception 'G5 FAIL: the customer paid in full after the write-off and the invoice still reads %', v_status;
  end if;
end $$;

select 'ALL G5 REFUND & WRITE-OFF TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- G6 — THE PURCHASE SIDE AND THE VAT RETURN (0430–0431)
-- ═════════════════════════════════════════════════════════════════
-- Two claims. First, a partner's purchases are the partner's: not the farms they work
-- for, not another contractor, nobody. A farm being able to read what its contractor pays
-- its suppliers would hand over the contractor's margin on every job, which is exactly
-- the class of leak F16 was built to close — so the new table gets the same treatment
-- from the start rather than being tightened later.
--
-- Second, the VAT return has to be arithmetic somebody can be audited on: output VAT on
-- the invoice basis, credit notes subtracting, drafts and voids absent, and input VAT
-- only where it may actually be claimed.

insert into partner_expenses (id, workshop_id, supplier_name, category, expense_date,
                              amount_cents, vat_rate_bps, vat_cents, vat_claimable)
values
  -- Workshop Z's own purchases, inside the period. The G6 window is a quiet stretch of the
  -- calendar nothing else in this suite uses, so the arithmetic below states its own
  -- inputs rather than inheriting every document G2–G5 happened to leave lying around.
  ('66000000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001',
   'Bearing Supplies', 'parts', current_date - 276, 200000, 1500, 30000, true),
  -- Claimed VAT it may NOT claim (entertainment) — must be excluded from input VAT
  ('66000000-0000-0000-0000-000000000002', '62100000-0000-0000-0000-000000000001',
   'Steakhouse', 'other', current_date - 275, 100000, 1500, 15000, false),
  -- Outside the period entirely
  ('66000000-0000-0000-0000-000000000003', '62100000-0000-0000-0000-000000000001',
   'Old Supplier', 'parts', current_date - 400, 500000, 1500, 75000, true);

-- ── (a) A farm cannot read its contractor's purchases ────────────────────────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('62300000-0000-0000-0000-000000000001');        -- Farm S owner
  select count(*) into c from partner_expenses;
  if c <> 0 then
    raise exception 'G6 FAIL [MARGIN LEAK]: a farm read % of its contractor''s supplier invoices', c;
  end if;
end $$;

-- ── (b) Nor can another contractor ───────────────────────────────────────────
do $$ declare c bigint; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');        -- Workshop W
  select count(*) into c from partner_expenses;
  if c <> 0 then raise exception 'G6 FAIL [COMPETITOR]: another workshop read % purchase rows', c; end if;
end $$;

-- ── (c) And a contractor cannot write into somebody else's books ─────────────
do $$ declare ok boolean := false; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');
  begin
    insert into partner_expenses (workshop_id, supplier_name, expense_date, amount_cents)
    values ('62100000-0000-0000-0000-000000000001', 'Planted', current_date, 100000);
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G6 FAIL: a workshop wrote an expense into another workshop''s books'; end if;
end $$;

-- ── (d) The owner sees exactly its own ───────────────────────────────────────
do $$ declare c bigint; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');        -- Workshop Z
  select count(*) into c from partner_expenses;
  if c <> 3 then raise exception 'G6 FAIL: Workshop Z sees % of its own 3 purchases', c; end if;
end $$;
reset role;

-- ── (e) Anon reaches nothing, and cannot run the return ──────────────────────
set role anon;
do $$ declare ok boolean := false; begin
  begin perform count(*) from partner_expenses; exception when others then ok := true; end;
  if not ok then raise exception 'G6 FAIL: anon read the purchase ledger'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform app.partner_vat_return(null, current_date, current_date);
  exception when others then ok := true; end;
  if not ok then raise exception 'G6 FAIL: anon ran the VAT return'; end if;
end $$;
reset role;

-- ── (f) The arithmetic ───────────────────────────────────────────────────────
-- Built from scratch for this section so the assertion states its own inputs: two
-- invoices, a credit note against one, a draft that must not count, and a voided one.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                               issue_date, vat_rate_bps, bill_to_name)
values
  ('67000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
   '62100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'ZV-0001', current_date - 280, 1500, 'Farm S'),
  ('67000000-0000-0000-0000-000000000002', '62000000-0000-0000-0000-000000000001',
   '62100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'ZV-0002', current_date - 279, 1500, 'Farm S'),
  ('67000000-0000-0000-0000-000000000003', '62000000-0000-0000-0000-000000000001',
   '62100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'ZV-0003', current_date - 278, 1500, 'Farm S');

insert into partner_document_lines (document_id, farm_id, sort_order, kind, description, qty, unit_price_cents)
values
  ('67000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 1, 'labour', 'Job one',   1, 1000000),
  ('67000000-0000-0000-0000-000000000002', '62000000-0000-0000-0000-000000000001', 1, 'labour', 'Job two',   1,  400000),
  ('67000000-0000-0000-0000-000000000003', '62000000-0000-0000-0000-000000000001', 1, 'labour', 'Never sent',1,  900000);

-- Two are issued; ZV-0003 stays a DRAFT and must be invisible to the return.
update partner_documents set status = 'sent', sent_at = now()
 where id in ('67000000-0000-0000-0000-000000000001', '67000000-0000-0000-0000-000000000002');

-- A credit note against the first, for R1 000 ex-VAT.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number, issue_date,
                               vat_rate_bps, bill_to_name, corrects_document_id)
values ('67000000-0000-0000-0000-000000000004', '62000000-0000-0000-0000-000000000001',
        '62100000-0000-0000-0000-000000000001', 'credit_note', 'draft', 'built', 'ZCN-0001',
        current_date - 277, 1500, 'Farm S', '67000000-0000-0000-0000-000000000001');
insert into partner_document_lines (document_id, farm_id, sort_order, kind, description, qty, unit_price_cents)
values ('67000000-0000-0000-0000-000000000004', '62000000-0000-0000-0000-000000000001', 1, 'other', 'Overcharged', 1, 100000);
update partner_documents set status = 'sent' where id = '67000000-0000-0000-0000-000000000004';

set role authenticated;
do $$
declare v record; v_expected_output bigint;
begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  select * into v from app.partner_vat_return(
    '62100000-0000-0000-0000-000000000001', current_date - 300, current_date - 250);

  -- Sales at the standard rate: R10 000 + R4 000 ex-VAT. The DRAFT is not a supply.
  if v.standard_ex_cents <> 1400000 then
    raise exception 'G6 FAIL: standard-rated sales are % (expected 1400000 — a draft or a void has been counted)', v.standard_ex_cents;
  end if;

  -- Output VAT: 15% of (10 000 + 4 000 − 1 000) = R1 950.
  v_expected_output := 195000;
  if v.output_vat_cents <> v_expected_output then
    raise exception 'G6 FAIL: output VAT is % (expected % — the credit note must SUBTRACT)',
      v.output_vat_cents, v_expected_output;
  end if;
  if v.credits_ex_cents <> 100000 then
    raise exception 'G6 FAIL: credit notes total % (expected 100000)', v.credits_ex_cents;
  end if;

  -- Input VAT: only the claimable purchase inside the window. The steakhouse is blocked,
  -- the year-old invoice is out of period.
  if v.input_vat_cents <> 30000 then
    raise exception 'G6 FAIL: input VAT is % (expected 30000 — blocked or out-of-period VAT has been claimed)', v.input_vat_cents;
  end if;
  if v.blocked_vat_cents <> 15000 then
    raise exception 'G6 FAIL: blocked VAT is % (expected 15000, shown but not claimed)', v.blocked_vat_cents;
  end if;

  -- And the answer.
  if v.net_vat_cents <> 195000 - 30000 then
    raise exception 'G6 FAIL: net VAT is % (expected %)', v.net_vat_cents, 195000 - 30000;
  end if;
end $$;

-- ── (g) Another partner's return is not readable through the same function ───
-- SECURITY INVOKER, so RLS answers: a workshop passing somebody else's id gets zeroes
-- rather than their turnover.
do $$ declare v record; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');        -- Workshop W
  select * into v from app.partner_vat_return(
    '62100000-0000-0000-0000-000000000001', current_date - 300, current_date - 250);
  if coalesce(v.output_vat_cents, 0) <> 0 or coalesce(v.input_vat_cents, 0) <> 0 then
    raise exception 'G6 FAIL [CROSS-PARTNER]: another workshop read Z''s VAT position (output %, input %)',
      v.output_vat_cents, v.input_vat_cents;
  end if;
end $$;
reset role;

-- ── (h) A written-off invoice still declared its VAT ─────────────────────────
-- The supply happened. Bad-debt relief is a separate claim (s22), so the return reports
-- the amount rather than quietly removing it.
set role authenticated;
do $$ declare v record; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  perform public.write_off_document('67000000-0000-0000-0000-000000000002', 'Customer disappeared');
  select * into v from app.partner_vat_return(
    '62100000-0000-0000-0000-000000000001', current_date - 300, current_date - 250);
  if v.output_vat_cents <> 195000 then
    raise exception 'G6 FAIL: writing an invoice off changed the VAT declared (now %) — the supply still happened', v.output_vat_cents;
  end if;
  if v.written_off_vat_cents <> 60000 then
    raise exception 'G6 FAIL: written-off VAT reported as % (expected 60000, so a s22 claim can be raised knowingly)',
      v.written_off_vat_cents;
  end if;
end $$;
reset role;

select 'ALL G6 PURCHASE & VAT TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- G7 — BILLING A JOB IN STAGES (0432)
-- ═════════════════════════════════════════════════════════════════
-- A deposit and a progress payment are the same act to a ledger: an invoice for PART of
-- an agreed job. The claim under test is the one that makes that shape safe — three
-- invoices against one quote put their OWN amounts into the farm's costs and nothing
-- more, because nothing is netted anywhere.
--
-- The failure this guards against is the one every "deposit feature" eventually has: a
-- deposit that is also deducted from the final invoice, so the money is counted once as
-- a deposit and once as a deduction, and the cost ledger disagrees with the statement.

-- A R10 000 ex-VAT quote (R11 500 incl) for Farm S from Workshop Z.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                               issue_date, vat_rate_bps, bill_to_name)
values ('68000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
        '62100000-0000-0000-0000-000000000001', 'quote', 'draft', 'built', 'ZSQ-0001',
        current_date - 240, 1500, 'Farm S');
insert into partner_document_lines (document_id, farm_id, sort_order, kind, description, qty, unit_price_cents)
values ('68000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
        1, 'labour', 'Full engine rebuild', 1, 1000000);
update partner_documents set status = 'accepted' where id = '68000000-0000-0000-0000-000000000001';

-- ── (a) Nothing billed yet ───────────────────────────────────────────────────
set role authenticated;
do $$ declare b record; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  select * into b from app.quote_billing('68000000-0000-0000-0000-000000000001');
  if b.quoted_cents <> 1150000 then raise exception 'G7 FAIL: the quote reads % (expected 1150000 incl VAT)', b.quoted_cents; end if;
  if b.billed_cents <> 0 or b.remaining_cents <> 1150000 then
    raise exception 'G7 FAIL: a quote with no invoices says % billed / % remaining', b.billed_cents, b.remaining_cents;
  end if;
end $$;
reset role;

-- ── (b) A draft stage is not billed ──────────────────────────────────────────
-- A draft has not left the building. Counting it would tell a partner they had asked for
-- money they have not asked for.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number, issue_date,
                               vat_rate_bps, bill_to_name, quote_id, billing_stage, stage_label)
values ('68000000-0000-0000-0000-000000000002', '62000000-0000-0000-0000-000000000001',
        '62100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'ZSI-0001',
        current_date - 239, 1500, 'Farm S', '68000000-0000-0000-0000-000000000001', 'deposit', '50% deposit');
insert into partner_document_lines (document_id, farm_id, sort_order, kind, description, qty, unit_price_cents)
values ('68000000-0000-0000-0000-000000000002', '62000000-0000-0000-0000-000000000001', 1, 'other', '50% deposit', 1, 500000);

set role authenticated;
do $$ declare b record; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  select * into b from app.quote_billing('68000000-0000-0000-0000-000000000001');
  if b.billed_cents <> 0 then raise exception 'G7 FAIL: a DRAFT stage counted as billed (%)', b.billed_cents; end if;
  if b.draft_cents <> 575000 then raise exception 'G7 FAIL: the draft is reported as % (expected 575000)', b.draft_cents; end if;
end $$;
reset role;

-- ── (c) Send it, and it counts ───────────────────────────────────────────────
update partner_documents set status = 'sent', sent_at = now() where id = '68000000-0000-0000-0000-000000000002';

set role authenticated;
do $$ declare b record; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  select * into b from app.quote_billing('68000000-0000-0000-0000-000000000001');
  if b.billed_cents <> 575000 or b.remaining_cents <> 575000 then
    raise exception 'G7 FAIL: after a 50%% deposit the quote says % billed / % remaining', b.billed_cents, b.remaining_cents;
  end if;
end $$;
reset role;

-- ── (d) The balance, and NO DOUBLE COUNTING in the farm's ledger ─────────────
-- The whole reason for this shape. Each stage carries its own lines and its own cost
-- entry; there is no "less deposit previously invoiced" line to get wrong.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number, issue_date,
                               vat_rate_bps, bill_to_name, quote_id, billing_stage, stage_label)
values ('68000000-0000-0000-0000-000000000003', '62000000-0000-0000-0000-000000000001',
        '62100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'ZSI-0002',
        current_date - 200, 1500, 'Farm S', '68000000-0000-0000-0000-000000000001', 'final', 'Balance on completion');
insert into partner_document_lines (document_id, farm_id, sort_order, kind, description, qty, unit_price_cents)
values ('68000000-0000-0000-0000-000000000003', '62000000-0000-0000-0000-000000000001', 1, 'other', 'Balance', 1, 500000);
update partner_documents set status = 'sent', sent_at = now() where id = '68000000-0000-0000-0000-000000000003';

do $$ declare v_ledger bigint; begin
  select coalesce(sum(amount_cents), 0) into v_ledger from cost_entries
   where source_type = 'partner_document'
     and source_id in ('68000000-0000-0000-0000-000000000002', '68000000-0000-0000-0000-000000000003')
     and deleted_at is null;
  if v_ledger <> 1000000 then
    raise exception 'G7 FAIL [DOUBLE COUNT]: two stages of a R10 000 job put % into the farm''s costs', v_ledger;
  end if;
  -- and the quote itself never books a cost, because a quote is not money owed
  if exists (select 1 from cost_entries where source_type = 'partner_document'
              and source_id = '68000000-0000-0000-0000-000000000001' and deleted_at is null) then
    raise exception 'G7 FAIL: the QUOTE was costed as well as the invoices raised against it';
  end if;
end $$;

set role authenticated;
do $$ declare b record; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  select * into b from app.quote_billing('68000000-0000-0000-0000-000000000001');
  if b.billed_cents <> 1150000 or b.remaining_cents <> 0 then
    raise exception 'G7 FAIL: fully billed quote says % billed / % remaining', b.billed_cents, b.remaining_cents;
  end if;
  if b.over_billed then raise exception 'G7 FAIL: billing exactly the quote was flagged as over-billing'; end if;
  if b.invoice_count <> 2 then raise exception 'G7 FAIL: % stage invoices counted (expected 2)', b.invoice_count; end if;
end $$;
reset role;

-- ── (e) Both stages appear on the statement, in their own right ──────────────
do $$ declare c bigint; v_charged bigint; begin
  select count(*), coalesce(sum(debit_cents), 0) into c, v_charged
    from app.partner_statement('62100000-0000-0000-0000-000000000001',
                               '62000000-0000-0000-0000-000000000001', null,
                               current_date - 260, current_date - 190)
   where document_id in ('68000000-0000-0000-0000-000000000002', '68000000-0000-0000-0000-000000000003');
  if c <> 2 then raise exception 'G7 FAIL: % of the 2 stage invoices reached the statement', c; end if;
  if v_charged <> 1150000 then
    raise exception 'G7 FAIL: the statement charges % for a R11 500 job billed in two halves', v_charged;
  end if;
end $$;

-- ── (f) Over-billing is flagged, not refused ─────────────────────────────────
-- Jobs grow. Refusing the invoice would push the partner outside the system, which is
-- worse than a number in orange.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number, issue_date,
                               vat_rate_bps, bill_to_name, quote_id, billing_stage)
values ('68000000-0000-0000-0000-000000000004', '62000000-0000-0000-0000-000000000001',
        '62100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'ZSI-0003',
        current_date - 195, 1500, 'Farm S', '68000000-0000-0000-0000-000000000001', 'progress');
insert into partner_document_lines (document_id, farm_id, sort_order, kind, description, qty, unit_price_cents)
values ('68000000-0000-0000-0000-000000000004', '62000000-0000-0000-0000-000000000001', 1, 'other', 'Extra work found', 1, 200000);
update partner_documents set status = 'sent', sent_at = now() where id = '68000000-0000-0000-0000-000000000004';

set role authenticated;
do $$ declare b record; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  select * into b from app.quote_billing('68000000-0000-0000-0000-000000000001');
  if not b.over_billed then
    raise exception 'G7 FAIL: billing % against a % quote was not flagged', b.billed_cents, b.quoted_cents;
  end if;
  if b.remaining_cents <> 0 then
    raise exception 'G7 FAIL: over-billed remaining went negative (%) instead of flooring at zero', b.remaining_cents;
  end if;
end $$;

-- ── (g) A stage must belong to a quote, and only an invoice can be one ───────
do $$ declare ok boolean := false; begin
  begin
    insert into partner_documents (farm_id, workshop_id, kind, status, source, number, issue_date, bill_to_name, billing_stage)
    values ('62000000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001',
            'invoice', 'draft', 'built', 'ZSI-9999', current_date, 'Farm S', 'deposit');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'G7 FAIL: an invoice was marked a deposit with no job to be a deposit for'; end if;
end $$;
reset role;

-- ── (h) The other farm sees none of it ───────────────────────────────────────
set role authenticated;
do $$ declare b record; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');        -- Farm B owner
  select * into b from app.quote_billing('68000000-0000-0000-0000-000000000001');
  if coalesce(b.quoted_cents, 0) <> 0 or coalesce(b.billed_cents, 0) <> 0 then
    raise exception 'G7 FAIL [CROSS-TENANT]: another farm read the billing state of Farm S''s job';
  end if;
end $$;
reset role;

select 'ALL G7 STAGE-BILLING TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- G8 — STANDING INVOICES (0433)
-- ═════════════════════════════════════════════════════════════════
-- The whole point of a schedule is that it runs when nobody is watching, which makes two
-- things load-bearing: it must be impossible to bill a customer twice for the same month,
-- and a partner must not be able to point a schedule at somebody else's business.
--
-- Double-billing is the failure that matters. A cron can fire twice, a night can fail
-- half-way and be retried, and a partner can press "raise it now" on a schedule that has
-- already run. All three go through the same generator, so all three are tested here.

insert into recurring_invoices (id, workshop_id, farm_id, name, subject, cadence,
                                next_issue_date, vat_rate_bps, created_by)
values ('69000000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001',
        '62000000-0000-0000-0000-000000000001', 'Monthly service contract',
        'Service contract', 'monthly', current_date - 150, 1500,
        '62200000-0000-0000-0000-000000000001');

insert into recurring_invoice_lines (recurring_id, workshop_id, sort_order, kind, description, qty, unit_price_cents)
values ('69000000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001',
        0, 'other', 'Monthly service contract', 1, 300000);

-- ── (a) It raises exactly one invoice ────────────────────────────────────────
do $$ declare v_made int; c bigint; begin
  select app.generate_recurring_invoices('69000000-0000-0000-0000-000000000001') into v_made;
  if v_made <> 1 then raise exception 'G8 FAIL: the generator raised % invoices (expected 1)', v_made; end if;

  select count(*) into c from partner_documents
   where workshop_id = '62100000-0000-0000-0000-000000000001'
     and issue_date = current_date - 150 and kind = 'invoice' and deleted_at is null;
  if c <> 1 then raise exception 'G8 FAIL: % invoices exist for the first period', c; end if;
end $$;

-- … as a DRAFT, because nothing should reach a customer nobody has looked at …
do $$ declare st text; v_total bigint; begin
  select d.status::text, d.total_cents into st, v_total
    from partner_documents d
    join recurring_invoices r on r.last_document_id = d.id
   where r.id = '69000000-0000-0000-0000-000000000001';
  if st <> 'draft' then
    raise exception 'G8 FAIL: a schedule with auto_send off produced a % invoice', st;
  end if;
  if v_total <> 345000 then
    raise exception 'G8 FAIL: the generated invoice totals % (expected 345000 incl VAT)', v_total;
  end if;
end $$;

-- … and the schedule moved on by exactly one month.
do $$ declare v_next date; v_last date; begin
  select next_issue_date, last_period_start into v_next, v_last
    from recurring_invoices where id = '69000000-0000-0000-0000-000000000001';
  if v_last <> current_date - 150 then
    raise exception 'G8 FAIL: last_period_start is % (expected the period just raised)', v_last;
  end if;
  if v_next <> (current_date - 150 + interval '1 month')::date then
    raise exception 'G8 FAIL: next_issue_date is % (expected one month on)', v_next;
  end if;
end $$;

-- ── (b) THE ONE THAT MATTERS: it cannot bill the same period twice ───────────
-- The generator is re-run against the SAME period by forcing the date back, which is what
-- a retry after a half-finished night looks like from the database's point of view.
update recurring_invoices set next_issue_date = last_period_start
 where id = '69000000-0000-0000-0000-000000000001';

do $$ declare v_made int; c bigint; begin
  select app.generate_recurring_invoices('69000000-0000-0000-0000-000000000001') into v_made;
  if v_made <> 0 then
    raise exception 'G8 FAIL [DOUBLE BILL]: re-running the same period raised % more invoices', v_made;
  end if;
  select count(*) into c from partner_documents
   where workshop_id = '62100000-0000-0000-0000-000000000001'
     and issue_date = current_date - 150 and kind = 'invoice' and deleted_at is null;
  if c <> 1 then
    raise exception 'G8 FAIL [DOUBLE BILL]: % invoices now exist for one month', c;
  end if;
end $$;

-- And the skipped run still moved the date on, so the schedule is not stuck for ever.
do $$ declare v_next date; begin
  select next_issue_date into v_next from recurring_invoices where id = '69000000-0000-0000-0000-000000000001';
  if v_next <= current_date - 150 then
    raise exception 'G8 FAIL: a skipped run left the schedule stuck on %', v_next;
  end if;
end $$;

-- ── (c) A schedule with no lines raises nothing ──────────────────────────────
-- Better than a R0,00 invoice arriving at a customer every month.
insert into recurring_invoices (id, workshop_id, farm_id, name, cadence, next_issue_date, created_by)
values ('69000000-0000-0000-0000-000000000002', '62100000-0000-0000-0000-000000000001',
        '62000000-0000-0000-0000-000000000001', 'Empty schedule', 'monthly', current_date - 5,
        '62200000-0000-0000-0000-000000000001');
do $$ declare v_made int; begin
  select app.generate_recurring_invoices('69000000-0000-0000-0000-000000000002') into v_made;
  if v_made <> 0 then raise exception 'G8 FAIL: a schedule with no lines raised % invoices', v_made; end if;
end $$;

-- ── (d) auto_send produces a SENT invoice, and it is costed ──────────────────
insert into recurring_invoices (id, workshop_id, farm_id, name, cadence, next_issue_date,
                                vat_rate_bps, auto_send, created_by)
values ('69000000-0000-0000-0000-000000000003', '62100000-0000-0000-0000-000000000001',
        '62000000-0000-0000-0000-000000000001', 'Auto retainer', 'monthly', current_date - 3,
        1500, true, '62200000-0000-0000-0000-000000000001');
insert into recurring_invoice_lines (recurring_id, workshop_id, sort_order, kind, description, qty, unit_price_cents)
values ('69000000-0000-0000-0000-000000000003', '62100000-0000-0000-0000-000000000001',
        0, 'other', 'Retainer', 1, 100000);

do $$ declare st text; v_doc uuid; v_cost bigint; begin
  perform app.generate_recurring_invoices('69000000-0000-0000-0000-000000000003');
  select last_document_id into v_doc from recurring_invoices where id = '69000000-0000-0000-0000-000000000003';
  select status::text into st from partner_documents where id = v_doc;
  if st <> 'sent' then raise exception 'G8 FAIL: auto_send produced a % invoice', st; end if;

  -- A generated invoice is an ordinary invoice: it reaches the farm's cost ledger like
  -- any other, through the same 0418 trigger.
  select amount_cents into v_cost from cost_entries
   where source_type = 'partner_document' and source_id = v_doc and deleted_at is null;
  if coalesce(v_cost, 0) <> 100000 then
    raise exception 'G8 FAIL: a generated invoice booked % to the farm''s costs (expected 100000 ex VAT)', v_cost;
  end if;
end $$;

-- ── (e) It stops at its end date ─────────────────────────────────────────────
insert into recurring_invoices (id, workshop_id, farm_id, name, cadence, next_issue_date,
                                ends_on, vat_rate_bps, created_by)
values ('69000000-0000-0000-0000-000000000004', '62100000-0000-0000-0000-000000000001',
        '62000000-0000-0000-0000-000000000001', 'Ends soon', 'monthly', current_date - 2,
        current_date, 1500, '62200000-0000-0000-0000-000000000001');
insert into recurring_invoice_lines (recurring_id, workshop_id, sort_order, kind, description, qty, unit_price_cents)
values ('69000000-0000-0000-0000-000000000004', '62100000-0000-0000-0000-000000000001', 0, 'other', 'Last one', 1, 50000);

do $$ declare v_active boolean; begin
  perform app.generate_recurring_invoices('69000000-0000-0000-0000-000000000004');
  select active into v_active from recurring_invoices where id = '69000000-0000-0000-0000-000000000004';
  if v_active then
    raise exception 'G8 FAIL: a schedule past its end date is still active and will bill for ever';
  end if;
end $$;

-- ── (f) A partner cannot reach another partner's schedules ───────────────────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');        -- Workshop W
  select count(*) into c from recurring_invoices;
  if c <> 0 then raise exception 'G8 FAIL [CROSS-PARTNER]: another workshop read % schedules', c; end if;
end $$;

-- … nor run one, which is the dangerous half: the generator underneath is SECURITY
-- DEFINER, so the ownership check has to live in the RPC rather than in RLS.
do $$ declare ok boolean := false; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');
  begin
    perform public.run_recurring_invoice('69000000-0000-0000-0000-000000000001');
  exception when insufficient_privilege or no_data_found then ok := true; end;
  if not ok then
    raise exception 'G8 FAIL [PRIVILEGE]: another workshop raised an invoice from Z''s schedule';
  end if;
end $$;

-- … and the farm being billed cannot read or run it either.
do $$ declare c bigint; begin
  perform _t_login('62300000-0000-0000-0000-000000000001');        -- Farm S owner
  select count(*) into c from recurring_invoices;
  if c <> 0 then raise exception 'G8 FAIL: the farm being billed read % of its contractor''s schedules', c; end if;
end $$;

-- ── (g) The generator itself is not callable from a session ──────────────────
do $$ declare ok boolean := false; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  begin perform app.generate_recurring_invoices(null);
  exception when insufficient_privilege then ok := true; end;
  if not ok then
    raise exception 'G8 FAIL: a signed-in user ran the generator directly, bypassing the ownership check';
  end if;
end $$;
reset role;

set role anon;
do $$ declare ok boolean := false; begin
  begin perform count(*) from recurring_invoices; exception when others then ok := true; end;
  if not ok then raise exception 'G8 FAIL: anon read the schedules'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform public.run_recurring_invoice('69000000-0000-0000-0000-000000000001');
  exception when others then ok := true; end;
  if not ok then raise exception 'G8 FAIL: anon raised an invoice'; end if;
end $$;
reset role;

select 'ALL G8 STANDING-INVOICE TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- G9 — DOCUMENT LAYOUT (0434)
-- ═════════════════════════════════════════════════════════════════
-- The layout is display, not money, so the claims are narrower — but two of them still
-- matter. A partner must not be able to restyle another partner's documents (their
-- documents are their identity to their customers), and the stored value must be a
-- closed set, because both the screen and the PDF have to understand every key. A typo
-- that stores silently is a setting the partner believes they changed and did not.

-- ── (a) The guard refuses a key neither renderer knows ───────────────────────
do $$ declare ok boolean := false; begin
  begin
    update workshops set doc_layout = '{"make_it_fancy": true}'::jsonb
     where id = '62100000-0000-0000-0000-000000000001';
  exception when others then ok := true; end;
  if not ok then
    raise exception 'G9 FAIL: an unknown layout setting was stored — the partner would think it applied';
  end if;
end $$;

-- … and a bad value for a known key ──────────────────────────────────────────
do $$ declare ok boolean := false; begin
  begin
    update workshops set doc_layout = '{"density": "enormous"}'::jsonb
     where id = '62100000-0000-0000-0000-000000000001';
  exception when others then ok := true; end;
  if not ok then raise exception 'G9 FAIL: an invalid density was stored'; end if;
end $$;

-- ── (b) A real setting is stored, and merged rather than replaced ────────────
set role authenticated;
do $$ declare v jsonb; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');        -- Workshop Z
  perform public.update_document_layout('{"invoice_title": "Tax Invoice", "density": "compact"}'::jsonb);
  perform public.update_document_layout('{"show_banking": false}'::jsonb);

  select doc_layout into v from workshops where id = '62100000-0000-0000-0000-000000000001';
  if v->>'invoice_title' <> 'Tax Invoice' then
    raise exception 'G9 FAIL: the second save wiped the first (invoice_title is %)', v->>'invoice_title';
  end if;
  if v->>'density' <> 'compact' then raise exception 'G9 FAIL: density did not stick'; end if;
  if (v->>'show_banking')::boolean then raise exception 'G9 FAIL: show_banking did not stick'; end if;
end $$;

-- ── (c) A partner cannot restyle somebody else's documents ───────────────────
-- The RPC takes the workshop from the SESSION, so there is no id to tamper with. This
-- proves the other half: Workshop W calling it changes W's own row and not Z's.
do $$ declare v_z jsonb; v_w jsonb; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');        -- Workshop W
  perform public.update_document_layout('{"invoice_title": "W was here"}'::jsonb);

  select doc_layout into v_z from workshops where id = '62100000-0000-0000-0000-000000000001';
  if v_z->>'invoice_title' = 'W was here' then
    raise exception 'G9 FAIL [CROSS-PARTNER]: another workshop restyled Z''s documents';
  end if;

  select doc_layout into v_w from workshops where id = app.user_workshop_id();
  if v_w->>'invoice_title' <> 'W was here' then
    raise exception 'G9 FAIL: a partner could not change its OWN layout';
  end if;
end $$;

-- ── (d) A farm user has no layout to change ──────────────────────────────────
do $$ declare ok boolean := false; begin
  perform _t_login('62300000-0000-0000-0000-000000000001');        -- Farm S owner
  begin
    perform public.update_document_layout('{"invoice_title": "Farm was here"}'::jsonb);
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G9 FAIL: a farm user changed a document layout'; end if;
end $$;
reset role;

set role anon;
do $$ declare ok boolean := false; begin
  begin perform public.update_document_layout('{}'::jsonb);
  exception when others then ok := true; end;
  if not ok then raise exception 'G9 FAIL: anon changed a document layout'; end if;
end $$;
reset role;

select 'ALL G9 DOCUMENT-LAYOUT TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════
-- G10 — ONLINE PAYMENT (0435)
-- ═════════════════════════════════════════════════════════════════
-- A payment provider calls back to say money arrived, and EVERY provider worth using
-- retries that callback until it gets a clean response. So the load-bearing property is
-- not that a payment can be recorded — it is that the same one cannot be recorded twice.
--
-- The defence is a unique index rather than a "have I seen this?" check in the route,
-- because application logic loses the race: two retries arriving together both look,
-- both see nothing, and both insert. A unique index is decided by the database.

-- ── (a) The same provider reference cannot land twice ────────────────────────
insert into partner_payments (farm_id, document_id, amount_cents, paid_on, method, provider, provider_ref)
values ('62000000-0000-0000-0000-000000000001', '68000000-0000-0000-0000-000000000002',
        100000, current_date, 'card', 'payfast', 'pf-abc-123');

do $$ declare ok boolean := false; begin
  begin
    insert into partner_payments (farm_id, document_id, amount_cents, paid_on, method, provider, provider_ref)
    values ('62000000-0000-0000-0000-000000000001', '68000000-0000-0000-0000-000000000002',
            100000, current_date, 'card', 'payfast', 'pf-abc-123');
  exception when unique_violation then ok := true; end;
  if not ok then
    raise exception 'G10 FAIL [DOUBLE CREDIT]: a retried payment notification credited the invoice twice';
  end if;
end $$;

-- … and the invoice was credited exactly once.
do $$ declare c bigint; begin
  select count(*) into c from partner_payments
   where provider = 'payfast' and provider_ref = 'pf-abc-123' and deleted_at is null;
  if c <> 1 then raise exception 'G10 FAIL: % payments exist for one provider reference', c; end if;
end $$;

-- ── (b) Hand-recorded payments are unaffected ────────────────────────────────
-- The index is partial for exactly this reason: two cash payments of the same amount on
-- the same day are ordinary, and must both be allowed.
insert into partner_payments (farm_id, document_id, amount_cents, paid_on, method)
values ('62000000-0000-0000-0000-000000000001', '68000000-0000-0000-0000-000000000002', 5000, current_date, 'cash');
insert into partner_payments (farm_id, document_id, amount_cents, paid_on, method)
values ('62000000-0000-0000-0000-000000000001', '68000000-0000-0000-0000-000000000002', 5000, current_date, 'cash');
do $$ declare c bigint; begin
  select count(*) into c from partner_payments
   where document_id = '68000000-0000-0000-0000-000000000002' and method = 'cash' and deleted_at is null;
  if c <> 2 then raise exception 'G10 FAIL: two identical cash payments collapsed to %', c; end if;
end $$;

-- ── (c) A half-recorded payment is refused ───────────────────────────────────
-- A reference with no provider (or the reverse) is how a reconciliation goes wrong six
-- months later, when nobody can say where a payment came from.
do $$ declare ok boolean := false; begin
  begin
    insert into partner_payments (farm_id, document_id, amount_cents, paid_on, provider_ref)
    values ('62000000-0000-0000-0000-000000000001', '68000000-0000-0000-0000-000000000002',
            1000, current_date, 'orphan-ref');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'G10 FAIL: a provider reference was stored with no provider'; end if;
end $$;

-- ── (d) A different reference is a different payment ─────────────────────────
insert into partner_payments (farm_id, document_id, amount_cents, paid_on, method, provider, provider_ref)
values ('62000000-0000-0000-0000-000000000001', '68000000-0000-0000-0000-000000000002',
        2000, current_date, 'card', 'payfast', 'pf-abc-124');
do $$ declare c bigint; begin
  select count(*) into c from partner_payments
   where provider = 'payfast' and document_id = '68000000-0000-0000-0000-000000000002' and deleted_at is null;
  if c <> 2 then raise exception 'G10 FAIL: a genuinely new payment was refused (% on file)', c; end if;
end $$;

-- ── (e) The farm still cannot see another farm's payments ────────────────────
-- Nothing about adding a provider column loosens who may read a payment.
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');        -- Farm B owner
  select count(*) into c from partner_payments where provider = 'payfast';
  if c <> 0 then raise exception 'G10 FAIL [CROSS-TENANT]: another farm read % card payments', c; end if;
end $$;
reset role;

set role anon;
do $$ declare ok boolean := false; begin
  begin perform count(*) from partner_payments; exception when others then ok := true; end;
  if not ok then raise exception 'G10 FAIL: anon read the payments table'; end if;
end $$;
reset role;

select 'ALL G10 ONLINE-PAYMENT TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════════════════
-- G11 — NO DEBUG BACK DOORS
--
-- This section exists because of a real incident, not a hypothetical one. A helper
-- called public._f14_probe(uuid) was created directly on the live database during F14
-- to answer "what does this user see?", and was never removed. It survived a whole
-- session of green tests because it was never in this repo — db:test builds a database
-- FROM the migrations, so an object that exists only in production is invisible to it.
--
-- The shape to watch for is not "a policy is missing". It is a function that rewrites
-- request.jwt.claims, because auth.uid() reads that setting and every policy here
-- decides through auth.uid(). Such a function does not disable RLS; it relocates the
-- caller and lets RLS answer correctly for somebody else. Measured on production before
-- it was dropped: an operator who legitimately read zero partner documents read back
-- another tenant's counts by passing that tenant's user id.
--
-- The test harness legitimately needs this power — that is what _t_login does — so the
-- rule is "nothing OUTSIDE the harness", and harness helpers are the `_t_` prefix.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── (a) No application function may rewrite the caller's identity ────────────
do $$
declare offenders text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ' order by n.nspname, p.proname)
    into offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'app')
    and p.prokind = 'f'                                  -- plain functions; aggregates have no definition to read
    and p.proname not like '\_t\_%'                      -- the isolation harness itself
    and pg_get_functiondef(p.oid) ilike '%request.jwt.claims%'
    and pg_get_functiondef(p.oid) ilike '%set_config%';
  if offenders is not null then
    raise exception 'G11 FAIL [IMPERSONATION PRIMITIVE]: function(s) outside the test harness rewrite request.jwt.claims: %', offenders;
  end if;
end $$;

-- ── (b) The specific helper that caused this, by name ────────────────────────
-- Named explicitly so that anyone re-creating it for "just one quick check" trips a
-- test that tells them the story rather than a generic failure.
do $$ declare c int; begin
  select count(*) into c
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = '_f14_probe';
  if c <> 0 then
    raise exception 'G11 FAIL: public._f14_probe is back. It lets any caller read as any user id — see migration 0440.';
  end if;
end $$;

-- ── (c) Nothing in public/app is executable by anon except by explicit grant ──
-- The probe was reachable by anon purely because a function with no grant defaults to
-- EXECUTE TO PUBLIC. Only the deliberately public entry points should be callable by an
-- unauthenticated caller; everything else must have had that default revoked.
do $$
declare leaked text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ' order by n.nspname, p.proname)
    into leaked
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app'                                -- app.* is helper-only: never anon
    and has_function_privilege('anon', p.oid, 'EXECUTE');
  if leaked is not null then
    raise exception 'G11 FAIL [ANON EXECUTE]: anon can execute app-schema helper(s): %', leaked;
  end if;
end $$;

select 'ALL G11 NO-DEBUG-BACK-DOOR TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════════════════
-- G12 — THE SUPPLIER'S TAX INVOICE ON AN EXPENSE (0430 bucket, app layer G6b)
--
-- `partner_expenses.receipt_path` and the `partner-receipts` bucket were both created by
-- 0430; only the way to put a file there was missing, so the column sat unused. Attaching
-- one adds a WRITE path to an existing row and a new object namespace, and both need the
-- same answer as the row itself: a partner's supplier invoices are the partner's.
--
-- The storage policies themselves cannot be exercised here — the local test Postgres has
-- no `storage` schema, which is why 0430 skips creating them. They were instead measured
-- against the live project: signing a URL for TJ's receipt returned 200 for TJ and 400
-- for another contractor, for the farm the contractor works for, and for anon. What IS
-- testable here is the column those policies protect, and the write that sets it.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── (a) The owning partner can attach one ────────────────────────────────────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');        -- Workshop Z
  update partner_expenses
     set receipt_path = '62100000-0000-0000-0000-000000000001/66000000-0000-0000-0000-000000000001/receipt-1.pdf'
   where id = '66000000-0000-0000-0000-000000000001';
  select count(*) into c from partner_expenses
   where id = '66000000-0000-0000-0000-000000000001' and receipt_path is not null;
  if c <> 1 then raise exception 'G12 FAIL: a partner could not attach a receipt to its own expense'; end if;
end $$;

-- ── (b) Another contractor cannot attach one to it ───────────────────────────
-- Not an error — RLS makes it match zero rows, which is the shape to assert. A silent
-- "success" that changed nothing is exactly how a leak hides, so the check is that the
-- stored path is still the one the owner wrote.
do $$ declare c bigint; begin
  perform _t_login('c3333333-3333-3333-3333-333333333333');        -- Workshop W
  update partner_expenses set receipt_path = 'c3333333-3333-3333-3333-333333333333/planted.pdf'
   where id = '66000000-0000-0000-0000-000000000001';
  perform _t_login('62200000-0000-0000-0000-000000000001');
  select count(*) into c from partner_expenses
   where id = '66000000-0000-0000-0000-000000000001'
     and receipt_path like '62100000%';
  if c <> 1 then
    raise exception 'G12 FAIL [COMPETITOR]: another contractor overwrote the receipt on somebody else''s expense';
  end if;
end $$;

-- ── (c) The farm cannot read the path ────────────────────────────────────────
-- The path contains the workshop id and the expense id. Even without the object, a farm
-- being able to enumerate its contractor's supplier invoices is the margin leak again.
do $$ declare c bigint; begin
  perform _t_login('62300000-0000-0000-0000-000000000001');        -- Farm S owner
  select count(*) into c from partner_expenses where receipt_path is not null;
  if c <> 0 then raise exception 'G12 FAIL [MARGIN LEAK]: a farm read % contractor receipt paths', c; end if;
end $$;
reset role;

-- ── (d) anon reads nothing ───────────────────────────────────────────────────
set role anon;
do $$ declare ok boolean := false; begin
  begin perform count(*) from partner_expenses where receipt_path is not null;
  exception when others then ok := true; end;
  if not ok then raise exception 'G12 FAIL: anon read receipt paths'; end if;
end $$;
reset role;

select 'ALL G12 EXPENSE-RECEIPT TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════════════════
-- G13 — WHAT IS ON THE SHELF (0450–0451)
--
-- Two things to prove. The first is the money rule, because parts are the one place where
-- two paths could each claim the same rand: `job_card_lines` have booked parts cost since
-- 0211, and now a stock issue can too. The rule 0450 encodes, asserted here in BOTH
-- directions — that the cost appears where it should, AND that it does not appear where
-- it should not, which is the half that catches a double-count:
--
--     receipt                  stock up,   no cost
--     issue naming a job card  stock down, no cost   (the job-card line owns the rand)
--     issue with no job card   stock down, a `parts` cost entry against the machine
--     adjustment / return      stock only, no cost
--
-- The second is that a contractor never sees a farm's shelf. `app.has_farm_access`
-- deliberately admits a workshop with an active link — that is how a contractor reaches
-- the vehicles it works on — so farm-side-only had to be said explicitly, and is worth an
-- assertion because the failure mode is silent.
-- ═════════════════════════════════════════════════════════════════════════════

-- Fixtures of its own, so the arithmetic below states its own inputs.
insert into machines (id, farm_id, name, type) values
  ('69000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 'Store Test Tractor', 'tractor');
insert into parts_catalogue (id, farm_id, part_no, description, typical_cost_cents) values
  ('69100000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 'FLT-9001', 'Fuel filter', 25000);
insert into stock_items (id, farm_id, part_catalogue_id, unit, reorder_point, bin) values
  ('69200000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
   '69100000-0000-0000-0000-000000000001', 'each', 3, 'Shed 2');
insert into job_cards (id, farm_id, machine_id, type, status) values
  ('69300000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
   '69000000-0000-0000-0000-000000000001', 'scheduled_service', 'open');

-- ── (a) A receipt raises the shelf and books nothing ─────────────────────────
insert into stock_movements (id, farm_id, stock_item_id, kind, qty, unit_cost_cents, occurred_on)
values ('69400000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001',
        '69200000-0000-0000-0000-000000000001', 'receipt', 10, 25000, current_date - 5);
do $$ declare v numeric; c bigint; begin
  select on_hand into v from stock_items where id = '69200000-0000-0000-0000-000000000001';
  if v <> 10 then raise exception 'G13 FAIL: on_hand is % after receiving 10', v; end if;
  select count(*) into c from cost_entries
   where source_type = 'stock_movement' and source_id = '69400000-0000-0000-0000-000000000001' and deleted_at is null;
  if c <> 0 then
    raise exception 'G13 FAIL [PHANTOM COST]: buying stock booked % cost entries - a filter in its box is not a cost of owning a machine', c;
  end if;
end $$;

-- ── (b) An issue with NO job card books the cost against the machine ─────────
insert into stock_movements (id, farm_id, stock_item_id, kind, qty, unit_cost_cents, machine_id, occurred_on)
values ('69400000-0000-0000-0000-000000000002', '62000000-0000-0000-0000-000000000001',
        '69200000-0000-0000-0000-000000000001', 'issue', 2, 25000,
        '69000000-0000-0000-0000-000000000001', current_date - 4);
do $$ declare v numeric; a bigint; begin
  select on_hand into v from stock_items where id = '69200000-0000-0000-0000-000000000001';
  if v <> 8 then raise exception 'G13 FAIL: on_hand is % after issuing 2 of 10', v; end if;
  select coalesce(sum(amount_cents), 0) into a from cost_entries
   where source_type = 'stock_movement' and source_id = '69400000-0000-0000-0000-000000000002' and deleted_at is null;
  if a <> 50000 then
    raise exception 'G13 FAIL: a loose issue booked % instead of 2 x 25000 - the money would vanish with the stock', a;
  end if;
end $$;

-- ── (c) An issue NAMING a job card books nothing ─────────────────────────────
-- The no-double-count rule. The job card's own line owns that rand.
insert into stock_movements (id, farm_id, stock_item_id, kind, qty, unit_cost_cents, machine_id, job_card_id, occurred_on)
values ('69400000-0000-0000-0000-000000000003', '62000000-0000-0000-0000-000000000001',
        '69200000-0000-0000-0000-000000000001', 'issue', 3, 25000,
        '69000000-0000-0000-0000-000000000001', '69300000-0000-0000-0000-000000000001', current_date - 3);
do $$ declare v numeric; c bigint; begin
  select on_hand into v from stock_items where id = '69200000-0000-0000-0000-000000000001';
  if v <> 5 then raise exception 'G13 FAIL: on_hand is % after issuing 3 more', v; end if;
  select count(*) into c from cost_entries
   where source_type = 'stock_movement' and source_id = '69400000-0000-0000-0000-000000000003' and deleted_at is null;
  if c <> 0 then
    raise exception 'G13 FAIL [DOUBLE COUNT]: an issue against a job card booked its own cost as well as the job-card line';
  end if;
end $$;

-- ── (d) Returns move stock only ──────────────────────────────────────────────
insert into stock_movements (id, farm_id, stock_item_id, kind, qty, unit_cost_cents, machine_id, occurred_on)
values ('69400000-0000-0000-0000-000000000004', '62000000-0000-0000-0000-000000000001',
        '69200000-0000-0000-0000-000000000001', 'return', 1, 25000,
        '69000000-0000-0000-0000-000000000001', current_date - 2);
do $$ declare v numeric; c bigint; begin
  select on_hand into v from stock_items where id = '69200000-0000-0000-0000-000000000001';
  if v <> 6 then raise exception 'G13 FAIL: a return left on_hand at % rather than 6', v; end if;
  select count(*) into c from cost_entries
   where source_type = 'stock_movement' and source_id = '69400000-0000-0000-0000-000000000004' and deleted_at is null;
  if c <> 0 then raise exception 'G13 FAIL: a return booked a cost'; end if;
end $$;

-- ── (e) Removing a movement reverses BOTH the shelf and the money ────────────
-- A correction that fixed the count and left the cost behind would overstate the machine
-- for ever, and nothing downstream would ever notice.
update stock_movements set deleted_at = now() where id = '69400000-0000-0000-0000-000000000002';
do $$ declare v numeric; c bigint; begin
  select on_hand into v from stock_items where id = '69200000-0000-0000-0000-000000000001';
  if v <> 8 then raise exception 'G13 FAIL: undoing the issue of 2 left on_hand at % rather than 8', v; end if;
  select count(*) into c from cost_entries
   where source_type = 'stock_movement' and source_id = '69400000-0000-0000-0000-000000000002' and deleted_at is null;
  if c <> 0 then raise exception 'G13 FAIL: the cost survived the movement being removed'; end if;
end $$;
-- put it back so the totals below are the ones described
update stock_movements set deleted_at = null where id = '69400000-0000-0000-0000-000000000002';

-- ── (f) The farm side can read its own shelf ─────────────────────────────────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('62300000-0000-0000-0000-000000000001');
  select count(*) into c from stock_items;
  if c <> 1 then raise exception 'G13 FAIL: the farm owner sees % of its own 1 stock item', c; end if;
  select count(*) into c from stock_movements;
  if c <> 4 then raise exception 'G13 FAIL: the farm owner sees % of its own 4 movements', c; end if;
end $$;

-- ── (g) A LINKED contractor sees none of it ──────────────────────────────────
-- Workshop Z holds an ACTIVE workshop_link to Farm S, so app.has_farm_access(Farm S) is
-- true for it. What a farm keeps on its shelves is still none of its business.
do $$ declare c bigint; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  select count(*) into c from stock_items;
  if c <> 0 then raise exception 'G13 FAIL [CONTRACTOR]: a linked contractor read % stock items', c; end if;
  select count(*) into c from stock_movements;
  if c <> 0 then raise exception 'G13 FAIL [CONTRACTOR]: a linked contractor read % stock movements', c; end if;
end $$;

-- ── (h) Nor can it write into the farm's store ───────────────────────────────
do $$ declare ok boolean := false; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');
  begin
    insert into stock_items (farm_id, part_catalogue_id)
    values ('62000000-0000-0000-0000-000000000001', '69100000-0000-0000-0000-000000000001');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G13 FAIL: a contractor wrote a stock item into a farm store'; end if;
end $$;

-- ── (i) Another farm sees nothing ────────────────────────────────────────────
do $$ declare c bigint; begin
  perform _t_login('b2222222-2222-2222-2222-222222222222');
  select count(*) into c from stock_items;
  if c <> 0 then raise exception 'G13 FAIL [CROSS-TENANT]: another farm read % stock items', c; end if;
end $$;
reset role;

-- ── (j) anon reads nothing, and cannot run the engine ────────────────────────
set role anon;
do $$ declare ok boolean := false; begin
  begin perform count(*) from stock_items; exception when others then ok := true; end;
  if not ok then raise exception 'G13 FAIL: anon read the store'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform app.enqueue_low_stock_nudges(); exception when others then ok := true; end;
  if not ok then raise exception 'G13 FAIL: anon ran the low-stock engine'; end if;
end $$;
reset role;

-- ── (k) The engine is service-role only ──────────────────────────────────────
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('62300000-0000-0000-0000-000000000001');
  begin perform app.enqueue_low_stock_nudges(); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G13 FAIL: a signed-in farm user ran the low-stock engine directly'; end if;
end $$;
reset role;

-- on_hand is 6, reorder_point 3 — not low yet, so nothing should be queued.
select app.enqueue_low_stock_nudges();
do $$ declare c bigint; begin
  select count(*) into c from notifications
   where template = 'low_stock' and payload->>'stock_item_id' = '69200000-0000-0000-0000-000000000001';
  if c <> 0 then raise exception 'G13 FAIL: a shelf above its reorder point raised % nudges', c; end if;
end $$;

-- Take it below the line and it should speak up exactly once, then hold its tongue.
insert into stock_movements (farm_id, stock_item_id, kind, qty, machine_id, occurred_on)
values ('62000000-0000-0000-0000-000000000001', '69200000-0000-0000-0000-000000000001',
        'issue', 4, '69000000-0000-0000-0000-000000000001', current_date);
select app.enqueue_low_stock_nudges();
select app.enqueue_low_stock_nudges();
do $$ declare c bigint; v numeric; r bigint; begin
  select on_hand into v from stock_items where id = '69200000-0000-0000-0000-000000000001';
  if v <> 2 then raise exception 'G13 FAIL: on_hand is % rather than 2', v; end if;
  select count(*) into c from notifications
   where template = 'low_stock' and payload->>'stock_item_id' = '69200000-0000-0000-0000-000000000001';
  if c = 0 then raise exception 'G13 FAIL: a shelf below its reorder point raised nothing'; end if;
  -- notify_farm fans out to the farm's owners/managers, so the count is per RECIPIENT;
  -- what must not happen is the second run doubling it.
  select count(*) into r from users where farm_id = '62000000-0000-0000-0000-000000000001'
    and role in ('owner','manager') and active and deleted_at is null;
  if c > r then
    raise exception 'G13 FAIL: running the engine twice queued the same nudge again (% rows for % recipients)', c, r;
  end if;
end $$;

-- ── (l) An issue with no cost on it books nothing, rather than booking zero ──
-- A farm that does not track what a part cost still wants the stock to move.
insert into stock_movements (id, farm_id, stock_item_id, kind, qty, machine_id, occurred_on)
values ('69400000-0000-0000-0000-000000000009', '62000000-0000-0000-0000-000000000001',
        '69200000-0000-0000-0000-000000000001', 'issue', 1,
        '69000000-0000-0000-0000-000000000001', current_date);
do $$ declare c bigint; begin
  select count(*) into c from cost_entries
   where source_type = 'stock_movement' and source_id = '69400000-0000-0000-0000-000000000009' and deleted_at is null;
  if c <> 0 then raise exception 'G13 FAIL: an issue with no unit cost booked a zero-rand cost entry'; end if;
end $$;

select 'ALL G13 STOCK TESTS PASSED' as result;

-- ── (m) An operator may LOOK but not TOUCH (0452) ────────────────────────────
-- Reading is open to the whole farm side on purpose: "have we got a filter?" is a fair
-- question for a driver at the shed. Writing decides what a machine costs, so it narrows
-- to the three roles that maintain the catalogue. Found by driving 0450 — the server
-- action guarded correctly and the POLICY did not, which is UI-only enforcement.
set role authenticated;
do $$ declare c bigint; ok boolean := false; begin
  perform _t_login('62400000-0000-0000-0000-000000000001');        -- Operator on Farm S
  select count(*) into c from stock_items;
  if c <> 1 then raise exception 'G13 FAIL: an operator sees % of the farm store rather than 1', c; end if;

  begin
    insert into stock_movements (farm_id, stock_item_id, kind, qty)
    values ('62000000-0000-0000-0000-000000000001', '69200000-0000-0000-0000-000000000001', 'receipt', 99);
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G13 FAIL: an operator wrote a stock movement and moved a machine''s costs'; end if;
end $$;
reset role;

select 'ALL G13b OPERATOR-WRITE TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════════════════
-- G14 — DID THIS MONTH MAKE MONEY, WHO OWES ME, WHO DO I OWE (0460)
--
-- Every figure here is an aggregation over tables that already existed, so the risk is
-- not tenancy — it is arithmetic that looks right and is not. Three judgements in 0460
-- are the ones worth pinning down, because each is a place where a plausible
-- implementation would be wrong:
--
--   * a WRITTEN-OFF invoice is still revenue, and the write-off is a cost. Dropping it
--     from revenue would quietly restate a period already declared to SARS.
--   * NON-CLAIMABLE VAT is a cost. The VAT return excludes it from input VAT correctly,
--     but the money left the bank, and a P&L that ignored it would overstate profit by
--     exactly the amount most likely to be forgotten.
--   * a written-off invoice must NOT still be chased on the debtors list.
--
-- Its own farm and workshop, so the numbers below are the only numbers in play.
-- ═════════════════════════════════════════════════════════════════════════════

insert into farms (id, name) values ('6a000000-0000-0000-0000-000000000001', 'Farm T');
insert into workshops (id, name, kind, vat_registered, default_vat_rate_bps)
values ('6a100000-0000-0000-0000-000000000001', 'Workshop Y', 'mechanic', true, 1500);
insert into workshop_links (workshop_id, farm_id, status)
values ('6a100000-0000-0000-0000-000000000001', '6a000000-0000-0000-0000-000000000001', 'active');
insert into auth.users (id, email) values ('6a200000-0000-0000-0000-000000000001', 'ystaff@test');
insert into users (id, farm_id, workshop_id, role, name, email) values
  ('6a200000-0000-0000-0000-000000000001', null, '6a100000-0000-0000-0000-000000000001', 'workshop', 'Y Staff', 'y@test');

-- A quiet stretch of calendar nothing else in this suite uses.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                               issue_date, vat_rate_bps, bill_to_name)
values
  ('6a300000-0000-0000-0000-000000000001', '6a000000-0000-0000-0000-000000000001',
   '6a100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'YI-0001', current_date - 700, 1500, 'Farm T'),
  ('6a300000-0000-0000-0000-000000000002', '6a000000-0000-0000-0000-000000000001',
   '6a100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'YI-0002', current_date - 699, 1500, 'Farm T');

-- Separate statement: 0418's partner_documents_note_ck requires a credit or debit note to
-- name the document it corrects at insert time, so the invoices must exist first.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                               issue_date, vat_rate_bps, bill_to_name, corrects_document_id)
values
  ('6a300000-0000-0000-0000-000000000003', '6a000000-0000-0000-0000-000000000001',
   '6a100000-0000-0000-0000-000000000001', 'credit_note', 'draft', 'built', 'YC-0001', current_date - 698, 1500, 'Farm T',
   '6a300000-0000-0000-0000-000000000001'),
  ('6a300000-0000-0000-0000-000000000004', '6a000000-0000-0000-0000-000000000001',
   '6a100000-0000-0000-0000-000000000001', 'debit_note', 'draft', 'built', 'YD-0001', current_date - 697, 1500, 'Farm T',
   '6a300000-0000-0000-0000-000000000001');

insert into partner_document_lines (document_id, farm_id, sort_order, kind, description, qty, unit_price_cents)
values
  ('6a300000-0000-0000-0000-000000000001', '6a000000-0000-0000-0000-000000000001', 1, 'labour', 'Big job',    1, 100000),
  ('6a300000-0000-0000-0000-000000000002', '6a000000-0000-0000-0000-000000000001', 1, 'labour', 'Never paid', 1,  50000),
  ('6a300000-0000-0000-0000-000000000003', '6a000000-0000-0000-0000-000000000001', 1, 'labour', 'Overcharged',1,  20000),
  ('6a300000-0000-0000-0000-000000000004', '6a000000-0000-0000-0000-000000000001', 1, 'labour', 'Extra',      1,  10000);

update partner_documents set status = 'sent', sent_at = now()
 where id in ('6a300000-0000-0000-0000-000000000001', '6a300000-0000-0000-0000-000000000003',
              '6a300000-0000-0000-0000-000000000004');
-- YI-0002 was earned, declared, and never collected.
update partner_documents
   set status = 'written_off', sent_at = now(), written_off_at = now(),
       written_off_reason = 'Customer liquidated'
 where id = '6a300000-0000-0000-0000-000000000002';

insert into partner_expenses (id, workshop_id, supplier_name, category, expense_date,
                              amount_cents, vat_rate_bps, vat_cents, vat_claimable)
values
  ('6a400000-0000-0000-0000-000000000001', '6a100000-0000-0000-0000-000000000001',
   'Bearing Co', 'parts', current_date - 699, 30000, 1500, 4500, true),
  -- Entertainment: the VAT is real money spent and may NOT be claimed (VAT Act s17(2)).
  ('6a400000-0000-0000-0000-000000000002', '6a100000-0000-0000-0000-000000000001',
   'Steakhouse', 'other', current_date - 698, 20000, 1500, 3000, false);

-- ── (a) The P&L adds up, and says what it counted ────────────────────────────
--   revenue  100000 + 50000 + 10000 − 20000 = 140000
--   bad debt                                 =  50000  (YI-0002)
--   cost      30000 + 20000 + 3000 blocked   =  53000
--   profit   140000 − 50000 − 53000          =  37000
do $$ declare r record; begin
  select * into r from app.partner_pl('6a100000-0000-0000-0000-000000000001',
                                      current_date - 705, current_date - 690);
  if r.revenue_ex_cents <> 140000 then
    raise exception 'G14 FAIL: revenue is % rather than 140000 (invoices + debit note − credit note)', r.revenue_ex_cents;
  end if;
  if r.bad_debt_ex_cents <> 50000 then
    raise exception 'G14 FAIL: bad debt is % rather than 50000 — a written-off invoice must stay in revenue AND come off as a cost', r.bad_debt_ex_cents;
  end if;
  if r.expenses_ex_cents <> 50000 then
    raise exception 'G14 FAIL: expenses are % rather than 50000', r.expenses_ex_cents;
  end if;
  if r.blocked_vat_cents <> 3000 then
    raise exception 'G14 FAIL: blocked VAT is % rather than 3000 — VAT you cannot reclaim is still money spent', r.blocked_vat_cents;
  end if;
  if r.cost_cents <> 53000 then raise exception 'G14 FAIL: cost is % rather than 53000', r.cost_cents; end if;
  if r.profit_cents <> 37000 then raise exception 'G14 FAIL: profit is % rather than 37000', r.profit_cents; end if;
end $$;

-- ── (b) The breakdown decomposes the total, exactly ──────────────────────────
-- A total nobody can take apart is a total nobody believes.
do $$ declare v_sum bigint; v_cost bigint; begin
  select coalesce(sum(cost_cents), 0) into v_sum
    from app.partner_expense_breakdown('6a100000-0000-0000-0000-000000000001',
                                       current_date - 705, current_date - 690);
  select cost_cents into v_cost
    from app.partner_pl('6a100000-0000-0000-0000-000000000001', current_date - 705, current_date - 690);
  if v_sum <> v_cost then
    raise exception 'G14 FAIL: the category breakdown sums to % but the P&L says cost is %', v_sum, v_cost;
  end if;
end $$;

-- ── (c) Revenue agrees with the VAT return over the same window ──────────────
-- The two screens are read by the same person in the same week. If they disagree, both
-- are useless. The document selection in 0460 is copied from partner_vat_return for
-- exactly this reason, and this is what keeps it copied.
do $$ declare v_pl bigint; v_vat bigint; begin
  select revenue_ex_cents into v_pl
    from app.partner_pl('6a100000-0000-0000-0000-000000000001', current_date - 705, current_date - 690);
  select standard_ex_cents - credits_ex_cents into v_vat
    from app.partner_vat_return('6a100000-0000-0000-0000-000000000001', current_date - 705, current_date - 690);
  if v_pl <> v_vat then
    raise exception 'G14 FAIL: the P&L says revenue % and the VAT return says % over the same window', v_pl, v_vat;
  end if;
end $$;

-- ── (d) Who owes me: aggregated, credit-noted, and not chasing a write-off ───
--   YI-0001 total 115000 less credit note 23000 = 92000 outstanding
--   YI-0002 written off  -> must NOT appear
do $$ declare r record; n bigint; begin
  select count(*) into n from app.partner_debtors('6a100000-0000-0000-0000-000000000001', current_date);
  if n <> 1 then raise exception 'G14 FAIL: debtors returned % customers rather than 1', n; end if;
  select * into r from app.partner_debtors('6a100000-0000-0000-0000-000000000001', current_date);
  if r.total_cents <> 92000 then
    raise exception 'G14 FAIL: owed is % rather than 92000 (115000 invoice less a 23000 credit note)', r.total_cents;
  end if;
  if r.d90_cents <> 92000 then
    raise exception 'G14 FAIL: an invoice ~700 days old landed in the wrong bucket (90+ shows %)', r.d90_cents;
  end if;
end $$;

-- ── (e) Who I owe: what has not been paid, gross ─────────────────────────────
--   30000 + 4500 + 20000 + 3000 = 57500 (what actually leaves the bank)
do $$ declare v bigint; begin
  select coalesce(sum(total_cents), 0) into v
    from app.partner_creditors('6a100000-0000-0000-0000-000000000001', current_date);
  if v <> 57500 then raise exception 'G14 FAIL: creditors total % rather than 57500', v; end if;
end $$;
-- Paying one takes it off the list, without touching the P&L.
update partner_expenses set paid_on = current_date where id = '6a400000-0000-0000-0000-000000000001';
do $$ declare v bigint; p bigint; begin
  select coalesce(sum(total_cents), 0) into v
    from app.partner_creditors('6a100000-0000-0000-0000-000000000001', current_date);
  if v <> 23000 then raise exception 'G14 FAIL: paying a supplier left creditors at % rather than 23000', v; end if;
  select profit_cents into p
    from app.partner_pl('6a100000-0000-0000-0000-000000000001', current_date - 705, current_date - 690);
  if p <> 37000 then
    raise exception 'G14 FAIL: paying a supplier changed profit to % — when it was paid is cash, not cost', p;
  end if;
end $$;

-- ── (f) Cash is not profit ───────────────────────────────────────────────────
-- The expense was paid TODAY, the work was invoiced 700 days ago. A cash view over today
-- must show the money leaving and no revenue; the P&L window above is unmoved.
do $$ declare r record; begin
  select * into r from app.partner_cash('6a100000-0000-0000-0000-000000000001', current_date, current_date);
  if r.out_cents <> 34500 then
    raise exception 'G14 FAIL: cash out today is % rather than 34500', r.out_cents;
  end if;
  if r.in_cents <> 0 then raise exception 'G14 FAIL: cash in today is % rather than 0', r.in_cents; end if;
  if r.net_cents <> -34500 then raise exception 'G14 FAIL: net cash is % rather than -34500', r.net_cents; end if;
end $$;

-- ── (g) Another workshop asking about these books gets nothing ───────────────
-- Every function is SECURITY INVOKER, so passing somebody else's workshop id is answered
-- by RLS on the underlying tables rather than by a check somebody could forget to write.
set role authenticated;
do $$ declare r record; n bigint; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');        -- Workshop Z staff
  select * into r from app.partner_pl('6a100000-0000-0000-0000-000000000001',
                                      current_date - 705, current_date - 690);
  if coalesce(r.revenue_ex_cents, 0) <> 0 or coalesce(r.cost_cents, 0) <> 0 then
    raise exception 'G14 FAIL [COMPETITOR]: another workshop read revenue % and cost %', r.revenue_ex_cents, r.cost_cents;
  end if;
  select count(*) into n from app.partner_debtors('6a100000-0000-0000-0000-000000000001', current_date);
  if n <> 0 then raise exception 'G14 FAIL [COMPETITOR]: another workshop read % of its rival''s debtors', n; end if;
  select count(*) into n from app.partner_creditors('6a100000-0000-0000-0000-000000000001', current_date);
  if n <> 0 then raise exception 'G14 FAIL [COMPETITOR]: another workshop read % of its rival''s suppliers', n; end if;
end $$;

-- ── (h) The farm it works for cannot read its contractor's books either ──────
do $$ declare r record; begin
  perform _t_login('62300000-0000-0000-0000-000000000001');        -- a farm owner
  select * into r from app.partner_pl('6a100000-0000-0000-0000-000000000001',
                                      current_date - 705, current_date - 690);
  if coalesce(r.cost_cents, 0) <> 0 then
    raise exception 'G14 FAIL [MARGIN LEAK]: a farm read its contractor''s costs (%)', r.cost_cents;
  end if;
end $$;
reset role;

-- ── (i) anon runs none of it ─────────────────────────────────────────────────
set role anon;
do $$ declare ok boolean := false; begin
  begin perform app.partner_pl('6a100000-0000-0000-0000-000000000001', current_date - 705, current_date - 690);
  exception when others then ok := true; end;
  if not ok then raise exception 'G14 FAIL: anon ran the P&L'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform public.partner_debtors('6a100000-0000-0000-0000-000000000001', current_date);
  exception when others then ok := true; end;
  if not ok then raise exception 'G14 FAIL: anon ran the debtors report'; end if;
end $$;
reset role;

select 'ALL G14 MONEY-ANSWER TESTS PASSED' as result;

-- ═════════════════════════════════════════════════════════════════════════════
-- G17 — HOW MANY QUOTES TURN INTO WORK (0476)
--
-- The figure is only worth having if its definition survives contact with how partners
-- actually work, and two of the branches below are the ones a plausible implementation
-- gets wrong:
--
--   * `status = 'accepted'` alone is not conversion. The customer phones, says yes, and
--     the partner goes straight to invoicing; the quote sits at 'sent' for ever. So an
--     ISSUED invoice against a quote counts as converted — you do not bill somebody for
--     work they did not agree to.
--   * but a DRAFT invoice does not. A draft has not left the building, and treating it as
--     evidence of a yes would let a partner's own unsent paperwork inflate their rate.
--
-- And expiry cannot be read off the status either: `app.expire_partner_quotes` (0414) is
-- what sets 'expired', it runs on the nightly cron, and per the handover that cron has
-- never fired in production. A quote whose validity passed months ago is not an open
-- offer because a scheduled job has not caught up with it. The classification therefore
-- uses the same four clauses 0414 uses, which is what keeps the two in step.
--
-- Its own farm and workshop so the counts below are the only counts in play.
-- ═════════════════════════════════════════════════════════════════════════════

insert into farms (id, name) values ('6d000000-0000-0000-0000-000000000001', 'Farm Q');
insert into workshops (id, name, kind, vat_registered, default_vat_rate_bps)
values ('6d100000-0000-0000-0000-000000000001', 'Workshop Q', 'mechanic', true, 1500);
insert into workshop_links (workshop_id, farm_id, status)
values ('6d100000-0000-0000-0000-000000000001', '6d000000-0000-0000-0000-000000000001', 'active');

-- Built as DRAFTS first: the 0381 freeze trigger refuses lines on an issued document, so
-- status is set only once the lines exist. Every quote is R1 000 ex-VAT, which makes the
-- rand assertions readable as multiples.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                               issue_date, due_date, vat_rate_bps, bill_to_name)
values
  ('6d200000-0000-0000-0000-000000000001','6d000000-0000-0000-0000-000000000001','6d100000-0000-0000-0000-000000000001','quote','draft','built','QQ-1',current_date-600,current_date+30,1500,'Farm Q'),
  ('6d200000-0000-0000-0000-000000000002','6d000000-0000-0000-0000-000000000001','6d100000-0000-0000-0000-000000000001','quote','draft','built','QQ-2',current_date-600,current_date+30,1500,'Farm Q'),
  ('6d200000-0000-0000-0000-000000000003','6d000000-0000-0000-0000-000000000001','6d100000-0000-0000-0000-000000000001','quote','draft','built','QQ-3',current_date-600,current_date-10,1500,'Farm Q'),
  ('6d200000-0000-0000-0000-000000000004','6d000000-0000-0000-0000-000000000001','6d100000-0000-0000-0000-000000000001','quote','draft','built','QQ-4',current_date-600,current_date+30,1500,'Farm Q'),
  ('6d200000-0000-0000-0000-000000000005','6d000000-0000-0000-0000-000000000001','6d100000-0000-0000-0000-000000000001','quote','draft','built','QQ-5',current_date-600,current_date+30,1500,'Farm Q'),
  ('6d200000-0000-0000-0000-000000000006','6d000000-0000-0000-0000-000000000001','6d100000-0000-0000-0000-000000000001','quote','draft','built','QQ-6',current_date-600,current_date+30,1500,'Farm Q'),
  ('6d200000-0000-0000-0000-000000000007','6d000000-0000-0000-0000-000000000001','6d100000-0000-0000-0000-000000000001','quote','draft','built','QQ-7',current_date-600,current_date+30,1500,'Farm Q');
insert into partner_document_lines (document_id, farm_id, sort_order, kind, description, qty, unit_price_cents)
select id, '6d000000-0000-0000-0000-000000000001', 1, 'labour', 'Quoted work', 1, 100000
  from partner_documents where number like 'QQ-%';

update partner_documents set status='sent',      sent_at=now() where number='QQ-1'; -- open, still valid
update partner_documents set status='accepted',  sent_at=now() where number='QQ-2'; -- converted by status
update partner_documents set status='sent',      sent_at=now() where number='QQ-3'; -- expired by DATE, status untouched
update partner_documents set status='declined',  sent_at=now() where number='QQ-4'; -- a no
update partner_documents set status='sent',      sent_at=now() where number='QQ-5'; -- converted by INVOICE
update partner_documents set status='cancelled', sent_at=now() where number='QQ-6'; -- withdrawn: not a lost sale
-- QQ-7 stays a draft. It was never put in front of anybody, so it is not pipeline at all.

insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                               issue_date, vat_rate_bps, bill_to_name, quote_id)
values
  ('6d300000-0000-0000-0000-000000000001','6d000000-0000-0000-0000-000000000001','6d100000-0000-0000-0000-000000000001','invoice','draft','built','QI-1',current_date-599,1500,'Farm Q','6d200000-0000-0000-0000-000000000005'),
  ('6d300000-0000-0000-0000-000000000002','6d000000-0000-0000-0000-000000000001','6d100000-0000-0000-0000-000000000001','invoice','draft','built','QI-2',current_date-599,1500,'Farm Q','6d200000-0000-0000-0000-000000000001');
insert into partner_document_lines (document_id, farm_id, sort_order, kind, description, qty, unit_price_cents)
select id, '6d000000-0000-0000-0000-000000000001', 1, 'labour', 'Billed work', 1, 50000
  from partner_documents where number like 'QI-%';
-- QI-1 goes out, so QQ-5 is converted. QI-2 stays a DRAFT, so QQ-1 must stay OPEN.
update partner_documents set status='sent', sent_at=now() where number='QI-1';

-- ── (a) Every branch, on inputs stated above ─────────────────────────────────
do $$ declare r record; begin
  select * into r from app.partner_quote_conversion('6d100000-0000-0000-0000-000000000001',
                                                    current_date - 610, current_date - 590);
  if r.sent_count <> 5 then
    raise exception 'G17 FAIL: sent is % rather than 5 (6 issued less 1 withdrawn; the draft is not pipeline)', r.sent_count;
  end if;
  if r.converted_count <> 2 then
    raise exception 'G17 FAIL: converted is % rather than 2 (one by status, one by issued invoice)', r.converted_count;
  end if;
  if r.declined_count <> 1 then raise exception 'G17 FAIL: declined is % rather than 1', r.declined_count; end if;
  if r.expired_count <> 1 then
    raise exception 'G17 FAIL: expired is % rather than 1 — a quote past its date is expired whether or not the nightly job has run', r.expired_count;
  end if;
  if r.open_count <> 1 then
    raise exception 'G17 FAIL: open is % rather than 1 — a DRAFT invoice must not count as acceptance', r.open_count;
  end if;
  if r.withdrawn_count <> 1 then raise exception 'G17 FAIL: withdrawn is % rather than 1', r.withdrawn_count; end if;
end $$;

-- ── (b) The buckets partition the pipeline exactly ───────────────────────────
-- If the parts stop adding back to the whole, some quote has fallen into two buckets or
-- none, and every rate built on them is quietly wrong.
do $$ declare r record; begin
  select * into r from app.partner_quote_conversion('6d100000-0000-0000-0000-000000000001',
                                                    current_date - 610, current_date - 590);
  if r.converted_count + r.declined_count + r.expired_count + r.open_count <> r.sent_count then
    raise exception 'G17 FAIL: the outcomes (%,%,%,%) do not add back to sent (%)',
      r.converted_count, r.declined_count, r.expired_count, r.open_count, r.sent_count;
  end if;
  if r.converted_cents + r.declined_cents + r.expired_cents + r.open_cents <> r.sent_cents then
    raise exception 'G17 FAIL: the outcome values do not add back to the value sent';
  end if;
end $$;

-- ── (c) Both rates, and the reason there are two ─────────────────────────────
-- 2 of 5 sent = 40%. 2 of the 4 that actually got an answer = 50%. Reporting only the
-- first understates a young period; only the second flatters a partner sitting on quotes
-- nobody ever replied to.
do $$ declare r record; begin
  select * into r from app.partner_quote_conversion('6d100000-0000-0000-0000-000000000001',
                                                    current_date - 610, current_date - 590);
  if r.rate_bps <> 4000 then raise exception 'G17 FAIL: rate is % bps rather than 4000', r.rate_bps; end if;
  if r.decided_rate_bps <> 5000 then
    raise exception 'G17 FAIL: decided rate is % bps rather than 5000', r.decided_rate_bps;
  end if;
  if r.sent_cents <> 500000 then raise exception 'G17 FAIL: value sent is % rather than 500000', r.sent_cents; end if;
  if r.converted_cents <> 200000 then raise exception 'G17 FAIL: value converted is % rather than 200000', r.converted_cents; end if;
end $$;

-- ── (d) A rival workshop reads a rival's pipeline as zeros ───────────────────
-- SECURITY INVOKER, so RLS on partner_documents answers rather than a check in the body.
set role authenticated;
do $$ declare r record; begin
  perform _t_login('62200000-0000-0000-0000-000000000001');        -- Workshop Z staff
  select * into r from app.partner_quote_conversion('6d100000-0000-0000-0000-000000000001',
                                                    current_date - 610, current_date - 590);
  if coalesce(r.sent_count, 0) <> 0 or coalesce(r.converted_cents, 0) <> 0 then
    raise exception 'G17 FAIL [COMPETITOR]: another workshop read % quotes worth %', r.sent_count, r.converted_cents;
  end if;
end $$;
reset role;

-- ── (e) anon runs none of it ─────────────────────────────────────────────────
set role anon;
do $$ declare ok boolean := false; begin
  begin perform app.partner_quote_conversion('6d100000-0000-0000-0000-000000000001', current_date, current_date);
  exception when others then ok := true; end;
  if not ok then raise exception 'G17 FAIL: anon ran the conversion report'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform public.partner_quote_conversion('6d100000-0000-0000-0000-000000000001', current_date, current_date);
  exception when others then ok := true; end;
  if not ok then raise exception 'G17 FAIL: anon ran the public conversion wrapper'; end if;
end $$;
reset role;

select 'ALL G17 QUOTE-CONVERSION TESTS PASSED' as result;
-- ═════════════════════════════════════════════════════════════════════════════
-- G16 — WHAT IS ON ORDER (0473–0475)
--
-- Two things to prove, and the first one matters more than everything else here.
--
-- THE MONEY. A purchase order is a commitment, not a cost. Ordering ten bearings is not
-- spending; the order can be cancelled the same afternoon and no money ever moves. So
-- raising an order, pricing it, and receiving every last item of it must change NOTHING
-- in `cost_entries` and nothing in `partner_expenses` — and then the supplier's invoice,
-- captured once, must produce exactly one expense and never a second. That is the
-- codebase's signature invariant applied to a new pair of tables, and it is asserted in
-- both directions, because the direction that catches a double-count is the one that
-- proves the cost is NOT there yet.
--
-- THE ARITHMETIC AND THE LIFECYCLE. Header totals are maintained by trigger from the
-- lines and the status is derived from what has arrived, so neither can be typed. Both
-- are tested by changing a line and reading the header, which is the only way to catch a
-- rollup that was correct on the day it was written and has since been bypassed.
--
-- Tenancy is the ordinary workshop-scoped shape (0430): a rival workshop reads zero, the
-- FARM this workshop works for reads zero — its contractor's buying prices are the margin
-- behind every quote it is given — and anon reads nothing at all.
-- ═════════════════════════════════════════════════════════════════════════════

-- Its own farm, workshops and people, so every number below states its own inputs.
insert into farms (id, name) values ('6c000000-0000-0000-0000-000000000001', 'Farm U');

insert into workshops (id, name, kind, vat_registered, default_vat_rate_bps) values
  ('6c100000-0000-0000-0000-000000000001', 'Workshop P', 'mechanic',      true, 1500),
  ('6c100000-0000-0000-0000-000000000002', 'Workshop Q', 'parts_supplier', true, 1500);

-- P works for Farm U. This link is the whole reason (d) below is worth asserting: it is
-- what makes P visible to the farm at all, and it must still open nothing here.
insert into workshop_links (workshop_id, farm_id, status) values
  ('6c100000-0000-0000-0000-000000000001', '6c000000-0000-0000-0000-000000000001', 'active');

insert into auth.users (id, email) values
  ('6c200000-0000-0000-0000-000000000001', 'pstaff@test'),
  ('6c200000-0000-0000-0000-000000000002', 'qstaff@test'),
  ('6c300000-0000-0000-0000-000000000001', 'ownerU@test');

insert into users (id, farm_id, workshop_id, role, name, email) values
  ('6c200000-0000-0000-0000-000000000001', null, '6c100000-0000-0000-0000-000000000001', 'workshop', 'P Staff', 'p@test'),
  ('6c200000-0000-0000-0000-000000000002', null, '6c100000-0000-0000-0000-000000000002', 'workshop', 'Q Staff', 'q@test'),
  ('6c300000-0000-0000-0000-000000000001', '6c000000-0000-0000-0000-000000000001', null, 'owner', 'Owner U', 'u@test');

-- The ledger as it stands BEFORE a single purchase order exists. Everything the section
-- does to the order book is measured against this, so "no cost anywhere" is a comparison
-- rather than an assumption about what else the suite has seeded.
create temp table _g16_ledger_before as
  select (select count(*) from cost_entries)     as cost_entries,
         (select count(*) from partner_expenses) as expenses;

-- ── (a) The header's totals follow the lines, and cannot be typed ────────────
insert into purchase_orders (id, workshop_id, supplier_name, reference, order_date, expected_date, vat_rate_bps)
values ('6c400000-0000-0000-0000-000000000001', '6c100000-0000-0000-0000-000000000001',
        'Bearing Co', 'PO-1001', current_date - 9, current_date - 2, 1500);

do $$ declare r record; begin
  select * into r from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if r.subtotal_cents <> 0 or r.vat_cents <> 0 or r.total_cents <> 0 then
    raise exception 'G16 FAIL: a brand new order is worth %/%/% rather than nothing', r.subtotal_cents, r.vat_cents, r.total_cents;
  end if;
  if r.status <> 'draft' then raise exception 'G16 FAIL: a new order starts as % rather than draft', r.status; end if;
end $$;

--   10 x 112,00 = 1120,00 ex-VAT; VAT at 15% = 168,00; total 1288,00
insert into purchase_order_lines (id, workshop_id, purchase_order_id, sort_order, description, part_no, qty_ordered, unit_price_cents)
values ('6c500000-0000-0000-0000-000000000001', '6c100000-0000-0000-0000-000000000001',
        '6c400000-0000-0000-0000-000000000001', 1, 'Wheel bearing', 'BR-6205', 10, 11200);
do $$ declare r record; begin
  select * into r from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if r.subtotal_cents <> 112000 or r.vat_cents <> 16800 or r.total_cents <> 128800 then
    raise exception 'G16 FAIL: one line of 10 x 11200 gave %/%/% rather than 112000/16800/128800',
      r.subtotal_cents, r.vat_cents, r.total_cents;
  end if;
end $$;

--   plus 2 x 500,00 = 1000,00 -> 2120,00 ex-VAT, VAT 318,00, total 2438,00
insert into purchase_order_lines (id, workshop_id, purchase_order_id, sort_order, description, qty_ordered, unit_price_cents)
values ('6c500000-0000-0000-0000-000000000002', '6c100000-0000-0000-0000-000000000001',
        '6c400000-0000-0000-0000-000000000001', 2, 'Hydraulic hose', 2, 50000);
do $$ declare v bigint; begin
  select total_cents into v from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if v <> 243800 then raise exception 'G16 FAIL: adding a second line left the total at % rather than 243800', v; end if;
end $$;

-- EDITING a line moves the header. This is the assertion that catches a rollup which was
-- right the day it was written and has since been bypassed by a direct update somewhere.
update purchase_order_lines set qty_ordered = 5 where id = '6c500000-0000-0000-0000-000000000001';
do $$ declare v bigint; begin
  select subtotal_cents into v from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if v <> 156000 then raise exception 'G16 FAIL: halving a line left the subtotal at % rather than 156000', v; end if;
end $$;

-- Soft-deleting a line takes its value off the order, exactly as the select policy takes
-- it off the screen. The two must agree or the order shows a total for lines nobody sees.
update purchase_order_lines set deleted_at = now() where id = '6c500000-0000-0000-0000-000000000002';
do $$ declare r record; begin
  select * into r from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if r.subtotal_cents <> 56000 or r.vat_cents <> 8400 or r.total_cents <> 64400 then
    raise exception 'G16 FAIL: removing a line left %/%/% rather than 56000/8400/64400',
      r.subtotal_cents, r.vat_cents, r.total_cents;
  end if;
end $$;

-- A stale form posting its own idea of the money is overwritten, not accepted.
update purchase_orders set vat_cents = 1, total_cents = 1
 where id = '6c400000-0000-0000-0000-000000000001';
do $$ declare r record; begin
  select * into r from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if r.vat_cents <> 8400 or r.total_cents <> 64400 then
    raise exception 'G16 FAIL [TYPED TOTAL]: a written total stuck at %/% - the header must be derived from the lines',
      r.vat_cents, r.total_cents;
  end if;
end $$;

-- Re-pricing a line, and then the VAT the supplier is expected to add. A supplier who is
-- not registered for VAT charges none, and the order must be able to say so.
update purchase_order_lines set unit_price_cents = 12000 where id = '6c500000-0000-0000-0000-000000000001';
update purchase_orders set vat_rate_bps = 0 where id = '6c400000-0000-0000-0000-000000000001';
do $$ declare r record; begin
  select * into r from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if r.subtotal_cents <> 60000 or r.vat_cents <> 0 or r.total_cents <> 60000 then
    raise exception 'G16 FAIL: a zero-rated supplier gave %/%/% rather than 60000/0/60000',
      r.subtotal_cents, r.vat_cents, r.total_cents;
  end if;
end $$;
update purchase_orders set vat_rate_bps = 1500 where id = '6c400000-0000-0000-0000-000000000001';

-- ── (b) Receiving moves the status, and only where it is the engine's to move ─
-- A draft is not with the supplier yet, so quantities typed against one are a mistake
-- being corrected rather than a delivery arriving.
update purchase_order_lines set qty_received = 2 where id = '6c500000-0000-0000-0000-000000000001';
do $$ declare v purchase_order_status; begin
  select status into v from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if v <> 'draft' then raise exception 'G16 FAIL: receiving against a DRAFT moved it to %', v; end if;
end $$;

update purchase_order_lines set qty_received = 0 where id = '6c500000-0000-0000-0000-000000000001';
update purchase_orders set status = 'sent' where id = '6c400000-0000-0000-0000-000000000001';
do $$ declare v purchase_order_status; begin
  select status into v from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if v <> 'sent' then raise exception 'G16 FAIL: sending an untouched order gave % rather than sent', v; end if;
end $$;

-- 2 of the 5 arrive. Nobody tells the app anything except what came out of the box.
update purchase_order_lines set qty_received = 2 where id = '6c500000-0000-0000-0000-000000000001';
do $$ declare v purchase_order_status; begin
  select status into v from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if v <> 'part_received' then raise exception 'G16 FAIL: 2 of 5 delivered reads as % rather than part_received', v; end if;
end $$;

update purchase_order_lines set qty_received = 5 where id = '6c500000-0000-0000-0000-000000000001';
do $$ declare v purchase_order_status; begin
  select status into v from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if v <> 'received' then raise exception 'G16 FAIL: the last 3 of 5 arriving left it at % rather than received', v; end if;
end $$;

-- Something else is added to the order after it went out. It is no longer complete.
insert into purchase_order_lines (id, workshop_id, purchase_order_id, sort_order, description, qty_ordered, unit_price_cents)
values ('6c500000-0000-0000-0000-000000000003', '6c100000-0000-0000-0000-000000000001',
        '6c400000-0000-0000-0000-000000000001', 3, 'Seal kit', 4, 8000);
do $$ declare v purchase_order_status; begin
  select status into v from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if v <> 'part_received' then raise exception 'G16 FAIL: adding an unreceived line left the order at % rather than part_received', v; end if;
end $$;

-- THE CLAMP. The supplier sent twenty of the bearings and none of the seal kits. Summed
-- naively that is 24 received against 9 ordered and the order looks complete, while the
-- part the bakkie is actually waiting for has never left their shelf.
update purchase_order_lines set qty_received = 20 where id = '6c500000-0000-0000-0000-000000000001';
do $$ declare v purchase_order_status; begin
  select status into v from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if v <> 'part_received' then
    raise exception 'G16 FAIL [OVER-DELIVERY]: a surplus on one line covered a shortfall on another and the order reads %', v;
  end if;
end $$;

update purchase_order_lines set qty_received = 4 where id = '6c500000-0000-0000-0000-000000000003';
do $$ declare v purchase_order_status; begin
  select status into v from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if v <> 'received' then raise exception 'G16 FAIL: the last line arriving left the order at % rather than received', v; end if;
end $$;

-- A human decision is never undone by the engine. A partner who closes a short-shipped
-- order must not find it reopened the next time anybody touches a line.
update purchase_orders set status = 'closed' where id = '6c400000-0000-0000-0000-000000000001';
update purchase_order_lines set qty_received = 0 where id = '6c500000-0000-0000-0000-000000000003';
do $$ declare v purchase_order_status; begin
  select status into v from purchase_orders where id = '6c400000-0000-0000-0000-000000000001';
  if v <> 'closed' then raise exception 'G16 FAIL [DECISION OVERRIDDEN]: a closed order reopened itself as %', v; end if;
end $$;
update purchase_order_lines set qty_received = 4 where id = '6c500000-0000-0000-0000-000000000003';

-- The same for cancelled, on an order of its own so the one above keeps its history.
insert into purchase_orders (id, workshop_id, supplier_name, reference, order_date, vat_rate_bps, status)
values ('6c400000-0000-0000-0000-000000000002', '6c100000-0000-0000-0000-000000000001',
        'Tyre Town', 'PO-1002', current_date - 6, 1500, 'sent');
insert into purchase_order_lines (id, workshop_id, purchase_order_id, sort_order, description, qty_ordered, unit_price_cents)
values ('6c500000-0000-0000-0000-000000000004', '6c100000-0000-0000-0000-000000000001',
        '6c400000-0000-0000-0000-000000000002', 1, 'Tyre 16.9-34', 4, 25000);
update purchase_orders set status = 'cancelled' where id = '6c400000-0000-0000-0000-000000000002';
update purchase_order_lines set qty_received = 4 where id = '6c500000-0000-0000-0000-000000000004';
do $$ declare r record; begin
  select * into r from purchase_orders where id = '6c400000-0000-0000-0000-000000000002';
  if r.status <> 'cancelled' then raise exception 'G16 FAIL: a cancelled order came back to life as %', r.status; end if;
  -- It still knows what it was worth. A cancelled order is a record of what was nearly
  -- committed, not an empty row.
  if r.total_cents <> 115000 then raise exception 'G16 FAIL: the cancelled order is worth % rather than 115000', r.total_cents; end if;
end $$;

-- ── (c) A PURCHASE ORDER BOOKS NOTHING, ANYWHERE ────────────────────────────
-- Two orders raised, priced, edited, delivered, closed and cancelled. If any of that
-- moved money, this is where it shows.
do $$ declare b record; c bigint; e bigint; begin
  select * into b from _g16_ledger_before;
  select count(*) into c from cost_entries;
  select count(*) into e from partner_expenses;
  if c <> b.cost_entries then
    raise exception 'G16 FAIL [PHANTOM COST]: raising and receiving purchase orders added % cost entries - ordering is not spending', c - b.cost_entries;
  end if;
  if e <> b.expenses then
    raise exception 'G16 FAIL [PHANTOM COST]: raising and receiving purchase orders added % expenses - the cost belongs to the supplier invoice, not the order', e - b.expenses;
  end if;
end $$;

-- ── (d) Nobody else reads the order book ────────────────────────────────────
set role authenticated;
do $$ begin
  perform _t_login('6c200000-0000-0000-0000-000000000001');       -- P staff, whose orders these are
  perform _t_assert('purchase_orders', 2, 'Workshop P');
  perform _t_assert('purchase_order_lines', 3, 'Workshop P');     -- the soft-deleted hose is gone
end $$;

do $$ declare c bigint; begin
  perform _t_login('6c200000-0000-0000-0000-000000000002');       -- Workshop Q, a rival
  select count(*) into c from purchase_orders;
  if c <> 0 then raise exception 'G16 FAIL [COMPETITOR]: a rival workshop read % of P''s purchase orders', c; end if;
  select count(*) into c from purchase_order_lines;
  if c <> 0 then raise exception 'G16 FAIL [COMPETITOR]: a rival workshop read % of P''s order lines - that is P''s buying price', c; end if;
end $$;

-- …and cannot write into it either, by insert or by update.
do $$ declare ok boolean := false; c bigint; begin
  perform _t_login('6c200000-0000-0000-0000-000000000002');
  begin
    insert into purchase_orders (workshop_id, supplier_name)
    values ('6c100000-0000-0000-0000-000000000001', 'Planted');
  exception when others then ok := true; end;
  if not ok then raise exception 'G16 FAIL [CROSS-TENANT WRITE]: a rival raised an order on P''s account'; end if;

  update purchase_orders set supplier_name = 'Hijacked' where id = '6c400000-0000-0000-0000-000000000001';
  get diagnostics c = row_count;
  if c <> 0 then raise exception 'G16 FAIL [CROSS-TENANT WRITE]: a rival updated % of P''s orders', c; end if;
end $$;

-- The FARM this workshop works for. An active workshop_link is what lets P reach Farm U's
-- vehicles; it must open nothing in P's own books, because a farm reading its contractor's
-- purchase orders is reading the margin on every quote it has ever been given (F16).
do $$ declare c bigint; begin
  perform _t_login('6c300000-0000-0000-0000-000000000001');       -- Owner U
  select count(*) into c from purchase_orders;
  if c <> 0 then raise exception 'G16 FAIL [MARGIN LEAK]: a farm read % of its contractor''s purchase orders', c; end if;
  select count(*) into c from purchase_order_lines;
  if c <> 0 then raise exception 'G16 FAIL [MARGIN LEAK]: a farm read % of its contractor''s order lines', c; end if;
end $$;
reset role;

set role anon;
do $$ declare ok boolean := false; begin
  begin perform count(*) from purchase_orders; exception when others then ok := true; end;
  if not ok then raise exception 'G16 FAIL: anon read the order book'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform count(*) from purchase_order_lines; exception when others then ok := true; end;
  if not ok then raise exception 'G16 FAIL: anon read the order lines'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform app.purchase_order_derived_status('6c400000-0000-0000-0000-000000000001', 'sent'); exception when others then ok := true; end;
  if not ok then raise exception 'G16 FAIL: anon ran the receiving engine'; end if;
end $$;
reset role;

-- ── (e) The invoice arrives: exactly one expense, and never a second ────────
-- Bearing Co's invoice, captured the ordinary way. The only thing the purchase order does
-- is get remembered on it.
insert into partner_expenses (id, workshop_id, supplier_name, reference, category, expense_date,
                              amount_cents, vat_rate_bps, vat_cents, vat_claimable, purchase_order_id)
values ('6c600000-0000-0000-0000-000000000001', '6c100000-0000-0000-0000-000000000001',
        'Bearing Co', 'INV-55021', 'parts', current_date - 1, 92000, 1500, 13800, true,
        '6c400000-0000-0000-0000-000000000001');

do $$ declare b record; c bigint; e bigint; begin
  select * into b from _g16_ledger_before;
  select count(*) into e from partner_expenses where purchase_order_id = '6c400000-0000-0000-0000-000000000001'
     and deleted_at is null;
  if e <> 1 then raise exception 'G16 FAIL: converting the order produced % expenses rather than exactly 1', e; end if;
  select count(*) into e from partner_expenses;
  if e <> b.expenses + 1 then
    raise exception 'G16 FAIL: converting added % expenses in total rather than 1', e - b.expenses;
  end if;
  -- The expense is the workshop's own purchase. It never enters a FARM's cost ledger,
  -- and converting must not have started doing so by a side door.
  select count(*) into c from cost_entries;
  if c <> b.cost_entries then
    raise exception 'G16 FAIL [DOUBLE COUNT]: converting a purchase order added % rows to the farm cost ledger', c - b.cost_entries;
  end if;
end $$;

-- Converting the same order again. Two people in the office capturing the same invoice,
-- a double-submitted form and a retried request are all this same race, and it is refused
-- by a unique index rather than by a read-then-write in application code.
do $$ declare ok boolean := false; e bigint; begin
  begin
    insert into partner_expenses (workshop_id, supplier_name, reference, category, expense_date,
                                  amount_cents, vat_rate_bps, vat_cents, purchase_order_id)
    values ('6c100000-0000-0000-0000-000000000001', 'Bearing Co', 'INV-55021', 'parts', current_date,
            92000, 1500, 13800, '6c400000-0000-0000-0000-000000000001');
  exception when others then ok := true; end;
  if not ok then raise exception 'G16 FAIL [DOUBLE COUNT]: the same purchase order was converted twice'; end if;
  select count(*) into e from partner_expenses where purchase_order_id = '6c400000-0000-0000-0000-000000000001'
     and deleted_at is null;
  if e <> 1 then raise exception 'G16 FAIL [DOUBLE COUNT]: re-converting left % live expenses on one order', e; end if;
end $$;

-- An expense may only point at an order of its OWN workshop. RLS already stops Q reading
-- P's orders; the composite foreign key makes the cross-workshop write impossible rather
-- than merely unreachable through the screens.
do $$ declare ok boolean := false; begin
  begin
    insert into partner_expenses (workshop_id, supplier_name, category, expense_date,
                                  amount_cents, vat_rate_bps, vat_cents, purchase_order_id)
    values ('6c100000-0000-0000-0000-000000000002', 'Bearing Co', 'parts', current_date,
            92000, 1500, 13800, '6c400000-0000-0000-0000-000000000001');
  exception when others then ok := true; end;
  if not ok then raise exception 'G16 FAIL [CROSS-TENANT]: one workshop''s expense settled another workshop''s purchase order'; end if;
end $$;

-- The escape hatch, stated as a test because it is a deliberate judgement and not an
-- oversight: the uniqueness is partial on `deleted_at`, so an expense captured against the
-- wrong order can be retracted and the order converted again. Blocking that forever would
-- strand the order with no way out but a support ticket.
update partner_expenses set deleted_at = now() where id = '6c600000-0000-0000-0000-000000000001';
insert into partner_expenses (id, workshop_id, supplier_name, reference, category, expense_date,
                              amount_cents, vat_rate_bps, vat_cents, purchase_order_id)
values ('6c600000-0000-0000-0000-000000000002', '6c100000-0000-0000-0000-000000000001',
        'Bearing Co', 'INV-55021', 'parts', current_date - 1, 60000, 1500, 9000,
        '6c400000-0000-0000-0000-000000000001');
do $$ declare e bigint; begin
  select count(*) into e from partner_expenses where purchase_order_id = '6c400000-0000-0000-0000-000000000001'
     and deleted_at is null;
  if e <> 1 then raise exception 'G16 FAIL: after retracting and re-capturing there are % live expenses rather than 1', e; end if;
end $$;

select 'ALL G16 PURCHASE-ORDER TESTS PASSED' as result;
-- ═════════════════════════════════════════════════════════════════════════════
-- G15 — BANK STATEMENT IMPORT & RECONCILIATION (0470–0472)
--
-- A bank statement is the most sensitive document a small business holds: it names every
-- customer who paid, every supplier, every salary and every personal transfer. So the first
-- half of this section is ordinary tenancy — a rival workshop, the FARM the partner works
-- for, and anon all read nothing — and the second half is the two properties this feature
-- is actually built on, both of which are enforced by INDEXES rather than by code, because
-- code loses races:
--
--   * re-importing the same statement adds nothing. A partner re-uploads constantly: a
--     fresh download every Friday overlapping the last, a retry after a bad column mapping,
--     a copy forwarded to a bookkeeper. If that duplicates lines the unmatched list doubles
--     and they are worse off than before they started.
--   * confirming a match twice banks the money once. A phone on a bad signal in a workshop
--     yard is exactly where a button gets pressed again while the first request is in
--     flight, and both requests pass any "have I already done this?" check ever written.
--
-- And one thing the feature deliberately does NOT do: write a total. Confirming money in
-- inserts a `partner_payments` row and stops; the invoice's paid amount and status move
-- through the 0381 rollup that already exists. That is asserted here too, because the whole
-- design rests on it.
-- ═════════════════════════════════════════════════════════════════════════════

insert into farms (id, name) values ('6b000000-0000-0000-0000-000000000001', 'Farm BK');

insert into workshops (id, name, kind, vat_registered, default_vat_rate_bps) values
  ('6b100000-0000-0000-0000-000000000001', 'Workshop BK', 'mechanic', true, 1500),
  -- A rival on the SAME farm. That is the interesting case: an active workshop_link admits
  -- it to the farm, and it must still read nothing of the other partner's banking.
  ('6b100000-0000-0000-0000-000000000002', 'Workshop Rival', 'tyre', true, 1500);

insert into workshop_links (workshop_id, farm_id, status) values
  ('6b100000-0000-0000-0000-000000000001', '6b000000-0000-0000-0000-000000000001', 'active'),
  ('6b100000-0000-0000-0000-000000000002', '6b000000-0000-0000-0000-000000000001', 'active');

insert into auth.users (id, email) values
  ('6b200000-0000-0000-0000-000000000001', 'bkstaff@test'),
  ('6b200000-0000-0000-0000-000000000002', 'rivalstaff@test'),
  ('6b200000-0000-0000-0000-000000000003', 'bkowner@test');
insert into users (id, farm_id, workshop_id, role, name, email) values
  ('6b200000-0000-0000-0000-000000000001', null, '6b100000-0000-0000-0000-000000000001', 'workshop', 'BK Staff', 'bk@test'),
  ('6b200000-0000-0000-0000-000000000002', null, '6b100000-0000-0000-0000-000000000002', 'workshop', 'Rival Staff', 'rival@test'),
  ('6b200000-0000-0000-0000-000000000003', '6b000000-0000-0000-0000-000000000001', null, 'owner', 'BK Owner', 'owner-bk@test');

-- An invoice the customer still owes: 100000 ex-VAT + 15% = 115000 inclusive.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                               issue_date, vat_rate_bps, bill_to_name)
values ('6b300000-0000-0000-0000-000000000001', '6b000000-0000-0000-0000-000000000001',
        '6b100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'BK-0007',
        current_date - 20, 1500, 'Farm BK');
insert into partner_document_lines (document_id, farm_id, sort_order, kind, description, qty, unit_price_cents)
values ('6b300000-0000-0000-0000-000000000001', '6b000000-0000-0000-0000-000000000001',
        1, 'labour', 'Gearbox', 1, 100000);
update partner_documents set status = 'sent', sent_at = now()
 where id = '6b300000-0000-0000-0000-000000000001';

-- An invoice the RIVAL raised on the same farm, so the money-in direction has something to
-- be wrongly matched against if the guard in 0471 were missing.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                               issue_date, vat_rate_bps, bill_to_name)
values ('6b300000-0000-0000-0000-000000000002', '6b000000-0000-0000-0000-000000000001',
        '6b100000-0000-0000-0000-000000000002', 'invoice', 'draft', 'built', 'RV-0001',
        current_date - 20, 1500, 'Farm BK');
insert into partner_document_lines (document_id, farm_id, sort_order, kind, description, qty, unit_price_cents)
values ('6b300000-0000-0000-0000-000000000002', '6b000000-0000-0000-0000-000000000001',
        1, 'labour', 'Tyres', 1, 100000);
update partner_documents set status = 'sent', sent_at = now()
 where id = '6b300000-0000-0000-0000-000000000002';

-- A supplier invoice not yet paid: 200000 + 30000 VAT = 230000 out of the bank.
insert into partner_expenses (id, workshop_id, supplier_name, reference, category, expense_date,
                              amount_cents, vat_rate_bps, vat_cents, vat_claimable)
values ('6b400000-0000-0000-0000-000000000001', '6b100000-0000-0000-0000-000000000001',
        'Bearing Co', 'SI-9912', 'parts', current_date - 10, 200000, 1500, 30000, true);

insert into bank_statement_imports (id, workshop_id, file_name, account_label, rows_in_file, rows_added)
values ('6b600000-0000-0000-0000-000000000001', '6b100000-0000-0000-0000-000000000001',
        'aug.csv', 'Cheque account', 4, 0);

-- ── (a) The fingerprint the dedupe key is built on ───────────────────────────
-- `parseStatement` in src/lib/banking.ts computes the same string in the browser when it
-- numbers occurrences within a file. If the two ever drift, re-imports start duplicating
-- again and nothing in the app would say so — so the exact value is pinned here.
insert into bank_lines (id, workshop_id, import_id, txn_date, description, reference, amount_cents, row_no, occurrence)
values ('6b500000-0000-0000-0000-000000000001', '6b100000-0000-0000-0000-000000000001',
        '6b600000-0000-0000-0000-000000000001', current_date - 2,
        'EFT INBETALING WELTEVREDE', 'INV-0007', 115000, 1, 1);

do $$ declare v text; begin
  select fingerprint into v from bank_lines where id = '6b500000-0000-0000-0000-000000000001';
  if v <> 'eftinbetalingweltevredeinv0007' then
    raise exception 'G15 FAIL: fingerprint is "%" — src/lib/banking.ts computes a different one', v;
  end if;
end $$;

-- ── (b) Re-importing the same statement adds nothing ─────────────────────────
-- The import action inserts with `on conflict do nothing` against the natural-key index and
-- reports back only what was actually written. Run twice here, exactly as a partner
-- re-uploading Friday's overlapping download would.
insert into bank_lines (workshop_id, import_id, txn_date, description, reference, amount_cents, row_no, occurrence)
values
  ('6b100000-0000-0000-0000-000000000001', '6b600000-0000-0000-0000-000000000001',
   current_date - 2, 'EFT INBETALING WELTEVREDE', 'INV-0007', 115000, 1, 1),
  ('6b100000-0000-0000-0000-000000000001', '6b600000-0000-0000-0000-000000000001',
   current_date - 1, 'BEARING CO', 'SI-9912', -230000, 2, 1),
  ('6b100000-0000-0000-0000-000000000001', '6b600000-0000-0000-0000-000000000001',
   current_date - 1, 'KAARTFOOI', null, -5000, 3, 1)
on conflict (workshop_id, txn_date, amount_cents, fingerprint, occurrence) do nothing;

do $$ declare n bigint; begin
  select count(*) into n from bank_lines where workshop_id = '6b100000-0000-0000-0000-000000000001';
  if n <> 3 then raise exception 'G15 FAIL: after the first load there are % lines rather than 3', n; end if;
end $$;

-- The identical file again. Not one row of it is new.
insert into bank_lines (workshop_id, import_id, txn_date, description, reference, amount_cents, row_no, occurrence)
values
  ('6b100000-0000-0000-0000-000000000001', '6b600000-0000-0000-0000-000000000001',
   current_date - 2, 'EFT INBETALING WELTEVREDE', 'INV-0007', 115000, 1, 1),
  ('6b100000-0000-0000-0000-000000000001', '6b600000-0000-0000-0000-000000000001',
   current_date - 1, 'BEARING CO', 'SI-9912', -230000, 2, 1),
  ('6b100000-0000-0000-0000-000000000001', '6b600000-0000-0000-0000-000000000001',
   current_date - 1, 'KAARTFOOI', null, -5000, 3, 1)
on conflict (workshop_id, txn_date, amount_cents, fingerprint, occurrence) do nothing;

do $$ declare n bigint; begin
  select count(*) into n from bank_lines where workshop_id = '6b100000-0000-0000-0000-000000000001';
  if n <> 3 then
    raise exception 'G15 FAIL [DUPLICATE]: re-importing the same statement left % lines rather than 3', n;
  end if;
end $$;

-- Punctuation and case differ between two exports of the same statement, and none of those
-- differences make it a different transaction. The generated fingerprint is what absorbs it.
insert into bank_lines (workshop_id, import_id, txn_date, description, reference, amount_cents, row_no, occurrence)
values ('6b100000-0000-0000-0000-000000000001', '6b600000-0000-0000-0000-000000000001',
        current_date - 2, 'eft  inbetaling, weltevrede', 'inv/0007', 115000, 1, 1)
on conflict (workshop_id, txn_date, amount_cents, fingerprint, occurrence) do nothing;
do $$ declare n bigint; begin
  select count(*) into n from bank_lines where workshop_id = '6b100000-0000-0000-0000-000000000001';
  if n <> 3 then
    raise exception 'G15 FAIL [DUPLICATE]: a re-spaced copy of the same line was stored (% lines)', n;
  end if;
end $$;

-- But two GENUINELY identical charges on one day are two transactions, and collapsing them
-- would understate the month. `occurrence` is what keeps the key from being wrong here.
insert into bank_lines (workshop_id, import_id, txn_date, description, reference, amount_cents, row_no, occurrence)
values ('6b100000-0000-0000-0000-000000000001', '6b600000-0000-0000-0000-000000000001',
        current_date - 1, 'KAARTFOOI', null, -5000, 4, 2)
on conflict (workshop_id, txn_date, amount_cents, fingerprint, occurrence) do nothing;
do $$ declare n bigint; begin
  select count(*) into n from bank_lines where workshop_id = '6b100000-0000-0000-0000-000000000001';
  if n <> 4 then
    raise exception 'G15 FAIL: the second identical card fee was swallowed (% lines)', n;
  end if;
end $$;

-- Without the conflict clause the index raises, which is what proves it is the index doing
-- the work and not the `on conflict` wording above.
do $$ declare ok boolean := false; begin
  begin
    insert into bank_lines (workshop_id, import_id, txn_date, description, reference, amount_cents, row_no, occurrence)
    values ('6b100000-0000-0000-0000-000000000001', '6b600000-0000-0000-0000-000000000001',
            current_date - 2, 'EFT INBETALING WELTEVREDE', 'INV-0007', 115000, 9, 1);
  exception when unique_violation then ok := true; end;
  if not ok then raise exception 'G15 FAIL: bank_lines_natural_uq did not refuse a duplicate line'; end if;
end $$;

-- ── (c) The partner itself can load and read its own statement ───────────────
-- Asserted before the denials, because a policy set that denies everybody is trivially
-- "isolated" and completely useless. The import action inserts through the ordinary RLS
-- client, so this is the path it actually takes.
set role authenticated;
do $$ declare n bigint; begin
  perform _t_login('6b200000-0000-0000-0000-000000000001');            -- BK staff
  select count(*) into n from bank_lines;
  if n <> 4 then raise exception 'G15 FAIL: the partner reads % of its own 4 bank lines', n; end if;
  select count(*) into n from bank_statement_imports;
  if n <> 1 then raise exception 'G15 FAIL: the partner reads % of its own statement imports', n; end if;

  insert into bank_lines (workshop_id, import_id, txn_date, description, amount_cents, row_no, occurrence)
  values ('6b100000-0000-0000-0000-000000000001', '6b600000-0000-0000-0000-000000000001',
          current_date - 1, 'RENTE', -7500, 5, 1);
  select count(*) into n from bank_lines;
  if n <> 5 then raise exception 'G15 FAIL: the partner could not load a line into its own statement'; end if;
end $$;
reset role;

-- ── (d) Another workshop reads none of it ────────────────────────────────────
-- The rival has an ACTIVE link to the same farm, so it reaches the farm's own data. It must
-- still reach nothing of this partner's banking.
set role authenticated;
do $$ declare n bigint; begin
  perform _t_login('6b200000-0000-0000-0000-000000000002');            -- Rival staff
  select count(*) into n from bank_lines;
  if n <> 0 then raise exception 'G15 FAIL [COMPETITOR]: a rival workshop read % bank lines', n; end if;
  select count(*) into n from bank_statement_imports;
  if n <> 0 then raise exception 'G15 FAIL [COMPETITOR]: a rival workshop read % statement imports', n; end if;
end $$;

-- ...and cannot write one into the other partner's account either.
do $$ declare ok boolean := false; begin
  begin
    insert into bank_lines (workshop_id, txn_date, description, amount_cents)
    values ('6b100000-0000-0000-0000-000000000001', current_date, 'PLANTED', 999);
  exception when others then ok := true; end;
  if not ok then raise exception 'G15 FAIL [COMPETITOR]: a rival wrote a line into another workshop''s statement'; end if;
end $$;

-- ── (e) The farm the partner works for reads none of it either ───────────────
-- A workshop_link admits a partner to a farm's yard. It does not admit the farm to the
-- partner's bank account, and that direction is the one nobody thinks to check.
do $$ declare n bigint; begin
  perform _t_login('6b200000-0000-0000-0000-000000000003');            -- the farm's owner
  select count(*) into n from bank_lines;
  if n <> 0 then raise exception 'G15 FAIL [MARGIN LEAK]: a farm read its contractor''s bank statement (% lines)', n; end if;
end $$;
reset role;

-- ── (f) anon gets nothing at all ─────────────────────────────────────────────
set role anon;
do $$ declare ok boolean := false; begin
  begin perform count(*) from bank_lines;
  exception when others then ok := true; end;
  if not ok then raise exception 'G15 FAIL: anon selected from bank_lines'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform count(*) from bank_statement_imports;
  exception when others then ok := true; end;
  if not ok then raise exception 'G15 FAIL: anon selected from bank_statement_imports'; end if;
end $$;
-- The resync helper is not an RPC. Nobody may ask the database to restate a line's status
-- directly — the only honest way to change it is to change what settles it.
do $$ declare ok boolean := false; begin
  begin perform app.bank_line_resync('6b500000-0000-0000-0000-000000000001');
  exception when others then ok := true; end;
  if not ok then raise exception 'G15 FAIL: anon ran app.bank_line_resync'; end if;
end $$;
reset role;
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('6b200000-0000-0000-0000-000000000001');
  begin perform app.bank_line_resync('6b500000-0000-0000-0000-000000000001');
  exception when others then ok := true; end;
  if not ok then raise exception 'G15 FAIL: a signed-in user ran app.bank_line_resync directly'; end if;
end $$;
reset role;

-- ── (g) Confirming money in creates exactly ONE payment ──────────────────────
-- Run as the partner's own staff through RLS, because that is the path the confirm action
-- takes. The insert carries the bank line and nothing else — no total is written here.
set role authenticated;
do $$ declare n bigint; begin
  perform _t_login('6b200000-0000-0000-0000-000000000001');            -- BK staff
  insert into partner_payments (document_id, farm_id, amount_cents, paid_on, method, reference, recorded_by, bank_line_id)
  values ('6b300000-0000-0000-0000-000000000001', '6b000000-0000-0000-0000-000000000001',
          115000, current_date - 2, 'eft', 'INV-0007',
          '6b200000-0000-0000-0000-000000000001', '6b500000-0000-0000-0000-000000000001');

  select count(*) into n from partner_payments
   where bank_line_id = '6b500000-0000-0000-0000-000000000001' and deleted_at is null;
  if n <> 1 then raise exception 'G15 FAIL: confirming created % payments rather than 1', n; end if;
end $$;

-- The second press. It loses to `partner_payments_bank_line_uq` — which is the point: an
-- application-level check would let both through, because both read the same empty answer.
do $$ declare ok boolean := false; n bigint; begin
  begin
    insert into partner_payments (document_id, farm_id, amount_cents, paid_on, method, recorded_by, bank_line_id)
    values ('6b300000-0000-0000-0000-000000000001', '6b000000-0000-0000-0000-000000000001',
            115000, current_date - 2, 'eft',
            '6b200000-0000-0000-0000-000000000001', '6b500000-0000-0000-0000-000000000001');
  exception when unique_violation then ok := true; end;
  if not ok then raise exception 'G15 FAIL [DOUBLE]: a bank line was banked twice'; end if;

  select count(*) into n from partner_payments
   where bank_line_id = '6b500000-0000-0000-0000-000000000001' and deleted_at is null;
  if n <> 1 then raise exception 'G15 FAIL [DOUBLE]: % live payments after re-confirming', n; end if;
end $$;
reset role;

-- ── (h) The invoice's paid state followed the EXISTING trigger ───────────────
-- Nothing in this feature writes `amount_paid_cents` or `status`. They moved because 0381's
-- rollup saw a payment row, exactly as it does for a payment captured by hand.
do $$ declare r record; begin
  select status, amount_paid_cents, total_cents, paid_at into r
    from partner_documents where id = '6b300000-0000-0000-0000-000000000001';
  if r.amount_paid_cents <> 115000 then
    raise exception 'G15 FAIL: the invoice shows % paid rather than 115000 — the 0381 rollup did not run', r.amount_paid_cents;
  end if;
  if r.status <> 'paid' then
    raise exception 'G15 FAIL: the invoice is % rather than paid', r.status;
  end if;
  if r.paid_at is null then raise exception 'G15 FAIL: the invoice has no paid_at'; end if;
end $$;

-- ── (i) ...and the bank line's own state followed the ledger ─────────────────
-- `status` is a rollup (0472), not something the confirm action typed. That is what stops a
-- payment reversed on another screen leaving a line claiming to be reconciled.
do $$ declare r record; begin
  select status, matched_document_id, matched_payment_id, matched_at into r
    from bank_lines where id = '6b500000-0000-0000-0000-000000000001';
  if r.status <> 'matched' then raise exception 'G15 FAIL: the bank line is % rather than matched', r.status; end if;
  if r.matched_document_id <> '6b300000-0000-0000-0000-000000000001' then
    raise exception 'G15 FAIL: the bank line points at the wrong document';
  end if;
  if r.matched_payment_id is null or r.matched_at is null then
    raise exception 'G15 FAIL: the bank line was matched without recording what settled it';
  end if;
end $$;

-- Undoing it soft-deletes the payment and NOTHING else, and both the invoice and the bank
-- line find their own way back.
update partner_payments set deleted_at = now()
 where bank_line_id = '6b500000-0000-0000-0000-000000000001';
do $$ declare r record; l record; begin
  select status, amount_paid_cents into r from partner_documents where id = '6b300000-0000-0000-0000-000000000001';
  if r.amount_paid_cents <> 0 or r.status <> 'sent' then
    raise exception 'G15 FAIL: after an undo the invoice is % with % paid', r.status, r.amount_paid_cents;
  end if;
  select status, matched_payment_id, matched_at into l from bank_lines where id = '6b500000-0000-0000-0000-000000000001';
  if l.status <> 'unmatched' or l.matched_payment_id is not null or l.matched_at is not null then
    raise exception 'G15 FAIL: after an undo the bank line still says %', l.status;
  end if;
end $$;

-- And the line can be confirmed again afterwards, which is the whole reason the unique
-- index is partial on `deleted_at is null`.
set role authenticated;
do $$ declare n bigint; begin
  perform _t_login('6b200000-0000-0000-0000-000000000001');
  insert into partner_payments (document_id, farm_id, amount_cents, paid_on, method, recorded_by, bank_line_id)
  values ('6b300000-0000-0000-0000-000000000001', '6b000000-0000-0000-0000-000000000001',
          115000, current_date - 2, 'eft',
          '6b200000-0000-0000-0000-000000000001', '6b500000-0000-0000-0000-000000000001');
  select count(*) into n from partner_payments
   where bank_line_id = '6b500000-0000-0000-0000-000000000001' and deleted_at is null;
  if n <> 1 then raise exception 'G15 FAIL: re-confirming after an undo left % live payments', n; end if;
end $$;
reset role;

-- ── (j) Money out settles a supplier bill, once ──────────────────────────────
set role authenticated;
do $$ declare v_line uuid; ok boolean := false; begin
  perform _t_login('6b200000-0000-0000-0000-000000000001');
  select id into v_line from bank_lines
   where workshop_id = '6b100000-0000-0000-0000-000000000001' and amount_cents = -230000;

  update partner_expenses
     set paid_on = current_date - 1, bank_line_id = v_line
   where id = '6b400000-0000-0000-0000-000000000001' and paid_on is null;

  if (select paid_on from partner_expenses where id = '6b400000-0000-0000-0000-000000000001') is null then
    raise exception 'G15 FAIL: confirming money out did not mark the supplier invoice paid';
  end if;
  if (select status from bank_lines where id = v_line) <> 'matched' then
    raise exception 'G15 FAIL: a settled money-out line is not marked matched';
  end if;
  if (select matched_expense_id from bank_lines where id = v_line)
     is distinct from '6b400000-0000-0000-0000-000000000001'::uuid then
    raise exception 'G15 FAIL: the money-out line does not point at the bill it paid';
  end if;

  -- The same money cannot be claimed by a second supplier invoice.
  insert into partner_expenses (id, workshop_id, supplier_name, category, expense_date,
                                amount_cents, vat_rate_bps, vat_cents)
  values ('6b400000-0000-0000-0000-000000000002', '6b100000-0000-0000-0000-000000000001',
          'Somebody Else', 'other', current_date - 10, 200000, 1500, 30000);
  begin
    update partner_expenses set paid_on = current_date - 1, bank_line_id = v_line
     where id = '6b400000-0000-0000-0000-000000000002';
  exception when unique_violation then ok := true; end;
  if not ok then raise exception 'G15 FAIL [DOUBLE]: one payment out of the bank paid two bills'; end if;
end $$;
reset role;

-- ── (k) A settlement that does not make sense is refused ─────────────────────
-- RLS already makes the cross-workshop case unreachable through the app. The guard exists
-- because a settlement pointing at another business's bank account would be silent,
-- permanent, and invisible in every total it corrupts.
do $$ declare ok boolean := false; v_line uuid; begin
  select id into v_line from bank_lines
   where workshop_id = '6b100000-0000-0000-0000-000000000001' and amount_cents = 115000;
  begin
    insert into partner_payments (document_id, farm_id, amount_cents, paid_on, bank_line_id)
    values ('6b300000-0000-0000-0000-000000000002', '6b000000-0000-0000-0000-000000000001',
            115000, current_date, v_line);
  exception when others then ok := true; end;
  if not ok then raise exception 'G15 FAIL [CROSS]: one workshop''s bank line settled another''s invoice'; end if;
end $$;

-- Money that LEFT the account is not a customer receipt, whatever a caller claims.
do $$ declare ok boolean := false; v_line uuid; begin
  select id into v_line from bank_lines
   where workshop_id = '6b100000-0000-0000-0000-000000000001' and amount_cents = -5000 and occurrence = 1;
  begin
    insert into partner_payments (document_id, farm_id, amount_cents, paid_on, bank_line_id)
    values ('6b300000-0000-0000-0000-000000000001', '6b000000-0000-0000-0000-000000000001',
            5000, current_date, v_line);
  exception when others then ok := true; end;
  if not ok then raise exception 'G15 FAIL [DIRECTION]: money leaving the bank was booked as a receipt'; end if;
end $$;

-- ...and money that ARRIVED did not pay a supplier.
do $$ declare ok boolean := false; v_line uuid; begin
  select id into v_line from bank_lines
   where workshop_id = '6b100000-0000-0000-0000-000000000001' and amount_cents = 115000;
  begin
    update partner_expenses set paid_on = current_date, bank_line_id = v_line
     where id = '6b400000-0000-0000-0000-000000000002';
  exception when others then ok := true; end;
  if not ok then raise exception 'G15 FAIL [DIRECTION]: money arriving was booked as paying a supplier'; end if;
end $$;

-- ── (l) A removed line stays removed across a re-import ──────────────────────
-- The natural-key index covers deleted rows on purpose. A line somebody removed — a heading
-- the parser read as data, a row from the wrong account — must not come back every Friday,
-- or the button is worthless.
update bank_lines set deleted_at = now()
 where workshop_id = '6b100000-0000-0000-0000-000000000001' and amount_cents = -5000 and occurrence = 2;
insert into bank_lines (workshop_id, import_id, txn_date, description, reference, amount_cents, row_no, occurrence)
values ('6b100000-0000-0000-0000-000000000001', '6b600000-0000-0000-0000-000000000001',
        current_date - 1, 'KAARTFOOI', null, -5000, 4, 2)
on conflict (workshop_id, txn_date, amount_cents, fingerprint, occurrence) do nothing;
do $$ declare n bigint; begin
  select count(*) into n from bank_lines
   where workshop_id = '6b100000-0000-0000-0000-000000000001' and amount_cents = -5000 and deleted_at is null;
  if n <> 1 then
    raise exception 'G15 FAIL: a removed line came back on re-import (% live card-fee lines)', n;
  end if;
end $$;

select 'ALL G15 BANK-RECONCILIATION TESTS PASSED' as result;

-- ============================================================================
-- H1: VOICE ASSISTANT FOUNDATION
-- Proves consent evidence, private per-user records, machine-scoped aliases,
-- redacted audit rows, LLM consent enforcement, and POPIA export/erasure.
-- Fresh fixture IDs keep this section independent of every test above.
-- ============================================================================

select set_config('request.jwt.claims', '', false);

-- Fixtures (superuser; RLS bypassed).
insert into farms (id, name) values
  ('7a000000-0000-0000-0000-000000000001', 'Voice Farm A'),
  ('7a000000-0000-0000-0000-000000000002', 'Voice Farm B');

insert into auth.users (id, email) values
  ('7a100000-0000-0000-0000-000000000001', 'voice-owner-a@test'),
  ('7a100000-0000-0000-0000-000000000002', 'voice-operator-a@test'),
  ('7a100000-0000-0000-0000-000000000003', 'voice-operator-b@test'),
  ('7a100000-0000-0000-0000-000000000004', 'voice-owner-b@test');

insert into users (id, farm_id, workshop_id, role, name) values
  ('7a100000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000001', null, 'owner',    'Voice Owner A'),
  ('7a100000-0000-0000-0000-000000000002', '7a000000-0000-0000-0000-000000000001', null, 'operator', 'Voice Operator A'),
  ('7a100000-0000-0000-0000-000000000004', '7a000000-0000-0000-0000-000000000002', null, 'owner',    'Voice Owner B');

-- Consent-looking values on profile creation are discarded. A person must opt in
-- themselves after their profile exists.
insert into users (
  id, farm_id, workshop_id, role, name, ai_processing_opt_in,
  ai_processing_opted_in_at, ai_processing_consent_version
) values (
  '7a100000-0000-0000-0000-000000000003',
  '7a000000-0000-0000-0000-000000000001', null, 'operator', 'Voice Operator B',
  true, '2000-01-01 00:00:00+00', 'forged-at-insert'
);

insert into machines (id, farm_id, name, type, assigned_operator_id) values
  ('7a200000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000001', 'John Deere 8320', 'tractor', '7a100000-0000-0000-0000-000000000002'),
  ('7a200000-0000-0000-0000-000000000002', '7a000000-0000-0000-0000-000000000001', 'Massey Ferguson', 'tractor', '7a100000-0000-0000-0000-000000000003'),
  ('7a200000-0000-0000-0000-000000000003', '7a000000-0000-0000-0000-000000000002', 'Other Farm Tractor', 'tractor', null);

-- Structural contract: all three tables are FORCE-RLS, and private records are
-- read-only to browser clients even though aliases remain tenant-managed.
do $$ declare n integer; begin
  select count(*) into n
    from pg_class c
    join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public'
     and c.relname in ('asset_aliases', 'voice_captures', 'ai_interactions')
     and c.relrowsecurity and c.relforcerowsecurity;
  if n <> 3 then raise exception 'H1 RLS FAIL: only % of 3 voice tables have FORCE RLS', n; end if;

  if not has_table_privilege('authenticated', 'public.asset_aliases', 'select')
     or not has_table_privilege('authenticated', 'public.asset_aliases', 'insert')
     or not has_table_privilege('authenticated', 'public.asset_aliases', 'update')
     or not has_table_privilege('authenticated', 'public.asset_aliases', 'delete') then
    raise exception 'H1 GRANT FAIL: authenticated cannot manage asset aliases';
  end if;
  if not has_table_privilege('authenticated', 'public.voice_captures', 'select')
     or not has_table_privilege('authenticated', 'public.ai_interactions', 'select') then
    raise exception 'H1 GRANT FAIL: authenticated cannot read their private voice records';
  end if;
  if has_table_privilege('authenticated', 'public.voice_captures', 'insert')
     or has_table_privilege('authenticated', 'public.ai_interactions', 'insert') then
    raise exception 'H1 GRANT FAIL: browser clients can write trusted voice/AI records';
  end if;
  if has_table_privilege('anon', 'public.asset_aliases', 'select')
     or has_table_privilege('anon', 'public.voice_captures', 'select')
     or has_table_privilege('anon', 'public.ai_interactions', 'select') then
    raise exception 'H1 GRANT FAIL: anon can read voice foundation tables';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_interactions'
       and column_name = 'updated_at' and is_nullable = 'NO'
  ) then raise exception 'H1 SCHEMA FAIL: ai_interactions.updated_at is missing/not required'; end if;
end $$;

do $$ declare r record; begin
  select ai_processing_opt_in, ai_processing_opted_in_at,
         ai_processing_consent_version, ai_processing_withdrawn_at
    into r from users where id = '7a100000-0000-0000-0000-000000000003';
  if r.ai_processing_opt_in
     or r.ai_processing_opted_in_at is not null
     or r.ai_processing_consent_version is not null
     or r.ai_processing_withdrawn_at is not null then
    raise exception 'H1 CONSENT FAIL: profile INSERT manufactured consent evidence';
  end if;
end $$;

-- The subject opts in. Forged evidence supplied in the same PATCH is replaced by
-- the database's current timestamp and known consent text version.
set role authenticated;
do $$ declare r record; begin
  perform _t_login('7a100000-0000-0000-0000-000000000002');
  update users
     set ai_processing_opt_in = true,
         ai_processing_opted_in_at = '2000-01-01 00:00:00+00',
         ai_processing_consent_version = 'forged-at-update',
         ai_processing_withdrawn_at = '2001-01-01 00:00:00+00'
   where id = '7a100000-0000-0000-0000-000000000002';

  select ai_processing_opt_in, ai_processing_opted_in_at,
         ai_processing_consent_version, ai_processing_withdrawn_at
    into r from users where id = '7a100000-0000-0000-0000-000000000002';
  if not r.ai_processing_opt_in
     or r.ai_processing_opted_in_at = '2000-01-01 00:00:00+00'::timestamptz
     or r.ai_processing_consent_version <> 'voice-ai-v1'
     or r.ai_processing_withdrawn_at is not null then
    raise exception 'H1 CONSENT FAIL: self opt-in evidence was not DB-stamped';
  end if;
end $$;

-- Even a same-farm owner cannot consent on somebody else's behalf.
do $$ declare blocked boolean := false; begin
  perform _t_login('7a100000-0000-0000-0000-000000000001');
  begin
    update users set ai_processing_opt_in = true
     where id = '7a100000-0000-0000-0000-000000000003';
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'H1 CONSENT FAIL: owner opted in another person'; end if;
end $$;

-- The farm owner curates aliases; normalization closes spacing/case duplicates and
-- the composite FK rejects a machine from a different farm.
do $$ declare blocked boolean := false; begin
  perform _t_login('7a100000-0000-0000-0000-000000000001');
  insert into asset_aliases (id, farm_id, machine_id, alias) values
    ('7a300000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000001', '7a200000-0000-0000-0000-000000000001', 'John Deere'),
    ('7a300000-0000-0000-0000-000000000002', '7a000000-0000-0000-0000-000000000001', '7a200000-0000-0000-0000-000000000002', 'Massey Ferguson');
  begin
    insert into asset_aliases (farm_id, machine_id, alias) values
      ('7a000000-0000-0000-0000-000000000001', '7a200000-0000-0000-0000-000000000001', '  JOHN   DEERE  ');
  exception when unique_violation then blocked := true;
  end;
  if not blocked then raise exception 'H1 ALIAS FAIL: normalized duplicate was accepted'; end if;

  blocked := false;
  begin
    insert into asset_aliases (farm_id, machine_id, alias) values
      ('7a000000-0000-0000-0000-000000000001', '7a200000-0000-0000-0000-000000000003', 'Wrong farm');
  exception when foreign_key_violation then blocked := true;
  end;
  if not blocked then raise exception 'H1 ALIAS FAIL: cross-farm machine alias was accepted'; end if;
end $$;

-- Operators see aliases only for their assigned machines; another farm sees none.
do $$ declare n bigint; begin
  perform _t_login('7a100000-0000-0000-0000-000000000002');
  select count(*) into n from asset_aliases
   where farm_id = '7a000000-0000-0000-0000-000000000001';
  if n <> 1 then raise exception 'H1 ALIAS RLS FAIL: operator sees % aliases rather than 1', n; end if;
end $$;
do $$ declare n bigint; begin
  perform _t_login('7a100000-0000-0000-0000-000000000004');
  select count(*) into n from asset_aliases
   where farm_id = '7a000000-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'H1 ALIAS RLS FAIL: other farm sees % aliases', n; end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

do $$ declare v text; score real; begin
  select normalized_alias, similarity(normalized_alias, 'djon deer')
    into v, score from asset_aliases
   where farm_id = '7a000000-0000-0000-0000-000000000001'
   order by similarity(normalized_alias, 'djon deer') desc limit 1;
  if v <> 'john deere' or score <= 0.20 then
    raise exception 'H1 ALIAS FAIL: fuzzy Djon Deer match returned % (score %)', v, score;
  end if;
end $$;

-- Trusted server fixtures. Raw audio is absent; transcript/prompt text is deliberately
-- distinctive so the audit assertions can prove it was never copied into audit_log.
insert into voice_captures (
  id, farm_id, user_id, machine_id, locale, status, transcript,
  normalized_transcript, stt_provider, transcribed_at
) values
  ('7a400000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000001', '7a100000-0000-0000-0000-000000000002', '7a200000-0000-0000-0000-000000000001', 'en-ZA', 'transcribed', 'VOICE-H-SECRET-4323 John Deere', 'voice-h-secret-4323 john deere', 'azure', now()),
  ('7a400000-0000-0000-0000-000000000002', '7a000000-0000-0000-0000-000000000001', '7a100000-0000-0000-0000-000000000003', '7a200000-0000-0000-0000-000000000002', 'af-ZA', 'transcribed', 'Operator B capture', 'operator b capture', 'azure', now());

insert into ai_interactions (
  id, farm_id, user_id, voice_capture_id, channel, locale, route_tier,
  input_text, normalized_input, intent, tool_name, tool_args,
  confirmation_status, result_status, response_text, provider, model,
  consent_version, error_detail
) values (
  '7a500000-0000-0000-0000-000000000001',
  '7a000000-0000-0000-0000-000000000001',
  '7a100000-0000-0000-0000-000000000002',
  '7a400000-0000-0000-0000-000000000001',
  'voice', 'en-ZA', 2, 'AI-H-SECRET-9191 input', 'ai-h-secret-9191 input',
  'log_meter', 'propose_meter_reading', '{"secret":"AI-H-SECRET-9191 args"}',
  'pending', 'proposed', 'AI-H-SECRET-9191 response', 'vercel-ai-gateway',
  'openai/gpt-5-mini', 'forged-consent-version', 'AI-H-SECRET-9191 error'
);

-- Deterministic/local parsing has no model and therefore carries no LLM consent claim.
insert into ai_interactions (
  id, farm_id, user_id, channel, locale, route_tier, input_text,
  confirmation_status, result_status, response_text, consent_version
) values (
  '7a500000-0000-0000-0000-000000000002',
  '7a000000-0000-0000-0000-000000000001',
  '7a100000-0000-0000-0000-000000000002',
  'typed', 'en-ZA', 0, 'deterministic request', 'not_required', 'answered',
  'deterministic answer', 'forged-local-consent'
);

do $$ declare llm_v text; local_v text; begin
  select consent_version into llm_v from ai_interactions
   where id = '7a500000-0000-0000-0000-000000000001';
  select consent_version into local_v from ai_interactions
   where id = '7a500000-0000-0000-0000-000000000002';
  if llm_v <> 'voice-ai-v1' then
    raise exception 'H1 CONSENT FAIL: LLM interaction kept/stamped consent %', llm_v;
  end if;
  if local_v is not null then
    raise exception 'H1 CONSENT FAIL: deterministic interaction retained a consent claim';
  end if;
end $$;

-- A capture can only be attached to an interaction for the same farm and person.
do $$ declare blocked boolean := false; begin
  begin
    insert into ai_interactions (
      id, farm_id, user_id, voice_capture_id, channel, locale, route_tier,
      confirmation_status, result_status
    ) values (
      '7a500000-0000-0000-0000-000000000003',
      '7a000000-0000-0000-0000-000000000001',
      '7a100000-0000-0000-0000-000000000002',
      '7a400000-0000-0000-0000-000000000002',
      'voice', 'en-ZA', 0, 'not_required', 'answered'
    );
  exception when foreign_key_violation then blocked := true;
  end;
  if not blocked then raise exception 'H1 FK FAIL: interaction attached another user''s capture'; end if;
end $$;

-- Both stateful tables own updated_at, so the shared scope trigger can stamp safely.
update ai_interactions
   set updated_at = '2000-01-01 00:00:00+00', latency_ms = 20
 where id = '7a500000-0000-0000-0000-000000000001';
do $$ declare v timestamptz; begin
  select updated_at into v from ai_interactions
   where id = '7a500000-0000-0000-0000-000000000001';
  if v = '2000-01-01 00:00:00+00'::timestamptz then
    raise exception 'H1 TIMESTAMP FAIL: ai_interactions update was not DB-stamped';
  end if;
end $$;

-- Private rows are visible only to their subject, not a colleague or farm owner.
set role authenticated;
do $$ declare vc bigint; ai bigint; blocked boolean := false; begin
  perform _t_login('7a100000-0000-0000-0000-000000000002');
  select count(*) into vc from voice_captures
   where id in ('7a400000-0000-0000-0000-000000000001', '7a400000-0000-0000-0000-000000000002');
  select count(*) into ai from ai_interactions
   where id in ('7a500000-0000-0000-0000-000000000001', '7a500000-0000-0000-0000-000000000002');
  if vc <> 1 or ai <> 2 then
    raise exception 'H1 PRIVATE RLS FAIL: subject sees % captures / % interactions', vc, ai;
  end if;
  begin
    insert into voice_captures (farm_id, user_id, locale, status)
    values ('7a000000-0000-0000-0000-000000000001', '7a100000-0000-0000-0000-000000000002', 'en-ZA', 'captured');
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'H1 GRANT FAIL: browser inserted a trusted capture'; end if;
end $$;
do $$ declare vc bigint; ai bigint; begin
  perform _t_login('7a100000-0000-0000-0000-000000000003');
  select count(*) into vc from voice_captures
   where id in ('7a400000-0000-0000-0000-000000000001', '7a400000-0000-0000-0000-000000000002');
  select count(*) into ai from ai_interactions
   where id in ('7a500000-0000-0000-0000-000000000001', '7a500000-0000-0000-0000-000000000002');
  if vc <> 1 or ai <> 0 then
    raise exception 'H1 PRIVATE RLS FAIL: colleague sees % captures / % interactions', vc, ai;
  end if;
end $$;
do $$ declare vc bigint; ai bigint; begin
  perform _t_login('7a100000-0000-0000-0000-000000000001');
  select count(*) into vc from voice_captures
   where farm_id = '7a000000-0000-0000-0000-000000000001';
  select count(*) into ai from ai_interactions
   where farm_id = '7a000000-0000-0000-0000-000000000001';
  if vc <> 0 or ai <> 0 then
    raise exception 'H1 PRIVATE RLS FAIL: farm owner sees another person''s private records';
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- Redacted audit rows exist, but never retain the transcript/prompt/reply/payload.
do $$ declare n bigint; leaked bigint; keyed bigint; begin
  select count(*) into n from audit_log
   where (entity = 'voice_captures' and entity_id = '7a400000-0000-0000-0000-000000000001')
      or (entity = 'ai_interactions' and entity_id = '7a500000-0000-0000-0000-000000000001');
  if n < 2 then raise exception 'H1 AUDIT FAIL: redacted voice/AI audit rows are missing'; end if;

  select count(*) into leaked from audit_log
   where entity in ('voice_captures', 'ai_interactions')
     and (position('VOICE-H-SECRET' in diff::text) > 0
       or position('AI-H-SECRET' in diff::text) > 0);
  if leaked <> 0 then raise exception 'H1 AUDIT FAIL: % audit rows retain secret content', leaked; end if;

  select count(*) into keyed from audit_log
   where entity in ('voice_captures', 'ai_interactions')
     and (diff::text like '%"transcript":%'
       or diff::text like '%"normalized_transcript":%'
       or diff::text like '%"input_text":%'
       or diff::text like '%"normalized_input":%'
       or diff::text like '%"response_text":%'
       or diff::text like '%"tool_args":%'
       or diff::text like '%"error_detail":%');
  if keyed <> 0 then raise exception 'H1 AUDIT FAIL: % audit rows retain sensitive keys', keyed; end if;
end $$;

-- POPIA export includes the subject's private voice and AI records.
set role authenticated;
do $$ declare j jsonb; begin
  perform _t_login('7a100000-0000-0000-0000-000000000001');
  j := public.export_personal_data('7a100000-0000-0000-0000-000000000002');
  if jsonb_array_length(j -> 'voice_captures') <> 1 then
    raise exception 'H1 EXPORT FAIL: voice capture missing from subject export';
  end if;
  if jsonb_array_length(j -> 'ai_interactions') <> 2 then
    raise exception 'H1 EXPORT FAIL: AI interactions missing from subject export';
  end if;
end $$;
reset role;

-- A primary-farm manager must not export or globally erase a multi-site person. The
-- account-level RPCs aggregate/deactivate the whole subject, so cross-farm requests are
-- deliberately escalated to rr_admin rather than leaking or altering Farm B data.
insert into user_farm_memberships (user_id, farm_id, role, active) values (
  '7a100000-0000-0000-0000-000000000003',
  '7a000000-0000-0000-0000-000000000002',
  'operator', true
);
set role authenticated;
do $$ declare export_blocked boolean := false; erase_blocked boolean := false; begin
  perform _t_login('7a100000-0000-0000-0000-000000000001');
  begin
    perform public.export_personal_data('7a100000-0000-0000-0000-000000000003');
  exception when insufficient_privilege then export_blocked := true; end;
  begin
    perform public.erase_personal_data(
      '7a100000-0000-0000-0000-000000000003', 'must be centrally handled'
    );
  exception when insufficient_privilege then erase_blocked := true; end;
  if not export_blocked or not erase_blocked then
    raise exception 'H1 DSAR ISOLATION FAIL: multi-site export/erasure=%/%',
      export_blocked, erase_blocked;
  end if;
end $$;
reset role;

-- The protection must also survive historical membership cleanup. Audit rows are
-- append-only and the personal-data export includes them, so audit history alone is
-- enough to require central handling.
delete from user_farm_memberships
 where user_id = '7a100000-0000-0000-0000-000000000003'
   and farm_id = '7a000000-0000-0000-0000-000000000002';
insert into audit_log (farm_id, user_id, entity, entity_id, action, diff) values (
  '7a000000-0000-0000-0000-000000000002',
  '7a100000-0000-0000-0000-000000000003',
  'historical_cross_farm_record',
  '7a100000-0000-0000-0000-000000000003',
  'view',
  '{}'::jsonb
);
set role authenticated;
do $$ declare export_blocked boolean := false; erase_blocked boolean := false; begin
  perform _t_login('7a100000-0000-0000-0000-000000000001');
  begin
    perform public.export_personal_data('7a100000-0000-0000-0000-000000000003');
  exception when insufficient_privilege then export_blocked := true; end;
  begin
    perform public.erase_personal_data(
      '7a100000-0000-0000-0000-000000000003', 'audit history requires central handling'
    );
  exception when insufficient_privilege then erase_blocked := true; end;
  if not export_blocked or not erase_blocked then
    raise exception 'H1 AUDIT DSAR ISOLATION FAIL: historical export/erasure=%/%',
      export_blocked, erase_blocked;
  end if;
end $$;
reset role;

-- Withdrawal retains its evidence. Existing interaction bookkeeping may finish, but
-- a new interaction cannot acquire a model after consent has ended.
set role authenticated;
do $$ declare r record; begin
  perform _t_login('7a100000-0000-0000-0000-000000000002');
  update users set ai_processing_opt_in = false
   where id = '7a100000-0000-0000-0000-000000000002';
  select ai_processing_opt_in, ai_processing_opted_in_at,
         ai_processing_consent_version, ai_processing_withdrawn_at
    into r from users where id = '7a100000-0000-0000-0000-000000000002';
  if r.ai_processing_opt_in
     or r.ai_processing_opted_in_at is null
     or r.ai_processing_consent_version <> 'voice-ai-v1'
     or r.ai_processing_withdrawn_at is null
     or r.ai_processing_withdrawn_at < r.ai_processing_opted_in_at then
    raise exception 'H1 CONSENT FAIL: withdrawal did not preserve complete evidence';
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

update ai_interactions
   set result_status = 'answered', response_text = 'bookkeeping after withdrawal',
       completed_at = now()
 where id = '7a500000-0000-0000-0000-000000000001';
do $$ declare v text; blocked boolean := false; begin
  select consent_version into v from ai_interactions
   where id = '7a500000-0000-0000-0000-000000000001';
  if v <> 'voice-ai-v1' then
    raise exception 'H1 CONSENT FAIL: historical consent changed during bookkeeping';
  end if;

  begin
    insert into ai_interactions (
      id, farm_id, user_id, channel, locale, route_tier,
      confirmation_status, result_status, provider, model
    ) values (
      '7a500000-0000-0000-0000-000000000003',
      '7a000000-0000-0000-0000-000000000001',
      '7a100000-0000-0000-0000-000000000002',
      'typed', 'en-ZA', 2, 'not_required', 'answered',
      'vercel-ai-gateway', 'openai/gpt-5-mini'
    );
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'H1 CONSENT FAIL: LLM used after withdrawal'; end if;
end $$;

-- Farm-scoped erasure scrubs sensitive payloads, soft-deletes the records, and leaves
-- only the non-sensitive historical consent/version needed for accountability.
set role authenticated;
do $$ declare j jsonb; begin
  perform _t_login('7a100000-0000-0000-0000-000000000001');
  j := public.erase_personal_data(
    '7a100000-0000-0000-0000-000000000002', 'H1 voice foundation test'
  );
  if (j ->> 'voice_records_scrubbed')::bigint <> 1
     or (j ->> 'ai_records_scrubbed')::bigint <> 2 then
    raise exception 'H1 ERASURE FAIL: RPC reported wrong voice/AI scrub counts';
  end if;
end $$;
reset role;

do $$ declare r record; n bigint; leaked bigint; begin
  select active, deleted_at, ai_processing_opt_in, ai_processing_opted_in_at,
         ai_processing_consent_version, ai_processing_withdrawn_at
    into r from users where id = '7a100000-0000-0000-0000-000000000002';
  if r.active or r.deleted_at is null or r.ai_processing_opt_in
     or r.ai_processing_opted_in_at is null
     or r.ai_processing_consent_version <> 'voice-ai-v1'
     or r.ai_processing_withdrawn_at is null then
    raise exception 'H1 ERASURE FAIL: profile/consent state is inconsistent after erasure';
  end if;

  select count(*) into n from voice_captures
   where user_id = '7a100000-0000-0000-0000-000000000002'
     and deleted_at is not null and status = 'cancelled'
     and transcript is null and normalized_transcript is null
     and audio_storage_path is null and error_detail is null;
  if n <> 1 then raise exception 'H1 ERASURE FAIL: voice capture was not fully scrubbed'; end if;

  select count(*) into n from ai_interactions
   where user_id = '7a100000-0000-0000-0000-000000000002'
     and deleted_at is not null and input_text is null and normalized_input is null
     and response_text is null and tool_args = '{}'::jsonb and error_detail is null;
  if n <> 2 then raise exception 'H1 ERASURE FAIL: AI interactions were not fully scrubbed'; end if;

  select count(*) into leaked from audit_log
   where entity in ('voice_captures', 'ai_interactions')
     and (position('VOICE-H-SECRET' in diff::text) > 0
       or position('AI-H-SECRET' in diff::text) > 0);
  if leaked <> 0 then raise exception 'H1 AUDIT FAIL: erasure audit retained secret content'; end if;
end $$;

select 'ALL H1 VOICE-ASSISTANT FOUNDATION TESTS PASSED' as result;

-- ============================================================================
-- H2: ATOMIC VOICE COMMANDS AND CONFIRMATION
-- Proves selected-farm roles, assigned-machine visibility, non-claiming generic
-- services, strict/atomic proposal application, ownership, entitlement and the
-- per-user contention-safe turn limiter.
-- ============================================================================

select set_config('request.jwt.claims', '', false);

-- Fixtures deliberately give each multi-site person opposite roles by farm.
insert into farms (id, name, plan, settings) values
  ('8a000000-0000-4000-8000-000000000001', 'Voice Command Farm A', 'complete', '{}'::jsonb),
  ('8a000000-0000-4000-8000-000000000002', 'Voice Command Farm B', 'complete', '{"vat_rate_bps":"not-a-number"}'::jsonb),
  ('8a000000-0000-4000-8000-000000000003', 'Voice Command Farm C', 'essential', '{}'::jsonb);

insert into auth.users (id, email) values
  ('8a100000-0000-4000-8000-000000000001', 'h2-operator-a-owner-b@test'),
  ('8a100000-0000-4000-8000-000000000002', 'h2-owner-a-operator-b@test'),
  ('8a100000-0000-4000-8000-000000000003', 'h2-owner-c@test');

insert into users (id, farm_id, workshop_id, role, name) values
  ('8a100000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000001', null, 'operator', 'H2 Operator A Owner B'),
  -- Deliberately stale users.role: the active primary membership below is authoritative.
  ('8a100000-0000-4000-8000-000000000002', '8a000000-0000-4000-8000-000000000001', null, 'operator', 'H2 Owner A Operator B'),
  ('8a100000-0000-4000-8000-000000000003', '8a000000-0000-4000-8000-000000000003', null, 'owner',    'H2 Owner C');

insert into user_farm_memberships (user_id, farm_id, role, active) values
  ('8a100000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000001', 'operator', true),
  ('8a100000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000002', 'owner', true),
  ('8a100000-0000-4000-8000-000000000002', '8a000000-0000-4000-8000-000000000001', 'owner', true),
  ('8a100000-0000-4000-8000-000000000002', '8a000000-0000-4000-8000-000000000002', 'operator', true);

insert into machines (
  id, farm_id, name, type, current_reading, current_reading_date, assigned_operator_id
) values
  ('8a200000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000001', 'H2 A Assigned',   'tractor', 100, current_date - 1, '8a100000-0000-4000-8000-000000000001'),
  ('8a200000-0000-4000-8000-000000000002', '8a000000-0000-4000-8000-000000000001', 'H2 A Unassigned', 'tractor', 100, current_date - 1, null),
  ('8a200000-0000-4000-8000-000000000003', '8a000000-0000-4000-8000-000000000002', 'H2 B Assigned',   'tractor', 200, current_date - 1, '8a100000-0000-4000-8000-000000000002'),
  ('8a200000-0000-4000-8000-000000000004', '8a000000-0000-4000-8000-000000000002', 'H2 B Unassigned', 'tractor', 200, current_date - 1, null),
  ('8a200000-0000-4000-8000-000000000005', '8a000000-0000-4000-8000-000000000003', 'H2 C Machine',    'tractor',  50, current_date - 1, null);

insert into service_plan_lines (
  id, farm_id, machine_id, task, interval_hours, last_done_reading,
  last_done_date, next_due_reading, status
) values (
  '8a300000-0000-4000-8000-000000000001',
  '8a000000-0000-4000-8000-000000000002',
  '8a200000-0000-4000-8000-000000000004',
  'H2 engine oil task', 250, 100, current_date - 30, 200, 'overdue'
);

-- Reusable exact-shape proposal payloads. jsonb de-duplicates keys, so these carry
-- the same eleven-key contract generated by the server's AssistantDraft object.
create or replace function _h2_fault_args(p_machine uuid, p_description text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'intent', 'report_fault', 'machineQuery', p_machine::text,
    'machineId', p_machine::text, 'description', p_description,
    'category', null, 'urgency', 'can_work', 'reading', null,
    'readingDate', null, 'serviceDate', null, 'workPerformed', null,
    'confidence', 0.95
  );
$$;
grant execute on function _h2_fault_args(uuid, text) to public;

create or replace function _h2_reading_args(
  p_machine uuid, p_reading numeric, p_date date
) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'intent', 'log_reading', 'machineQuery', p_machine::text,
    'machineId', p_machine::text, 'description', null,
    'category', null, 'urgency', null, 'reading', p_reading,
    'readingDate', to_char(p_date, 'YYYY-MM-DD'), 'serviceDate', null,
    'workPerformed', null, 'confidence', 0.95
  );
$$;
grant execute on function _h2_reading_args(uuid, numeric, date) to public;

-- Structural security: private metadata stays browser-read-only; only the narrowly
-- parameterised SECURITY DEFINER boundaries may mutate it.
do $$ declare n integer; begin
  if not has_function_privilege(
       'authenticated', 'public.apply_assistant_proposal(uuid,text)', 'EXECUTE'
     )
     or has_function_privilege(
       'anon', 'public.apply_assistant_proposal(uuid,text)', 'EXECUTE'
     )
     or has_function_privilege(
       'service_role', 'public.apply_assistant_proposal(uuid,text)', 'EXECUTE'
     ) then
    raise exception 'H2 GRANT FAIL: proposal application execute grants are unsafe';
  end if;
  if not has_function_privilege(
       'authenticated', 'public.consume_assistant_turn()', 'EXECUTE'
     )
     or has_function_privilege(
       'anon', 'public.consume_assistant_turn()', 'EXECUTE'
     )
     or has_function_privilege(
       'service_role', 'public.consume_assistant_turn()', 'EXECUTE'
     ) then
    raise exception 'H2 GRANT FAIL: turn limiter execute grants are unsafe';
  end if;
  if has_table_privilege(
       'authenticated', 'app.assistant_turn_buckets', 'SELECT'
     ) or has_table_privilege(
       'authenticated', 'app.assistant_turn_buckets', 'UPDATE'
     ) then
    raise exception 'H2 GRANT FAIL: browser can inspect or alter limiter buckets';
  end if;

  select count(*) into n
    from pg_proc p
    join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public'
     and p.proname in ('apply_assistant_proposal', 'consume_assistant_turn')
     and p.prosecdef;
  if n <> 2 then
    raise exception 'H2 STRUCTURE FAIL: privileged boundaries are not SECURITY DEFINER';
  end if;
  select count(*) into n
    from pg_proc p
    join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public'
     and p.proname in ('record_fault','record_meter_reading','record_completed_service')
     and not p.prosecdef;
  if n <> 3 then
    raise exception 'H2 STRUCTURE FAIL: record commands are not SECURITY INVOKER';
  end if;
end $$;

-- No no-JWT/service workflow may grant AI-processing consent to somebody else.
do $$ declare blocked boolean := false; begin
  begin
    update users set ai_processing_opt_in = true
     where id = '8a100000-0000-4000-8000-000000000003';
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'H2 CONSENT FAIL: a no-JWT privileged update manufactured consent';
  end if;
end $$;

-- Primary operator / secondary owner: assigned-only on A, full visibility on B.
set role authenticated;
do $$ declare ra user_role; rb user_role; na bigint; nb bigint; begin
  perform _t_login('8a100000-0000-4000-8000-000000000001');
  ra := app.effective_farm_role(
    auth.uid(), '8a000000-0000-4000-8000-000000000001'
  );
  rb := app.effective_farm_role(
    auth.uid(), '8a000000-0000-4000-8000-000000000002'
  );
  select count(*) into na from machines
   where id in (
     '8a200000-0000-4000-8000-000000000001',
     '8a200000-0000-4000-8000-000000000002'
   );
  select count(*) into nb from machines
   where id in (
     '8a200000-0000-4000-8000-000000000003',
     '8a200000-0000-4000-8000-000000000004'
   );
  if ra <> 'operator' or rb <> 'owner' or na <> 1 or nb <> 2 then
    raise exception 'H2 ROLE FAIL [U1]: roles A/B=%/% and visible A/B=%/%', ra, rb, na, nb;
  end if;
end $$;

-- Primary owner / secondary operator: full visibility on A, assigned-only on B.
do $$ declare ra user_role; rb user_role; na bigint; nb bigint; begin
  perform _t_login('8a100000-0000-4000-8000-000000000002');
  ra := app.effective_farm_role(
    auth.uid(), '8a000000-0000-4000-8000-000000000001'
  );
  rb := app.effective_farm_role(
    auth.uid(), '8a000000-0000-4000-8000-000000000002'
  );
  select count(*) into na from machines
   where id in (
     '8a200000-0000-4000-8000-000000000001',
     '8a200000-0000-4000-8000-000000000002'
   );
  select count(*) into nb from machines
   where id in (
     '8a200000-0000-4000-8000-000000000003',
     '8a200000-0000-4000-8000-000000000004'
   );
  if ra <> 'owner' or rb <> 'operator' or na <> 2 or nb <> 1 then
    raise exception 'H2 ROLE FAIL [U2]: roles A/B=%/% and visible A/B=%/%', ra, rb, na, nb;
  end if;
end $$;

-- Alias mutation also follows the selected farm role.
do $$ declare blocked boolean := false; begin
  perform _t_login('8a100000-0000-4000-8000-000000000001');
  insert into asset_aliases (farm_id, machine_id, alias) values (
    '8a000000-0000-4000-8000-000000000002',
    '8a200000-0000-4000-8000-000000000004', 'H2 owner alias'
  );
  begin
    insert into asset_aliases (farm_id, machine_id, alias) values (
      '8a000000-0000-4000-8000-000000000001',
      '8a200000-0000-4000-8000-000000000001', 'H2 operator alias'
    );
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'H2 ALIAS FAIL: primary operator managed aliases'; end if;
end $$;
do $$ declare blocked boolean := false; begin
  perform _t_login('8a100000-0000-4000-8000-000000000002');
  begin
    insert into asset_aliases (farm_id, machine_id, alias) values (
      '8a000000-0000-4000-8000-000000000002',
      '8a200000-0000-4000-8000-000000000003', 'H2 secondary operator alias'
    );
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'H2 ALIAS FAIL: secondary operator managed aliases'; end if;
end $$;

-- Operators may report only against their assigned machine and cannot use privileged
-- meter/service commands, even if their primary role differs on another farm.
do $$ declare fid uuid; blocked boolean := false; begin
  perform _t_login('8a100000-0000-4000-8000-000000000001');
  fid := public.record_fault(
    '8a000000-0000-4000-8000-000000000001',
    '8a200000-0000-4000-8000-000000000001',
    'H2 assigned operator fault', 'can_work', null
  );
  if fid is null then raise exception 'H2 COMMAND FAIL: assigned fault returned no ID'; end if;
  begin
    perform public.record_fault(
      '8a000000-0000-4000-8000-000000000001',
      '8a200000-0000-4000-8000-000000000002',
      'H2 unassigned operator fault', 'can_work', null
    );
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'H2 COMMAND FAIL: operator faulted unassigned machine'; end if;

  blocked := false;
  begin
    perform public.record_meter_reading(
      '8a000000-0000-4000-8000-000000000001',
      '8a200000-0000-4000-8000-000000000001', 110, current_date, null
    );
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'H2 COMMAND FAIL: operator recorded primary-farm reading'; end if;
end $$;

-- The opposite-role person can record on their owner farm but not the secondary farm
-- where their effective role is operator.
do $$ declare rid uuid; blocked boolean := false; begin
  perform _t_login('8a100000-0000-4000-8000-000000000002');
  rid := public.record_meter_reading(
    '8a000000-0000-4000-8000-000000000001',
    '8a200000-0000-4000-8000-000000000002', 110, current_date, null
  );
  if rid is null then raise exception 'H2 COMMAND FAIL: owner reading returned no ID'; end if;
  begin
    perform public.record_meter_reading(
      '8a000000-0000-4000-8000-000000000002',
      '8a200000-0000-4000-8000-000000000003', 210, current_date, null
    );
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'H2 COMMAND FAIL: secondary operator recorded reading'; end if;
end $$;

-- Future and current/newer decreasing readings fail. An older historical reading is
-- retained as history but cannot regress machines.current_reading/current_reading_date.
do $$ declare blocked_future boolean := false; blocked_low boolean := false;
              historical_id uuid; before_reading numeric; before_date date; begin
  perform _t_login('8a100000-0000-4000-8000-000000000001');
  begin
    perform public.record_meter_reading(
      '8a000000-0000-4000-8000-000000000002',
      '8a200000-0000-4000-8000-000000000003', 220, current_date + 1, null
    );
  exception when invalid_parameter_value then blocked_future := true; end;
  begin
    perform public.record_meter_reading(
      '8a000000-0000-4000-8000-000000000002',
      '8a200000-0000-4000-8000-000000000003', 199, current_date, null
    );
  exception when invalid_parameter_value then blocked_low := true; end;
  select current_reading, current_reading_date into before_reading, before_date
    from machines where id = '8a200000-0000-4000-8000-000000000003';
  historical_id := public.record_meter_reading(
    '8a000000-0000-4000-8000-000000000002',
    '8a200000-0000-4000-8000-000000000003', 180, current_date - 2, null
  );
  if not blocked_future or not blocked_low or historical_id is null
     or (select current_reading from machines where id = '8a200000-0000-4000-8000-000000000003') <> before_reading
     or (select current_reading_date from machines where id = '8a200000-0000-4000-8000-000000000003') <> before_date then
    raise exception 'H2 VALIDATION FAIL: future/low/history=%/%/%',
      blocked_future, blocked_low, historical_id;
  end if;
end $$;

-- A generic completed service creates no job_card_service_lines, so completion cannot
-- silently claim/reset due tasks. Invalid VAT settings fall back to 15%.
do $$ declare jid uuid; n bigint; r record; begin
  perform _t_login('8a100000-0000-4000-8000-000000000001');
  jid := public.record_completed_service(
    '8a000000-0000-4000-8000-000000000002',
    '8a200000-0000-4000-8000-000000000004',
    250, current_date, 'H2 generic completed service'
  );
  select count(*) into n from job_card_service_lines where job_card_id = jid;
  if n <> 0 then raise exception 'H2 SERVICE FAIL: generic service linked % plan lines', n; end if;
  select last_done_reading, last_done_date into r
    from service_plan_lines
   where id = '8a300000-0000-4000-8000-000000000001';
  if r.last_done_reading <> 100 or r.last_done_date <> current_date - 30 then
    raise exception 'H2 SERVICE FAIL: generic service reset a plan line';
  end if;
  if (select vat_rate_bps from job_cards where id = jid) <> 1500 then
    raise exception 'H2 SERVICE FAIL: malformed VAT setting did not fall back to 1500';
  end if;
  if (select status from job_cards where id = jid) <> 'completed' then
    raise exception 'H2 SERVICE FAIL: generic service card is not completed';
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- Private proposal/capture fixtures, written by the trusted server (superuser here).
insert into voice_captures (
  id, farm_id, user_id, machine_id, locale, status, transcript,
  normalized_transcript, stt_provider, transcribed_at
) values
  ('8a400000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000002', '8a100000-0000-4000-8000-000000000001', '8a200000-0000-4000-8000-000000000004', 'en-ZA', 'awaiting_confirmation', 'H2 apply once', 'h2 apply once', 'azure', now()),
  ('8a400000-0000-4000-8000-000000000002', '8a000000-0000-4000-8000-000000000002', '8a100000-0000-4000-8000-000000000001', '8a200000-0000-4000-8000-000000000004', 'en-ZA', 'awaiting_confirmation', 'H2 reject once', 'h2 reject once', 'azure', now());

insert into ai_interactions (
  id, farm_id, user_id, voice_capture_id, channel, locale, route_tier,
  intent, tool_name, tool_args, confirmation_status, result_status,
  proposal_expires_at
) values
  ('8a500000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000002', '8a100000-0000-4000-8000-000000000001', '8a400000-0000-4000-8000-000000000001', 'voice', 'en-ZA', 1, 'report_fault', 'report_fault', _h2_fault_args('8a200000-0000-4000-8000-000000000004', 'H2 apply exactly once'), 'pending', 'proposed', now() + interval '15 minutes'),
  ('8a500000-0000-4000-8000-000000000002', '8a000000-0000-4000-8000-000000000002', '8a100000-0000-4000-8000-000000000001', '8a400000-0000-4000-8000-000000000002', 'voice', 'en-ZA', 1, 'report_fault', 'report_fault', _h2_fault_args('8a200000-0000-4000-8000-000000000004', 'H2 reject exactly once'), 'pending', 'proposed', now() + interval '15 minutes'),
  ('8a500000-0000-4000-8000-000000000003', '8a000000-0000-4000-8000-000000000002', '8a100000-0000-4000-8000-000000000001', null, 'typed', 'en-ZA', 1, 'report_fault', 'report_fault', _h2_fault_args('8a200000-0000-4000-8000-000000000004', 'H2 expired must not save'), 'pending', 'proposed', now() - interval '1 second'),
  ('8a500000-0000-4000-8000-000000000004', '8a000000-0000-4000-8000-000000000002', '8a100000-0000-4000-8000-000000000001', null, 'typed', 'en-ZA', 1, 'log_reading', 'log_reading', jsonb_set(_h2_reading_args('8a200000-0000-4000-8000-000000000004', 333, current_date), '{reading}', '"not-a-number"'::jsonb), 'pending', 'proposed', now() + interval '15 minutes'),
  ('8a500000-0000-4000-8000-000000000005', '8a000000-0000-4000-8000-000000000001', '8a100000-0000-4000-8000-000000000001', null, 'typed', 'en-ZA', 1, 'report_fault', 'report_fault', _h2_fault_args('8a200000-0000-4000-8000-000000000002', 'H2 hidden machine must not save'), 'pending', 'proposed', now() + interval '15 minutes'),
  ('8a500000-0000-4000-8000-000000000006', '8a000000-0000-4000-8000-000000000002', '8a100000-0000-4000-8000-000000000002', null, 'typed', 'en-ZA', 1, 'log_reading', 'log_reading', _h2_reading_args('8a200000-0000-4000-8000-000000000003', 225, current_date), 'pending', 'proposed', now() + interval '15 minutes'),
  ('8a500000-0000-4000-8000-000000000007', '8a000000-0000-4000-8000-000000000003', '8a100000-0000-4000-8000-000000000003', null, 'typed', 'en-ZA', 1, 'report_fault', 'report_fault', _h2_fault_args('8a200000-0000-4000-8000-000000000005', 'H2 no entitlement must not save'), 'pending', 'proposed', now() + interval '15 minutes'),
  ('8a500000-0000-4000-8000-000000000008', '8a000000-0000-4000-8000-000000000002', '8a100000-0000-4000-8000-000000000001', null, 'typed', 'en-ZA', 1, 'report_fault', 'report_fault', _h2_fault_args('8a200000-0000-4000-8000-000000000004', 'H2 private ownership proposal'), 'pending', 'proposed', now() + interval '15 minutes');

set role authenticated;

-- Confirm exactly once. A second confirm returns the identical linked record without
-- inserting another fault; the linked capture is updated in the same transaction.
do $$ declare first_result jsonb; retry_result jsonb; linked uuid; n bigint; begin
  perform _t_login('8a100000-0000-4000-8000-000000000001');
  first_result := public.apply_assistant_proposal(
    '8a500000-0000-4000-8000-000000000001', 'confirm'
  );
  retry_result := public.apply_assistant_proposal(
    '8a500000-0000-4000-8000-000000000001', 'confirm'
  );
  linked := (first_result ->> 'linkedRecordId')::uuid;
  select count(*) into n from faults where description = 'H2 apply exactly once';
  if not (first_result ->> 'ok')::boolean
     or (first_result ->> 'replayed')::boolean
     or not (retry_result ->> 'ok')::boolean
     or not (retry_result ->> 'replayed')::boolean
     or retry_result ->> 'linkedRecordId' <> linked::text
     or n <> 1 then
    raise exception 'H2 APPLY FAIL: first=%, retry=%, writes=%', first_result, retry_result, n;
  end if;
  if (select confirmation_status from ai_interactions where id = '8a500000-0000-4000-8000-000000000001') <> 'confirmed'
     or (select status from voice_captures where id = '8a400000-0000-4000-8000-000000000001') <> 'applied' then
    raise exception 'H2 APPLY FAIL: interaction/capture did not commit atomically';
  end if;
end $$;

-- Reject exactly once. Even a conflicting retry returns the stored rejection and does
-- not turn it into a confirmation.
do $$ declare first_result jsonb; retry_result jsonb; n bigint; begin
  perform _t_login('8a100000-0000-4000-8000-000000000001');
  first_result := public.apply_assistant_proposal(
    '8a500000-0000-4000-8000-000000000002', 'reject'
  );
  retry_result := public.apply_assistant_proposal(
    '8a500000-0000-4000-8000-000000000002', 'confirm'
  );
  select count(*) into n from faults where description = 'H2 reject exactly once';
  if first_result ->> 'action' <> 'reject'
     or retry_result ->> 'action' <> 'reject'
     or not (retry_result ->> 'replayed')::boolean
     or n <> 0 then
    raise exception 'H2 REJECT FAIL: first=%, retry=%, writes=%', first_result, retry_result, n;
  end if;
  if (select status from voice_captures where id = '8a400000-0000-4000-8000-000000000002') <> 'cancelled' then
    raise exception 'H2 REJECT FAIL: linked capture was not cancelled atomically';
  end if;
end $$;

-- Expiry and malformed payloads return structured failures and leave the proposal
-- pending with no operational side effect, so the whole attempted apply rolled back.
do $$ declare expired_result jsonb; malformed_result jsonb; n bigint; begin
  perform _t_login('8a100000-0000-4000-8000-000000000001');
  expired_result := public.apply_assistant_proposal(
    '8a500000-0000-4000-8000-000000000003', 'confirm'
  );
  malformed_result := public.apply_assistant_proposal(
    '8a500000-0000-4000-8000-000000000004', 'confirm'
  );
  if expired_result ->> 'code' <> 'proposal_expired'
     or malformed_result ->> 'code' <> 'invalid_proposal' then
    raise exception 'H2 VALIDATION FAIL: expired=% malformed=%', expired_result, malformed_result;
  end if;
  select count(*) into n from meter_readings
   where machine_id = '8a200000-0000-4000-8000-000000000004' and reading = 333;
  if n <> 0
     or (select confirmation_status from ai_interactions where id = '8a500000-0000-4000-8000-000000000003') <> 'failed'
     or (select error_code from ai_interactions where id = '8a500000-0000-4000-8000-000000000003') <> 'proposal_expired'
     or (select confirmation_status from ai_interactions where id = '8a500000-0000-4000-8000-000000000004') <> 'failed'
     or (select error_code from ai_interactions where id = '8a500000-0000-4000-8000-000000000004') <> 'invalid_proposal' then
    raise exception 'H2 ROLLBACK FAIL: invalid/expired proposal changed state or data';
  end if;
end $$;

-- A selected-farm role downgrade, an unassigned machine and a downgraded plan all
-- fail inside the locked RPC even if an older server route proposed the operation.
do $$ declare hidden_result jsonb; role_result jsonb; begin
  perform _t_login('8a100000-0000-4000-8000-000000000001');
  hidden_result := public.apply_assistant_proposal(
    '8a500000-0000-4000-8000-000000000005', 'confirm'
  );
  perform _t_login('8a100000-0000-4000-8000-000000000002');
  role_result := public.apply_assistant_proposal(
    '8a500000-0000-4000-8000-000000000006', 'confirm'
  );
  if hidden_result ->> 'code' <> 'forbidden'
     or role_result ->> 'code' <> 'forbidden' then
    raise exception 'H2 AUTH FAIL: hidden=% role=%', hidden_result, role_result;
  end if;
end $$;
do $$ declare plan_result jsonb; begin
  perform _t_login('8a100000-0000-4000-8000-000000000003');
  plan_result := public.apply_assistant_proposal(
    '8a500000-0000-4000-8000-000000000007', 'confirm'
  );
  if plan_result ->> 'code' <> 'feature_unavailable' then
    raise exception 'H2 ENTITLEMENT FAIL: %', plan_result;
  end if;
end $$;

-- Same-farm colleagues and an entirely different tenant both receive the same generic
-- denial for a private proposal ID.
do $$ declare same_farm_blocked boolean := false; cross_blocked boolean := false; begin
  perform _t_login('8a100000-0000-4000-8000-000000000002');
  begin
    perform public.apply_assistant_proposal(
      '8a500000-0000-4000-8000-000000000008', 'confirm'
    );
  exception when insufficient_privilege then same_farm_blocked := true; end;
  perform _t_login('8a100000-0000-4000-8000-000000000003');
  begin
    perform public.apply_assistant_proposal(
      '8a500000-0000-4000-8000-000000000008', 'confirm'
    );
  exception when insufficient_privilege then cross_blocked := true; end;
  if not same_farm_blocked or not cross_blocked then
    raise exception 'H2 OWNERSHIP FAIL: same-farm/cross-tenant=%/%',
      same_farm_blocked, cross_blocked;
  end if;
end $$;

-- One atomic minute bucket permits exactly twenty turns. A different user's bucket is
-- independent. Repeated calls in one statement exercise the ON CONFLICT row-lock path.
reset role;
select set_config('request.jwt.claims', '', false);
delete from app.assistant_turn_buckets;
set role authenticated;
do $$ declare i integer; begin
  perform _t_login('8a100000-0000-4000-8000-000000000001');
  for i in 1..20 loop
    if not public.consume_assistant_turn() then
      raise exception 'H2 LIMIT FAIL: user A was denied at turn %', i;
    end if;
  end loop;
  if public.consume_assistant_turn() then
    raise exception 'H2 LIMIT FAIL: user A received a 21st turn';
  end if;
end $$;
do $$ begin
  perform _t_login('8a100000-0000-4000-8000-000000000002');
  if not public.consume_assistant_turn() then
    raise exception 'H2 LIMIT FAIL: user B inherited user A''s limit';
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', false);
do $$ declare a_count bigint; b_count bigint; a_rows bigint; begin
  select coalesce(sum(request_count), 0), count(*) into a_count, a_rows
    from app.assistant_turn_buckets
   where user_id = '8a100000-0000-4000-8000-000000000001';
  select coalesce(sum(request_count), 0) into b_count
    from app.assistant_turn_buckets
   where user_id = '8a100000-0000-4000-8000-000000000002';
  if a_count <> 20 or a_rows <> 1 or b_count <> 1 then
    raise exception 'H2 LIMIT FAIL: counts/rows A=%/% B=%', a_count, a_rows, b_count;
  end if;
end $$;

-- Cleanup is indexed and bounded to 100 rows per call.
insert into app.assistant_turn_buckets(user_id, bucket_start, request_count)
select '8a100000-0000-4000-8000-000000000003',
       date_trunc('minute', now()) - (g::text || ' minutes')::interval, 1
  from generate_series(20, 124) g;
set role authenticated;
do $$ begin
  perform _t_login('8a100000-0000-4000-8000-000000000003');
  if not public.consume_assistant_turn() then
    raise exception 'H2 LIMIT FAIL: cleanup call was unexpectedly denied';
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', false);
do $$ declare old_rows bigint; begin
  select count(*) into old_rows
    from app.assistant_turn_buckets
   where bucket_start < date_trunc('minute', now()) - interval '10 minutes';
  if old_rows <> 5 then
    raise exception 'H2 LIMIT FAIL: bounded cleanup left % old rows rather than 5', old_rows;
  end if;
end $$;

select 'ALL H2 ATOMIC VOICE-COMMAND TESTS PASSED' as result;
-- ═════════════════════════════════════════════════════════════════
-- G19 — STANDING COSTS: RECURRING EXPENSES (0483)
-- ═════════════════════════════════════════════════════════════════
-- The sales side has had standing invoices since 0433. This is the same feature on the
-- cost side, and it has to hold two claims that are not the same claim.
--
-- The first is tenancy, and it is the ordinary one: what a contractor pays in rent,
-- insurance and salaries is the contractor's business. Not the farms they work for — a
-- farm reading its contractor's cost base is reading its margin on every job — and not
-- the contractor down the road.
--
-- The second is arithmetic, and it is the one that makes this feature worth having or
-- worth deleting. A generated expense must be captured EXACTLY ONCE per period. Booking
-- October's rent twice is not a cosmetic duplicate: it overstates cost on the money
-- screen, over-claims input VAT on a return that gets FILED, and inflates the creditors
-- list. So the idempotency key is asserted against the two ways it is actually attacked —
-- a cron that fires twice, and a partner pressing "capture it now" on a schedule that has
-- already run this period.
--
-- And the last assertion is the point of the whole design: the generated row is an
-- ORDINARY `partner_expenses` row, so it reaches `app.partner_pl` with no special casing
-- anywhere downstream. If that ever stops being true, the feature has quietly grown a
-- parallel ledger.
--
-- Its own farm and workshops, so the numbers below are the only numbers in play.
-- ═════════════════════════════════════════════════════════════════════════════

insert into farms (id, name) values ('6f000000-0000-0000-0000-000000000001', 'Farm RE');
insert into workshops (id, name, kind) values
  ('6f100000-0000-0000-0000-000000000001', 'Workshop RE-A', 'mechanic'),
  ('6f100000-0000-0000-0000-000000000002', 'Workshop RE-B', 'tyre');
-- A is a live contractor to the farm. That ACTIVE link is what makes the farm-side
-- assertion below meaningful: the farm has every legitimate reason to see A's work, and
-- still must see none of A's costs.
insert into workshop_links (workshop_id, farm_id, status) values
  ('6f100000-0000-0000-0000-000000000001', '6f000000-0000-0000-0000-000000000001', 'active');

insert into auth.users (id, email) values
  ('6f200000-0000-0000-0000-000000000001', 'reA@test'),
  ('6f200000-0000-0000-0000-000000000002', 'reB@test'),
  ('6f200000-0000-0000-0000-000000000003', 'reFarm@test');
insert into users (id, farm_id, workshop_id, role, name, email) values
  ('6f200000-0000-0000-0000-000000000001', null, '6f100000-0000-0000-0000-000000000001', 'workshop', 'A Staff', 'reA@test'),
  ('6f200000-0000-0000-0000-000000000002', null, '6f100000-0000-0000-0000-000000000002', 'workshop', 'B Staff', 'reB@test'),
  ('6f200000-0000-0000-0000-000000000003', '6f000000-0000-0000-0000-000000000001', null, 'owner', 'RE Owner', 'reFarm@test');

-- Four schedules for A, covering the four states the generator has to tell apart, plus
-- one for B so "another workshop" is a real workshop with real rows rather than an empty
-- account that would pass every read test by accident.
--
-- Every due schedule is dated TODAY on purpose. One cadence forward is a month, so after
-- one run nothing is due again — which makes "run it twice, get one expense" a statement
-- about the whole table rather than about one carefully filtered period.
insert into recurring_expenses (
  id, workshop_id, name, supplier_name, reference, category,
  amount_cents, vat_rate_bps, vat_cents, vat_claimable,
  cadence, next_due_date, ends_on, auto_paid, active
) values
  -- (1) The ordinary case: monthly rent, due today, still owed when it is captured.
  ('6f300000-0000-0000-0000-000000000001', '6f100000-0000-0000-0000-000000000001',
   'Workshop rent', 'Kerkstraat Eiendomme', 'ACC-4471', 'rent',
   400000, 1500, 60000, true, 'monthly', current_date, null, false, true),
  -- (2) PAUSED. A partner who stops paying for something switches the schedule off; it
  --     must then produce nothing at all, not "nothing until somebody notices".
  ('6f300000-0000-0000-0000-000000000002', '6f100000-0000-0000-0000-000000000001',
   'Alarm monitoring', 'Sekuriteit SA', 'SEC-9', 'admin',
   120000, 1500, 18000, true, 'monthly', current_date, null, false, false),
  -- (3) The LAST run of a schedule with an end date, and a debit order that really does
  --     leave the bank on the day (auto_paid). The next period falls past ends_on, so
  --     this run is the one that must switch the schedule off.
  ('6f300000-0000-0000-0000-000000000003', '6f100000-0000-0000-0000-000000000001',
   'Accounting retainer', 'Van Wyk Rekenmeesters', 'VW-2231', 'admin',
   250000, 1500, 37500, true, 'monthly', current_date, current_date + 5, true, true),
  -- (4) Not due yet. The commonest state a schedule is in, and the one a generator that
  --     forgot its date filter would silently bill a month early.
  ('6f300000-0000-0000-0000-000000000004', '6f100000-0000-0000-0000-000000000001',
   'Salaries', 'Payroll', null, 'salaries',
   999900, 1500, 149985, true, 'monthly', current_date + 30, null, false, true),
  -- (5) Workshop B's own standing cost.
  ('6f300000-0000-0000-0000-000000000005', '6f100000-0000-0000-0000-000000000002',
   'Tyre bay rent', 'Nywerheidspark', null, 'rent',
   111100, 1500, 16665, true, 'monthly', current_date, null, false, true);

-- ── (a) A farm cannot read its contractor's standing costs ───────────────────
set role authenticated;
do $$ declare c bigint; begin
  perform _t_login('6f200000-0000-0000-0000-000000000003');       -- Farm RE owner
  select count(*) into c from recurring_expenses;
  if c <> 0 then
    raise exception 'G19 FAIL [MARGIN LEAK]: a farm read % of its contractor''s standing costs', c;
  end if;
end $$;

-- ── (b) Nor can another contractor ───────────────────────────────────────────
do $$ declare c bigint; begin
  perform _t_login('6f200000-0000-0000-0000-000000000002');       -- Workshop RE-B
  select count(*) into c from recurring_expenses
   where workshop_id = '6f100000-0000-0000-0000-000000000001';
  if c <> 0 then
    raise exception 'G19 FAIL [COMPETITOR]: another workshop read % of A''s schedules', c;
  end if;
  select count(*) into c from recurring_expenses;
  if c <> 1 then
    raise exception 'G19 FAIL: Workshop B sees % schedules rather than its own 1', c;
  end if;
end $$;

-- ── (c) And cannot write one into somebody else's books ──────────────────────
-- The interesting half: a cost schedule planted in another workshop's account would
-- quietly reduce their profit every month for as long as nobody looked.
do $$ declare ok boolean := false; begin
  perform _t_login('6f200000-0000-0000-0000-000000000002');
  begin
    insert into recurring_expenses (workshop_id, name, supplier_name, amount_cents, next_due_date)
    values ('6f100000-0000-0000-0000-000000000001', 'Planted', 'Nobody', 500000, current_date);
  exception when insufficient_privilege then ok := true; end;
  if not ok then
    raise exception 'G19 FAIL: a workshop wrote a standing cost into another workshop''s books';
  end if;
end $$;

-- ── (d) The owner sees exactly its own four ──────────────────────────────────
do $$ declare c bigint; begin
  perform _t_login('6f200000-0000-0000-0000-000000000001');       -- Workshop RE-A
  select count(*) into c from recurring_expenses;
  if c <> 4 then raise exception 'G19 FAIL: Workshop A sees % of its own 4 schedules', c; end if;
end $$;

-- ── (e) The generator is service-role only, from a signed-in session ─────────
-- It is SECURITY DEFINER and takes an id, so a caller who could execute it could write a
-- cost into any workshop's books. `run_recurring_expense` is the only door, and it checks
-- ownership before it opens.
do $$ declare ok boolean := false; begin
  perform _t_login('6f200000-0000-0000-0000-000000000001');
  begin perform app.generate_recurring_expenses(null);
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G19 FAIL: a signed-in user executed the generator directly'; end if;
end $$;
do $$ declare ok boolean := false; begin
  perform _t_login('6f200000-0000-0000-0000-000000000001');
  begin perform public.cron_generate_recurring_expenses();
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G19 FAIL: a signed-in user executed the cron wrapper'; end if;
end $$;
reset role;

-- ── (f) Anon reaches nothing at all ──────────────────────────────────────────
set role anon;
do $$ declare ok boolean := false; begin
  begin perform count(*) from recurring_expenses; exception when others then ok := true; end;
  if not ok then raise exception 'G19 FAIL: anon read the standing-cost schedules'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform app.generate_recurring_expenses(null); exception when others then ok := true; end;
  if not ok then raise exception 'G19 FAIL: anon ran the generator'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform public.cron_generate_recurring_expenses(); exception when others then ok := true; end;
  if not ok then raise exception 'G19 FAIL: anon ran the cron wrapper'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform public.run_recurring_expense('6f300000-0000-0000-0000-000000000001');
  exception when others then ok := true; end;
  if not ok then raise exception 'G19 FAIL: anon ran "capture it now"'; end if;
end $$;
reset role;

-- ── (g) THE IDEMPOTENCY KEY. Two runs, one expense ───────────────────────────
-- The cron firing twice is not hypothetical: a retry after a half-finished night looks
-- exactly like this. `last_period_start` is what makes the second run a no-op.
do $$ declare first_run int; second_run int; begin
  first_run  := app.generate_recurring_expenses(null);
  second_run := app.generate_recurring_expenses(null);
  -- Three due schedules across both workshops: A's rent, A's ending retainer, B's rent.
  if first_run <> 3 then
    raise exception 'G19 FAIL: the first run captured % expenses rather than 3', first_run;
  end if;
  if second_run <> 0 then
    raise exception 'G19 FAIL [DOUBLE BOOK]: a second run captured % more expenses — the same period was billed twice', second_run;
  end if;
end $$;

do $$ declare c bigint; begin
  select count(*) into c from partner_expenses
   where workshop_id = '6f100000-0000-0000-0000-000000000001'
     and supplier_name = 'Kerkstraat Eiendomme';
  if c <> 1 then
    raise exception 'G19 FAIL [DOUBLE BOOK]: % rent expenses exist for one period, expected exactly 1', c;
  end if;
end $$;

-- ── (h) …including when the partner presses the button themselves ────────────
-- Same guard, reached by a different door. And the door itself is locked: B may not
-- capture A's cost even though the generator underneath would happily do it.
set role authenticated;
do $$ declare ok boolean := false; begin
  perform _t_login('6f200000-0000-0000-0000-000000000002');       -- Workshop RE-B
  begin
    perform public.run_recurring_expense('6f300000-0000-0000-0000-000000000001');
  exception when insufficient_privilege then ok := true; end;
  if not ok then
    raise exception 'G19 FAIL: a workshop captured another workshop''s standing cost';
  end if;
end $$;

do $$ declare made int; c bigint; begin
  perform _t_login('6f200000-0000-0000-0000-000000000001');       -- Workshop RE-A, its own
  made := public.run_recurring_expense('6f300000-0000-0000-0000-000000000001');
  if made <> 0 then
    raise exception 'G19 FAIL [DOUBLE BOOK]: "capture it now" raised % expenses for a period already captured', made;
  end if;
  select count(*) into c from partner_expenses
   where workshop_id = '6f100000-0000-0000-0000-000000000001'
     and supplier_name = 'Kerkstraat Eiendomme';
  if c <> 1 then
    raise exception 'G19 FAIL [DOUBLE BOOK]: pressing the button left % rent expenses', c;
  end if;
end $$;
reset role;

-- ── (i) The generated row is a correct expense ───────────────────────────────
-- Ex-VAT integer cents, the schedule's category, the PERIOD's date (not the night the
-- cron happened to run — a late run must still land in the month the cost belongs to),
-- and still owed, because rent is not a debit order unless the partner says it is.
do $$ declare e record; begin
  select * into e from partner_expenses
   where workshop_id = '6f100000-0000-0000-0000-000000000001'
     and supplier_name = 'Kerkstraat Eiendomme' and deleted_at is null;
  if e.amount_cents <> 400000 then
    raise exception 'G19 FAIL: the captured expense is % cents rather than 400000 ex-VAT', e.amount_cents;
  end if;
  if e.vat_cents <> 60000 then
    raise exception 'G19 FAIL: the captured VAT is % rather than 60000', e.vat_cents;
  end if;
  if e.category <> 'rent' then
    raise exception 'G19 FAIL: the captured expense landed in category % rather than rent', e.category;
  end if;
  if e.expense_date <> current_date then
    raise exception 'G19 FAIL: the expense is dated % rather than the period it covers', e.expense_date;
  end if;
  if e.paid_on is not null then
    raise exception 'G19 FAIL: an expense with auto_paid off was recorded as already paid';
  end if;
  if e.reference is distinct from 'ACC-4471' or not e.vat_claimable then
    raise exception 'G19 FAIL: the supplier reference or the VAT-claimable flag did not carry across';
  end if;
end $$;

-- A debit order DOES leave the bank on the day, and says so.
do $$ declare e record; begin
  select * into e from partner_expenses
   where workshop_id = '6f100000-0000-0000-0000-000000000001'
     and supplier_name = 'Van Wyk Rekenmeesters' and deleted_at is null;
  if e.paid_on <> current_date then
    raise exception 'G19 FAIL: an auto_paid schedule recorded paid_on as % rather than the period date', e.paid_on;
  end if;
end $$;

-- ── (j) A paused schedule and a not-yet-due one produce nothing ──────────────
do $$ declare c bigint; begin
  select count(*) into c from partner_expenses
   where workshop_id = '6f100000-0000-0000-0000-000000000001'
     and supplier_name in ('Sekuriteit SA', 'Payroll');
  if c <> 0 then
    raise exception 'G19 FAIL: % expenses were captured from a paused or not-yet-due schedule', c;
  end if;
end $$;

-- ── (k) A schedule that has reached its end date stops itself ────────────────
-- The next period falls past `ends_on`, so the run that captured the final expense is
-- also the run that switches the schedule off — otherwise it sits due for ever, and the
-- only thing standing between it and a repeat is the idempotency key doing a job it was
-- not meant to do alone.
do $$ declare r record; n int; begin
  select * into r from recurring_expenses where id = '6f300000-0000-0000-0000-000000000003';
  if r.active then
    raise exception 'G19 FAIL: a schedule past its end date is still live (next due %, ends %)',
      r.next_due_date, r.ends_on;
  end if;
  if r.last_period_start <> current_date or r.last_expense_id is null then
    raise exception 'G19 FAIL: the final run did not record the period it covered';
  end if;
  n := app.generate_recurring_expenses(null);
  if n <> 0 then
    raise exception 'G19 FAIL: an ended schedule captured % further expenses', n;
  end if;
end $$;

-- ── (l) The date moved on, by the same arithmetic the screen uses ────────────
do $$ declare r record; begin
  select * into r from recurring_expenses where id = '6f300000-0000-0000-0000-000000000001';
  if r.next_due_date <> app.advance_by_cadence(current_date, 'monthly') then
    raise exception 'G19 FAIL: after a run the next date is % rather than one month on', r.next_due_date;
  end if;
  if r.last_period_start <> current_date then
    raise exception 'G19 FAIL: last_period_start is % rather than the period just captured', r.last_period_start;
  end if;
end $$;

-- ── (m) It reaches the money screen with no special casing ───────────────────
-- The whole point of writing ordinary `partner_expenses` rows. If this ever fails, the
-- feature has grown a parallel ledger and the P&L is understating cost by whatever the
-- standing charges come to — which is exactly the money a partner set the schedule up to
-- stop losing track of.
--   rent 400000 + retainer 250000 = 650000, no blocked VAT (both claimable)
do $$ declare r record; begin
  select * into r from app.partner_pl('6f100000-0000-0000-0000-000000000001',
                                      current_date, current_date);
  if r.expenses_ex_cents <> 650000 then
    raise exception 'G19 FAIL: the P&L sees % of standing cost rather than 650000 — generated expenses are not reaching the money screen', r.expenses_ex_cents;
  end if;
  if r.cost_cents <> 650000 then
    raise exception 'G19 FAIL: cost is % rather than 650000', r.cost_cents;
  end if;
  if r.profit_cents <> -650000 then
    raise exception 'G19 FAIL: profit is % rather than -650000 (no revenue, 650000 of standing cost)', r.profit_cents;
  end if;
end $$;

-- And it is the RIGHT workshop's cost. B's rent went to B, not into A's total.
do $$ declare v bigint; begin
  select expenses_ex_cents into v from app.partner_pl('6f100000-0000-0000-0000-000000000002',
                                                      current_date, current_date);
  if v <> 111100 then
    raise exception 'G19 FAIL [CROSS-PARTNER]: Workshop B''s standing cost reads % rather than 111100', v;
  end if;
end $$;

select 'ALL G19 RECURRING-EXPENSE TESTS PASSED' as result;
-- ═════════════════════════════════════════════════════════════════════════════
-- G18 — SUPPLIERS ARE RECORDS, NOT TYPING (0480–0482)
--
-- The defect this section exists to pin is not a leak; it is a report that was wrong in a
-- way nobody could see. `app.partner_creditors` grouped the payables ageing by
-- `btrim(supplier_name)`, so "Agri Diesel" and "agri diesel " were two businesses owed
-- money, and the partner reading "who do I owe" added them up by eye. The section proves
-- the old behaviour FIRST — two rows, on the same data — and then proves it is gone, with
-- the totals unchanged. A merge that quietly changed what is owed would be worse than the
-- split it replaced.
--
-- Around that sit the guarantees the merge rests on:
--
--   * the record is workshop-scoped, on the 0430 policy set: a rival workshop reads none
--     and can write none, the FARM this workshop works for reads none — a supplier list
--     with terms and account numbers is the margin behind every quote it is given (F16) —
--     and anon reads nothing at all;
--   * the composite foreign key makes an expense pointing at ANOTHER workshop's supplier
--     structurally impossible, not merely unreachable through the screens;
--   * the resolution trigger links by trimmed, case-insensitive name and NEVER invents a
--     supplier for a name it does not know. Auto-creating would put the typo back wearing
--     a better coat, and would do it at the moment nobody is looking;
--   * the backfill is idempotent, because "run it again" is an ordinary operation — a
--     partner who files a supplier today has three years of invoices to attach to it.
--
-- `app.link_suppliers()` is deliberately GLOBAL (it files a supplier per distinct name for
-- every workshop), so this section belongs at the END of the suite, where the sections
-- whose expenses it also links have already made their assertions.
-- ═════════════════════════════════════════════════════════════════════════════

-- Its own farm, workshops and people, so every number below states its own inputs.
insert into farms (id, name) values ('6e000000-0000-0000-0000-000000000001', 'Farm V');

insert into workshops (id, name, kind, vat_registered, default_vat_rate_bps) values
  ('6e100000-0000-0000-0000-000000000001', 'Workshop R', 'mechanic',       true, 1500),
  ('6e100000-0000-0000-0000-000000000002', 'Workshop S', 'parts_supplier', true, 1500);

-- R works for Farm V. This link is the whole reason the farm assertion below is worth
-- making: it is what makes R visible to the farm at all, and it must open nothing here.
insert into workshop_links (workshop_id, farm_id, status) values
  ('6e100000-0000-0000-0000-000000000001', '6e000000-0000-0000-0000-000000000001', 'active');

insert into auth.users (id, email) values
  ('6e200000-0000-0000-0000-000000000001', 'rstaff@test'),
  ('6e200000-0000-0000-0000-000000000002', 'sstaff@test'),
  ('6e300000-0000-0000-0000-000000000001', 'ownerV@test');

insert into users (id, farm_id, workshop_id, role, name, email) values
  ('6e200000-0000-0000-0000-000000000001', null, '6e100000-0000-0000-0000-000000000001', 'workshop', 'R Staff', 'r@test'),
  ('6e200000-0000-0000-0000-000000000002', null, '6e100000-0000-0000-0000-000000000002', 'workshop', 'S Staff', 's@test'),
  ('6e300000-0000-0000-0000-000000000001', '6e000000-0000-0000-0000-000000000001', null, 'owner', 'Owner V', 'v@test');

-- ── (a) The defect, reproduced on real rows ─────────────────────────────────
-- Two invoices from ONE business, captured on two days by two people who typed its name
-- differently. Nothing here is contrived: the padding and the capital D are what actually
-- comes off a phone keyboard in a workshop.
--   R1 150,00 five days ago  (1 000,00 + 150,00 VAT)  -> the 0–30 day bucket
--   R  575,00 forty days ago (  500,00 +  75,00 VAT)  -> the 31–60 day bucket
insert into partner_expenses (id, workshop_id, supplier_name, reference, category, expense_date,
                              amount_cents, vat_rate_bps, vat_cents, vat_claimable)
values
  ('6e400000-0000-0000-0000-000000000001', '6e100000-0000-0000-0000-000000000001',
   'Agri Diesel',   'AD-1001', 'fuel', current_date - 5,  100000, 1500, 15000, true),
  ('6e400000-0000-0000-0000-000000000002', '6e100000-0000-0000-0000-000000000001',
   '  agri diesel ', 'AD-1002', 'fuel', current_date - 40,  50000, 1500,  7500, true),
  -- A second workshop, so every "reads zero" below is measured against a real row rather
  -- than an empty table.
  ('6e400000-0000-0000-0000-000000000003', '6e100000-0000-0000-0000-000000000002',
   'Bolt Barn', 'BB-77', 'parts', current_date - 3, 20000, 1500, 3000, true);

-- Nothing is filed yet, so nothing is linked. Stated rather than assumed, because the
-- whole backfill assertion below depends on starting from unlinked rows.
do $$ declare c bigint; begin
  select count(*) into c from partner_expenses
   where workshop_id = '6e100000-0000-0000-0000-000000000001' and supplier_id is not null;
  if c <> 0 then raise exception 'G18 FAIL: % expenses were linked before any supplier existed', c; end if;
end $$;

-- THE OLD BEHAVIOUR, measured on these exact rows. 0460 grouped by `btrim(supplier_name)`,
-- so the defect is reproduced by asking that key what it would have done — the replaced
-- function cannot be called to demonstrate its own bug, and quoting the key is the honest
-- substitute. Two businesses owed money, where there is one.
create temp table _g18_before as
  select count(distinct btrim(supplier_name)) as rows,
         coalesce(sum(amount_cents + vat_cents), 0) as owed
    from partner_expenses
   where workshop_id = '6e100000-0000-0000-0000-000000000001'
     and deleted_at is null and paid_on is null and expense_date <= current_date;

do $$ declare r record; begin
  select * into r from _g18_before;
  if r.rows <> 2 then
    raise exception 'G18 SETUP FAIL: the old btrim() key gave % groups rather than the 2 this section exists to merge', r.rows;
  end if;
  if r.owed <> 172500 then
    raise exception 'G18 SETUP FAIL: these two invoices owe % rather than 172500', r.owed;
  end if;
end $$;

-- The fallback path, before anything is filed. Nothing is linked yet, so this is the new
-- function grouping purely on the lower-cased trimmed name — which already fixes the
-- original complaint for a workshop that never files a supplier at all. Worth pinning
-- separately: the two paths through the function are not the same code and one of them
-- being right has never implied the other is.
do $$ declare r record; c bigint; begin
  select count(*) into c from app.partner_creditors('6e100000-0000-0000-0000-000000000001'::uuid, current_date);
  if c <> 1 then
    raise exception 'G18 FAIL [FALLBACK]: two spellings of an unfiled business still age as % creditors', c;
  end if;
  select * into r from app.partner_creditors('6e100000-0000-0000-0000-000000000001'::uuid, current_date);
  if r.total_cents <> 172500 then
    raise exception 'G18 FAIL [FALLBACK]: the merged free-text row owes % rather than 172500', r.total_cents;
  end if;
end $$;

-- ── (b) The backfill files one record per business and attaches the history ──
do $$ declare res jsonb; c bigint; begin
  res := app.link_suppliers();

  select count(*) into c from suppliers where workshop_id = '6e100000-0000-0000-0000-000000000001';
  if c <> 1 then
    raise exception 'G18 FAIL [MERGE]: two spellings of one business filed % supplier records rather than 1', c;
  end if;
  if (select name from suppliers where workshop_id = '6e100000-0000-0000-0000-000000000001') <> 'Agri Diesel' then
    raise exception 'G18 FAIL: the filed record is named %, not the deterministic pick', (select name from suppliers where workshop_id = '6e100000-0000-0000-0000-000000000001');
  end if;

  -- Both invoices now point at it, whichever way the name was typed.
  select count(*) into c from partner_expenses e
    join suppliers s on s.id = e.supplier_id
   where e.workshop_id = '6e100000-0000-0000-0000-000000000001' and s.name = 'Agri Diesel';
  if c <> 2 then raise exception 'G18 FAIL: % of the 2 historical invoices attached to the supplier', c; end if;

  -- The other workshop was filed too, and separately.
  select count(*) into c from suppliers where workshop_id = '6e100000-0000-0000-0000-000000000002';
  if c <> 1 then raise exception 'G18 FAIL: the second workshop filed % records rather than 1', c; end if;
end $$;

-- ── (c) Running it again creates nothing and links nothing ──────────────────
-- The reason this matters is not tidiness. A partner files a supplier today and wants
-- three years of invoices attached to it, so this function is meant to be re-run — and a
-- re-run that duplicated records would recreate the very split it was written to fix.
do $$ declare res jsonb; c bigint; e bigint; begin
  select count(*) into c from suppliers;
  select count(*) into e from partner_expenses where supplier_id is not null;

  res := app.link_suppliers();

  if (res ->> 'suppliers_created')::bigint <> 0
     or (res ->> 'expenses_linked')::bigint <> 0
     or (res ->> 'orders_linked')::bigint <> 0 then
    raise exception 'G18 FAIL [NOT IDEMPOTENT]: a second backfill reported %', res;
  end if;
  if (select count(*) from suppliers) <> c then
    raise exception 'G18 FAIL [NOT IDEMPOTENT]: a second backfill left % supplier records rather than %',
      (select count(*) from suppliers), c;
  end if;
  if (select count(*) from partner_expenses where supplier_id is not null) <> e then
    raise exception 'G18 FAIL [NOT IDEMPOTENT]: a second backfill changed the link count from % to %',
      e, (select count(*) from partner_expenses where supplier_id is not null);
  end if;
end $$;

-- ── (d) THE POINT: one business, one line, same money ───────────────────────
-- Two invoices, two spellings, two ageing buckets — and now one creditor. The buckets
-- must survive the merge intact: 1 150,00 five days old is not the same debt as 575,00
-- forty days old, and a report that merged them into a single "total owed" would have
-- traded one lie for another.
do $$ declare r record; b record; begin
  select * into b from _g18_before;
  select * into r from app.partner_creditors('6e100000-0000-0000-0000-000000000001'::uuid, current_date);

  if (select count(*) from app.partner_creditors('6e100000-0000-0000-0000-000000000001'::uuid, current_date)) <> 1 then
    raise exception 'G18 FAIL [MERGE]: one business still ages as % creditors',
      (select count(*) from app.partner_creditors('6e100000-0000-0000-0000-000000000001'::uuid, current_date));
  end if;
  if r.supplier <> 'Agri Diesel' then
    raise exception 'G18 FAIL: the merged row is titled % rather than the supplier record''s own name', r.supplier;
  end if;
  if r.current_cents <> 115000 or r.d30_cents <> 57500 or r.d60_cents <> 0 or r.d90_cents <> 0 then
    raise exception 'G18 FAIL [BUCKETS]: merging moved the money to %/%/%/% rather than 115000/57500/0/0',
      r.current_cents, r.d30_cents, r.d60_cents, r.d90_cents;
  end if;
  if r.total_cents <> b.owed then
    raise exception 'G18 FAIL [TOTALS CHANGED]: the ageing now owes % where the free-text version owed %',
      r.total_cents, b.owed;
  end if;
end $$;

-- The public wrapper is the API PostgREST actually calls, and it must agree with the
-- helper. A screen reading a different figure from the one this section proved is the
-- failure mode the wrapper exists to make impossible.
do $$ declare v bigint; begin
  select total_cents into v from public.partner_creditors('6e100000-0000-0000-0000-000000000001'::uuid, current_date);
  if v <> 172500 then raise exception 'G18 FAIL: the public wrapper owed % rather than 172500', v; end if;
end $$;

-- ── (e) The resolution trigger links by name, and invents nothing ───────────
insert into suppliers (id, workshop_id, name, contact_person, phone, vat_number, payment_terms_days)
values ('6e500000-0000-0000-0000-000000000001', '6e100000-0000-0000-0000-000000000001',
        'Bearing Co', 'Riaan', '+27821234567', '4123456789', 30);

-- Padding and capitals. This is the case the whole feature turns on, and it is the one a
-- string comparison written in a hurry gets wrong.
insert into partner_expenses (id, workshop_id, supplier_name, category, expense_date,
                              amount_cents, vat_rate_bps, vat_cents)
values ('6e400000-0000-0000-0000-000000000004', '6e100000-0000-0000-0000-000000000001',
        '  bEaRiNg cO  ', 'parts', current_date - 1, 30000, 1500, 4500);
do $$ declare v uuid; begin
  select supplier_id into v from partner_expenses where id = '6e400000-0000-0000-0000-000000000004';
  if v is distinct from '6e500000-0000-0000-0000-000000000001' then
    raise exception 'G18 FAIL [RESOLUTION]: "  bEaRiNg cO  " linked to % rather than the Bearing Co record', v;
  end if;
end $$;

-- An unknown name stays free text. It must NOT quietly become a supplier: that is how a
-- typo stops being a phantom string and starts being a phantom business.
insert into partner_expenses (id, workshop_id, supplier_name, category, expense_date,
                              amount_cents, vat_rate_bps, vat_cents)
values ('6e400000-0000-0000-0000-000000000005', '6e100000-0000-0000-0000-000000000001',
        'Bearng Co', 'parts', current_date - 1, 10000, 1500, 1500);
do $$ declare v uuid; c bigint; begin
  select supplier_id into v from partner_expenses where id = '6e400000-0000-0000-0000-000000000005';
  if v is not null then
    raise exception 'G18 FAIL [RESOLUTION]: a name nobody has filed was linked to %', v;
  end if;
  select count(*) into c from suppliers where workshop_id = '6e100000-0000-0000-0000-000000000001';
  if c <> 2 then
    raise exception 'G18 FAIL [TYPO MINTED A RECORD]: a misspelling left % supplier records rather than 2', c;
  end if;
end $$;

-- The order book resolves the same way, from the same trigger.
insert into purchase_orders (id, workshop_id, supplier_name, reference, order_date, vat_rate_bps)
values ('6e600000-0000-0000-0000-000000000001', '6e100000-0000-0000-0000-000000000001',
        'BEARING CO', 'PO-2001', current_date - 2, 1500);
do $$ declare v uuid; begin
  select supplier_id into v from purchase_orders where id = '6e600000-0000-0000-0000-000000000001';
  if v is distinct from '6e500000-0000-0000-0000-000000000001' then
    raise exception 'G18 FAIL [RESOLUTION]: a purchase order for "BEARING CO" linked to % rather than the record', v;
  end if;
end $$;

-- Correcting the name away from the supplier drops the link. Leaving it would file the row
-- under a business it no longer names, and the ageing would report money owed to the wrong
-- one — the exact failure this feature exists to end, arriving by a different door.
update partner_expenses set supplier_name = 'Somebody Else' where id = '6e400000-0000-0000-0000-000000000004';
do $$ declare v uuid; begin
  select supplier_id into v from partner_expenses where id = '6e400000-0000-0000-0000-000000000004';
  if v is not null then
    raise exception 'G18 FAIL [STALE LINK]: renaming the supplier on an invoice left it filed under %', v;
  end if;
end $$;
-- …and correcting it back restores it, without anybody touching an id.
update partner_expenses set supplier_name = 'Bearing Co' where id = '6e400000-0000-0000-0000-000000000004';
do $$ declare v uuid; begin
  select supplier_id into v from partner_expenses where id = '6e400000-0000-0000-0000-000000000004';
  if v is distinct from '6e500000-0000-0000-0000-000000000001' then
    raise exception 'G18 FAIL [RESOLUTION]: correcting the name back left the invoice linked to %', v;
  end if;
end $$;

-- Filing a supplier AFTER the invoices were captured is the ordinary case, and it is what
-- makes the backfill a routine rather than a migration step: the record appears, the
-- history attaches to it, and no second record is created for the name it already has.
insert into suppliers (id, workshop_id, name)
values ('6e500000-0000-0000-0000-000000000002', '6e100000-0000-0000-0000-000000000001', 'bearng co');
do $$ declare res jsonb; v uuid; c bigint; begin
  res := app.link_suppliers();
  select supplier_id into v from partner_expenses where id = '6e400000-0000-0000-0000-000000000005';
  if v is distinct from '6e500000-0000-0000-0000-000000000002' then
    raise exception 'G18 FAIL: filing the supplier afterwards left its invoice linked to %', v;
  end if;
  if (res ->> 'suppliers_created')::bigint <> 0 then
    raise exception 'G18 FAIL: the backfill filed % extra records for a name that was already on the books',
      (res ->> 'suppliers_created')::bigint;
  end if;
  select count(*) into c from suppliers where workshop_id = '6e100000-0000-0000-0000-000000000001';
  if c <> 3 then raise exception 'G18 FAIL: workshop R holds % supplier records rather than 3', c; end if;
end $$;

-- ── (f) One workshop's supplier, one workshop's expense ─────────────────────
-- RLS already stops S READING R's suppliers; the composite foreign key makes the
-- cross-workshop write impossible even from a caller that has bypassed the screens
-- entirely (this insert runs as the superuser, with RLS out of the picture).
do $$ declare ok boolean := false; begin
  begin
    insert into partner_expenses (workshop_id, supplier_name, category, expense_date,
                                  amount_cents, vat_rate_bps, vat_cents, supplier_id)
    values ('6e100000-0000-0000-0000-000000000002', 'Bearing Co', 'parts', current_date,
            10000, 1500, 1500, '6e500000-0000-0000-0000-000000000001');
  exception when others then ok := true; end;
  if not ok then
    raise exception 'G18 FAIL [CROSS-TENANT]: one workshop''s expense was filed against another workshop''s supplier';
  end if;
end $$;
do $$ declare ok boolean := false; begin
  begin
    insert into purchase_orders (workshop_id, supplier_name, order_date, supplier_id)
    values ('6e100000-0000-0000-0000-000000000002', 'Bearing Co', current_date,
            '6e500000-0000-0000-0000-000000000001');
  exception when others then ok := true; end;
  if not ok then
    raise exception 'G18 FAIL [CROSS-TENANT]: one workshop''s order was raised against another workshop''s supplier';
  end if;
end $$;

-- Two live records of the same name, in one workshop, are refused. Without this the merge
-- is only as good as whoever last typed into the add form.
do $$ declare ok boolean := false; begin
  begin
    insert into suppliers (workshop_id, name)
    values ('6e100000-0000-0000-0000-000000000001', '  AGRI DIESEL ');
  exception when others then ok := true; end;
  if not ok then
    raise exception 'G18 FAIL [DUPLICATE]: the same business was filed twice under different capitals';
  end if;
end $$;
-- The same name in ANOTHER workshop is a different business and is allowed. Two workshops
-- buying from the same depot is the normal state of a small town.
insert into suppliers (id, workshop_id, name)
values ('6e500000-0000-0000-0000-000000000003', '6e100000-0000-0000-0000-000000000002', 'Agri Diesel');

-- ── (g) Nobody else reads the supplier book ─────────────────────────────────
set role authenticated;
do $$ begin
  perform _t_login('6e200000-0000-0000-0000-000000000001');       -- R staff, whose suppliers these are
  perform _t_assert('suppliers', 3, 'Workshop R');                -- Agri Diesel, Bearing Co, bearng co
end $$;

do $$ declare c bigint; begin
  perform _t_login('6e200000-0000-0000-0000-000000000002');       -- Workshop S, a rival
  select count(*) into c from suppliers where workshop_id = '6e100000-0000-0000-0000-000000000001';
  if c <> 0 then
    raise exception 'G18 FAIL [COMPETITOR]: a rival workshop read % of R''s suppliers - that is R''s buying relationships', c;
  end if;
  -- Its own book is intact, so the zero above is isolation and not an empty table.
  select count(*) into c from suppliers;
  if c <> 2 then raise exception 'G18 FAIL: workshop S sees % of its own supplier records rather than 2', c; end if;
end $$;

-- …and cannot write into R's book either, by insert or by update.
do $$ declare ok boolean := false; c bigint; begin
  perform _t_login('6e200000-0000-0000-0000-000000000002');
  begin
    insert into suppliers (workshop_id, name)
    values ('6e100000-0000-0000-0000-000000000001', 'Planted');
  exception when others then ok := true; end;
  if not ok then raise exception 'G18 FAIL [CROSS-TENANT WRITE]: a rival filed a supplier on R''s account'; end if;

  update suppliers set phone = '+27000000000' where id = '6e500000-0000-0000-0000-000000000001';
  get diagnostics c = row_count;
  if c <> 0 then raise exception 'G18 FAIL [CROSS-TENANT WRITE]: a rival updated % of R''s suppliers', c; end if;

  -- Nor can it read R's payables through the report. The function is SECURITY INVOKER, so
  -- passing somebody else's workshop id is answered by RLS rather than by a check in the
  -- body that somebody could forget to write.
  select count(*) into c from app.partner_creditors('6e100000-0000-0000-0000-000000000001'::uuid, current_date);
  if c <> 0 then raise exception 'G18 FAIL [COMPETITOR]: a rival read % rows of R''s payables ageing', c; end if;
end $$;

-- The FARM this workshop works for. An active workshop_link is what lets R reach Farm V's
-- vehicles; it must open nothing in R's own supplier book, because a farm reading who its
-- contractor buys from and on what terms is reading the margin on every quote it has ever
-- been given (F16).
do $$ declare c bigint; begin
  perform _t_login('6e300000-0000-0000-0000-000000000001');       -- Owner V
  select count(*) into c from suppliers;
  if c <> 0 then raise exception 'G18 FAIL [MARGIN LEAK]: a farm read % of its contractor''s suppliers', c; end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

set role anon;
do $$ declare ok boolean := false; begin
  begin perform count(*) from suppliers; exception when others then ok := true; end;
  if not ok then raise exception 'G18 FAIL: anon read the supplier book'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin
    insert into suppliers (workshop_id, name)
    values ('6e100000-0000-0000-0000-000000000001', 'Anon Co');
  exception when others then ok := true; end;
  if not ok then raise exception 'G18 FAIL: anon filed a supplier'; end if;
end $$;
-- G11's rule, restated where the functions were added: an app-schema helper with no
-- explicit grant defaults to EXECUTE TO PUBLIC, and both of these rewrite or expose money.
do $$ declare ok boolean := false; begin
  begin perform app.link_suppliers(); exception when others then ok := true; end;
  if not ok then raise exception 'G18 FAIL: anon ran the supplier backfill'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform app.partner_creditors('6e100000-0000-0000-0000-000000000001'::uuid, current_date);
  exception when others then ok := true; end;
  if not ok then raise exception 'G18 FAIL: anon read the payables ageing'; end if;
end $$;
reset role;

select 'ALL G18 SUPPLIER TESTS PASSED' as result;
-- ═════════════════════════════════════════════════════════════════════════════
-- G20 — WHAT IS ABOUT TO HAPPEN TO THE BANK ACCOUNT (0486)
--
-- 0460 answers three questions that all look backwards. This one looks forwards, and a
-- forecast is a different kind of risk from a report: nothing here is a new table, so the
-- danger is not tenancy leaking — it is arithmetic that looks right and is not, and a row
-- silently included or silently dropped. Each assertion below pins a decision where a
-- plausible implementation would be wrong:
--
--   * an OVERDUE invoice is expected NOW. Bucketing it by its raw date would either drop
--     it out of the forecast altogether or fold it into "this week", which reads as a
--     promise nobody made.
--   * a DRAFT invoice has not been sent, so nobody owes it, and a WRITTEN-OFF one was
--     deliberately given up on (G5). Neither is money coming in.
--   * an unpaid supplier invoice leaves the bank GROSS. The ledger is ex-VAT; the bank is
--     not, and the VAT coming back from SARS in six weeks does not help on Friday.
--   * a CANCELLED purchase order is not a commitment, and one already converted to an
--     expense (0475) must not be counted twice — once as a commitment and once as a bill.
--   * both functions are SECURITY INVOKER, so a rival workshop asking about these books is
--     answered by RLS rather than by a check in the body.
--
-- Its own farm and workshop, so the numbers below are the only numbers in play. Every date
-- is relative to current_date and every bucket asserted is one that cannot move with the
-- day of the week: `overdue` is strictly before today, and today+32 or later is past the
-- end of any month (a month is at most 31 days, so mo_end <= today+30).
-- ═════════════════════════════════════════════════════════════════════════════

insert into farms (id, name) values ('70000000-0000-0000-0000-000000000001', 'Farm U');
insert into workshops (id, name, kind, vat_registered, default_vat_rate_bps, invoice_terms_days)
values ('70100000-0000-0000-0000-000000000001', 'Workshop V', 'mechanic', true, 1500, 30),
       ('70100000-0000-0000-0000-000000000002', 'Workshop V2 (rival)', 'mechanic', true, 1500, 30);
insert into workshop_links (workshop_id, farm_id, status) values
  ('70100000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 'active'),
  -- The rival works for the SAME farm. That is the hard case: a shared customer must not
  -- turn into a shared forecast.
  ('70100000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', 'active');

insert into auth.users (id, email) values
  ('70200000-0000-0000-0000-000000000001', 'vstaff@test'),
  ('70200000-0000-0000-0000-000000000002', 'v2staff@test'),
  ('70200000-0000-0000-0000-000000000003', 'uowner@test');
insert into users (id, farm_id, workshop_id, role, name, email) values
  ('70200000-0000-0000-0000-000000000001', null, '70100000-0000-0000-0000-000000000001', 'workshop', 'V Staff', 'v@test'),
  ('70200000-0000-0000-0000-000000000002', null, '70100000-0000-0000-0000-000000000002', 'workshop', 'V2 Staff', 'v2@test'),
  ('70200000-0000-0000-0000-000000000003', '70000000-0000-0000-0000-000000000001', null, 'owner', 'U Owner', 'u@test');

-- ── Money in: four invoices, only two of which are real forecast ─────────────
--   I1  sent, due 40 days ago, R1 000 ex -> R1 150 gross, less a R230 credit note = 92000
--   I2  DRAFT, due in 25 days                        -> never forecast: nobody owes a draft
--   I3  WRITTEN OFF, due 20 days ago                 -> never forecast: given up on (G5)
--   I4  sent, due in 45 days, R920 gross less R220 paid = 70000, lands in `later`
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                               issue_date, due_date, vat_rate_bps, bill_to_name)
values
  ('70300000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001',
   '70100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'VI-0001',
   current_date - 60, current_date - 40, 1500, 'Farm U'),
  ('70300000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001',
   '70100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'VI-0002',
   current_date - 5,  current_date + 25, 1500, 'Farm U'),
  ('70300000-0000-0000-0000-000000000003', '70000000-0000-0000-0000-000000000001',
   '70100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'VI-0003',
   current_date - 50, current_date - 20, 1500, 'Farm U'),
  ('70300000-0000-0000-0000-000000000004', '70000000-0000-0000-0000-000000000001',
   '70100000-0000-0000-0000-000000000001', 'invoice', 'draft', 'built', 'VI-0004',
   current_date - 1,  current_date + 45, 1500, 'Farm U');

-- Separate statement: 0418's note check requires a credit note to name the document it
-- corrects at insert time, so the invoice must exist first.
insert into partner_documents (id, farm_id, workshop_id, kind, status, source, number,
                               issue_date, vat_rate_bps, bill_to_name, corrects_document_id)
values
  ('70300000-0000-0000-0000-000000000005', '70000000-0000-0000-0000-000000000001',
   '70100000-0000-0000-0000-000000000001', 'credit_note', 'draft', 'built', 'VC-0001',
   current_date - 30, 1500, 'Farm U', '70300000-0000-0000-0000-000000000001');

insert into partner_document_lines (document_id, farm_id, sort_order, kind, description, qty, unit_price_cents)
values
  ('70300000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 1, 'labour', 'Gearbox',      1, 100000),
  ('70300000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', 1, 'labour', 'Not sent yet', 1, 200000),
  ('70300000-0000-0000-0000-000000000003', '70000000-0000-0000-0000-000000000001', 1, 'labour', 'Never paid',   1,  50000),
  ('70300000-0000-0000-0000-000000000004', '70000000-0000-0000-0000-000000000001', 1, 'labour', 'Big service',  1,  80000),
  ('70300000-0000-0000-0000-000000000005', '70000000-0000-0000-0000-000000000001', 1, 'labour', 'Overcharged',  1,  20000);

update partner_documents set status = 'sent', sent_at = now()
 where id in ('70300000-0000-0000-0000-000000000001', '70300000-0000-0000-0000-000000000004',
              '70300000-0000-0000-0000-000000000005');
-- VI-0003 was earned, declared, and given up on. It stays revenue on the P&L and comes off
-- again as bad debt (G14) — but it is NOT money about to arrive.
update partner_documents
   set status = 'written_off', sent_at = now(), written_off_at = now(),
       written_off_reason = 'Customer liquidated'
 where id = '70300000-0000-0000-0000-000000000003';

-- A part payment against VI-0004: R920 gross, R220 in, R700 still to come.
insert into partner_payments (farm_id, document_id, amount_cents, paid_on, method)
values ('70000000-0000-0000-0000-000000000001', '70300000-0000-0000-0000-000000000004',
        22000, current_date - 1, 'eft');

-- ── Money in: a standing invoice not raised yet ──────────────────────────────
-- Issued in 3 days on 30-day terms, so the CASH is expected on day 33 — not day 3. Left
-- with no `bill_to_name` on purpose, so the party label falls back to the schedule's name.
insert into recurring_invoices (id, workshop_id, farm_id, name, cadence, next_issue_date,
                                vat_rate_bps, active, created_by)
values ('70400000-0000-0000-0000-000000000001', '70100000-0000-0000-0000-000000000001',
        '70000000-0000-0000-0000-000000000001', 'Monthly standby', 'monthly',
        current_date + 3, 1500, true, '70200000-0000-0000-0000-000000000001');
insert into recurring_invoice_lines (recurring_id, workshop_id, sort_order, kind, description, qty, unit_price_cents)
values ('70400000-0000-0000-0000-000000000001', '70100000-0000-0000-0000-000000000001',
        1, 'labour', 'Standby fee', 1, 40000);   -- 40000 ex + 6000 VAT = 46000 gross

-- ── Money out: three supplier invoices, one of them already settled ──────────
--   E1  unpaid, dated 60 days ago -> due 30 days ago -> overdue, GROSS 115000
--   E2  PAID a day ago                                -> never forecast
--   E3  unpaid, dated 10 days ago, and it is the invoice for PO3 (0475)
insert into partner_expenses (id, workshop_id, supplier_name, reference, category, expense_date,
                              paid_on, amount_cents, vat_rate_bps, vat_cents, vat_claimable)
values
  ('70500000-0000-0000-0000-000000000001', '70100000-0000-0000-0000-000000000001',
   'Bearing Co', 'BC-991', 'parts', current_date - 60, null, 100000, 1500, 15000, true),
  ('70500000-0000-0000-0000-000000000002', '70100000-0000-0000-0000-000000000001',
   'Oil Depot', 'OD-12', 'parts', current_date - 50, current_date - 1, 70000, 1500, 10500, true);

-- ── Money out: three purchase orders ─────────────────────────────────────────
--   PO1  sent,          arriving in 2 days  -> committed, forecast at 69000 gross
--   PO2  CANCELLED                          -> never forecast: no money will move
--   PO3  part received, already invoiced    -> never forecast: E3 owns that rand
insert into purchase_orders (id, workshop_id, supplier_name, reference, order_date, expected_date,
                             status, vat_rate_bps)
values
  ('70600000-0000-0000-0000-000000000001', '70100000-0000-0000-0000-000000000001',
   'Bearing Co', 'PO-100', current_date - 3, current_date + 2, 'sent', 1500),
  ('70600000-0000-0000-0000-000000000002', '70100000-0000-0000-0000-000000000001',
   'Tyre Town', 'PO-101', current_date - 3, current_date + 2, 'draft', 1500),
  ('70600000-0000-0000-0000-000000000003', '70100000-0000-0000-0000-000000000001',
   'Filter Supply', 'PO-102', current_date - 9, current_date + 5, 'sent', 1500);

insert into purchase_order_lines (workshop_id, purchase_order_id, sort_order, description,
                                  qty_ordered, qty_received, unit_price_cents)
values
  ('70100000-0000-0000-0000-000000000001', '70600000-0000-0000-0000-000000000001', 1, 'Bearings',  1, 0, 60000),
  ('70100000-0000-0000-0000-000000000001', '70600000-0000-0000-0000-000000000002', 1, 'Tyres',     1, 0, 500000),
  ('70100000-0000-0000-0000-000000000001', '70600000-0000-0000-0000-000000000003', 1, 'Filters',   2, 1,  15000);

-- Set the two terminal-ish states AFTER the lines, so 0474's rollup cannot overwrite them.
update purchase_orders set status = 'cancelled'     where id = '70600000-0000-0000-0000-000000000002';
update purchase_orders set status = 'part_received' where id = '70600000-0000-0000-0000-000000000003';

-- The supplier's invoice for PO3 arrives. From this moment the ORDER stops being a
-- forecast outflow and the EXPENSE becomes one — exactly once between them.
insert into partner_expenses (id, workshop_id, purchase_order_id, supplier_name, reference, category,
                              expense_date, paid_on, amount_cents, vat_rate_bps, vat_cents, vat_claimable)
values ('70500000-0000-0000-0000-000000000003', '70100000-0000-0000-0000-000000000001',
        '70600000-0000-0000-0000-000000000003', 'Filter Supply', 'FS-77', 'parts',
        current_date - 10, null, 30000, 1500, 4500, true);

-- ── (a) An overdue invoice is expected NOW, and a supplier bill leaves GROSS ─
-- Both of the overdue rows are in the `overdue` bucket, not in a future one and not
-- missing. In: VI-0001 at 115000 less the 23000 credit note = 92000. Out: E1 at
-- 100000 + 15000 VAT = 115000 — the amount the bank actually loses, not the ex-VAT
-- 100000 the ledger records.
set role authenticated;
do $$ declare r record; begin
  perform _t_login('70200000-0000-0000-0000-000000000001');
  select * into r from app.partner_cashflow('70100000-0000-0000-0000-000000000001', 365)
   where bucket = 'overdue';
  if r.in_cents <> 92000 then
    raise exception 'G20 FAIL: overdue money in is % rather than 92000 (a 115000 invoice less a 23000 credit note)', r.in_cents;
  end if;
  if r.out_cents <> 115000 then
    raise exception 'G20 FAIL: overdue money out is % rather than 115000 — an unpaid supplier invoice must be forecast GROSS (100000 + 15000 VAT)', r.out_cents;
  end if;
  if r.net_cents <> -23000 or r.running_cents <> -23000 then
    raise exception 'G20 FAIL: overdue net/running is %/% rather than -23000/-23000', r.net_cents, r.running_cents;
  end if;
  if r.item_count <> 2 then
    raise exception 'G20 FAIL: the overdue bucket holds % items rather than 2', r.item_count;
  end if;
end $$;

-- The item behind it says HOW late, so the screen can put it in words rather than leaving
-- the reader to subtract two dates.
do $$ declare r record; begin
  perform _t_login('70200000-0000-0000-0000-000000000001');
  select * into r from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365)
   where source_id = '70300000-0000-0000-0000-000000000001';
  if r.bucket <> 'overdue' or r.ordinal <> 1 then
    raise exception 'G20 FAIL: a 40-day-old invoice landed in bucket %/% rather than overdue/1', r.bucket, r.ordinal;
  end if;
  if r.days_late <> 40 then
    raise exception 'G20 FAIL: an invoice due 40 days ago reports % days late', r.days_late;
  end if;
  if r.direction <> 'in' or r.amount_cents <> 92000 then
    raise exception 'G20 FAIL: the overdue invoice item is %/% rather than in/92000', r.direction, r.amount_cents;
  end if;
end $$;

-- ── (b) A draft invoice is not forecast, and neither is a written-off one ────
-- A draft has never been sent, so nobody owes it; a written-off invoice was given up on
-- deliberately and is no longer chased. Forecasting either is forecasting money that is
-- not coming.
do $$ declare n bigint; begin
  perform _t_login('70200000-0000-0000-0000-000000000001');
  select count(*) into n from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365)
   where source_id = '70300000-0000-0000-0000-000000000002';
  if n <> 0 then raise exception 'G20 FAIL: a DRAFT invoice was forecast as money coming in (% rows)', n; end if;

  select count(*) into n from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365)
   where source_id = '70300000-0000-0000-0000-000000000003';
  if n <> 0 then raise exception 'G20 FAIL: a WRITTEN-OFF invoice was forecast as money coming in (% rows)', n; end if;
end $$;

-- ── (c) A part-paid invoice is forecast for the REMAINDER, in `later` ────────
-- R920 gross, R220 already received, R700 still to come, due in 45 days — past the end of
-- any month, so this bucket cannot move with the calendar.
do $$ declare r record; begin
  perform _t_login('70200000-0000-0000-0000-000000000001');
  select * into r from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365)
   where source_id = '70300000-0000-0000-0000-000000000004';
  if r.amount_cents <> 70000 then
    raise exception 'G20 FAIL: a part-paid invoice is forecast at % rather than the outstanding 70000', r.amount_cents;
  end if;
  if r.bucket <> 'later' then
    raise exception 'G20 FAIL: an invoice due in 45 days landed in % rather than later', r.bucket;
  end if;
end $$;

-- ── (d) Cash arrives on the TERMS date, not the issue date ──────────────────
-- The standing invoice is raised in 3 days on the workshop's 30-day terms, so the money is
-- expected on day 33. Forecasting it on day 3 would show cash that is a month away as cash
-- this week, which is the single most dangerous way for a forecast to be wrong.
do $$ declare r record; begin
  perform _t_login('70200000-0000-0000-0000-000000000001');
  select * into r from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365)
   where source = 'recurring';
  if r.expected_date <> current_date + 33 then
    raise exception 'G20 FAIL: a standing invoice issued in 3 days on 30-day terms is expected on % rather than %',
      r.expected_date, current_date + 33;
  end if;
  if r.amount_cents <> 46000 then
    raise exception 'G20 FAIL: the standing invoice is forecast at % rather than 46000 gross (40000 + 6000 VAT)', r.amount_cents;
  end if;
  if r.party <> 'Monthly standby' then
    raise exception 'G20 FAIL: a schedule with no bill-to name labelled itself "%" rather than falling back to its own name', r.party;
  end if;
end $$;

-- ── (e) A cancelled purchase order is not forecast ──────────────────────────
-- No money will move on it. Nor on one already converted to an expense (0475) — that rand
-- is owned by the supplier's invoice now, and counting both would overstate the outflow by
-- exactly the orders that are going best.
do $$ declare n bigint; r record; begin
  perform _t_login('70200000-0000-0000-0000-000000000001');
  select count(*) into n from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365)
   where source_id = '70600000-0000-0000-0000-000000000002';
  if n <> 0 then raise exception 'G20 FAIL: a CANCELLED purchase order was forecast as money going out (% rows)', n; end if;

  select count(*) into n from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365)
   where source_id = '70600000-0000-0000-0000-000000000003';
  if n <> 0 then
    raise exception 'G20 FAIL: an order already invoiced was forecast AGAIN alongside its expense — double count (% rows)', n;
  end if;
  -- Its expense is the one that carries the money, exactly once.
  select * into r from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365)
   where source_id = '70500000-0000-0000-0000-000000000003';
  if r.amount_cents <> 34500 or r.direction <> 'out' then
    raise exception 'G20 FAIL: the invoice for the received order is %/% rather than out/34500', r.direction, r.amount_cents;
  end if;

  -- The open one IS committed money, forecast at its gross total on delivery + terms.
  select * into r from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365)
   where source_id = '70600000-0000-0000-0000-000000000001';
  if r.amount_cents <> 69000 or r.expected_date <> current_date + 32 then
    raise exception 'G20 FAIL: an open order is forecast at % on % rather than 69000 on %',
      r.amount_cents, r.expected_date, current_date + 32;
  end if;
end $$;

-- ── (f) A settled supplier invoice is not forecast ──────────────────────────
do $$ declare n bigint; begin
  perform _t_login('70200000-0000-0000-0000-000000000001');
  select count(*) into n from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365)
   where source_id = '70500000-0000-0000-0000-000000000002';
  if n <> 0 then raise exception 'G20 FAIL: an ALREADY PAID supplier invoice was forecast as money going out (% rows)', n; end if;
end $$;

-- ── (g) Five buckets, always, and the running total is the sum of them ───────
-- An empty bucket that vanishes makes the running balance unreadable, and "nothing goes
-- out next week" is itself an answer. The last running figure is the whole forecast:
--   in  92000 + 70000 + 46000 = 208000
--   out 115000 + 34500 + 69000 = 218500   ->  -10500
do $$ declare n bigint; v_last bigint; v_items bigint; v_buckets bigint; begin
  perform _t_login('70200000-0000-0000-0000-000000000001');
  select count(*) into n from app.partner_cashflow('70100000-0000-0000-0000-000000000001', 365);
  if n <> 5 then raise exception 'G20 FAIL: the forecast returned % buckets rather than 5', n; end if;

  select running_cents into v_last from app.partner_cashflow('70100000-0000-0000-0000-000000000001', 365)
   where ordinal = 5;
  if v_last <> -10500 then
    raise exception 'G20 FAIL: the running total ends at % rather than -10500 (208000 in, 218500 out)', v_last;
  end if;

  -- The buckets decompose the items exactly: a total nobody can take apart is a total
  -- nobody believes, and this is the property that makes the two functions one answer.
  select coalesce(sum(case when direction = 'in' then amount_cents else -amount_cents end), 0)
    into v_items from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365);
  select coalesce(sum(net_cents), 0)
    into v_buckets from app.partner_cashflow('70100000-0000-0000-0000-000000000001', 365);
  if v_items <> v_buckets or v_items <> -10500 then
    raise exception 'G20 FAIL: the items sum to % but the buckets sum to %', v_items, v_buckets;
  end if;

  select count(*) into n from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365);
  if n <> 6 then raise exception 'G20 FAIL: the forecast holds % movements rather than 6', n; end if;
end $$;

-- ── (h) The horizon shortens the future and never hides the past ────────────
-- Asked for a week, the two rows whose CASH DATE is further out drop away: VI-0004 (due in
-- 45 days) and the invoice for the received order (due in 20). The two overdue rows stay,
-- because they are not in the future at all — a window on the next seven days is not a
-- reason to stop showing a debt that is thirty days late.
--
-- The standing invoice and the open order stay too, and that is deliberate rather than a
-- leak: the horizon selects on the date that DEFINES each movement — when a schedule
-- raises its invoice, when an order is due to arrive — and the bucket is then worked out
-- from the cash date that follows it. Selecting on the cash date instead would mean a
-- 30-day window never showed a single standing invoice, because none of them is ever paid
-- inside the term they are raised in.
--   in  92000 + 46000 = 138000 ; out 115000 + 69000 = 184000  ->  -46000
do $$ declare n bigint; r record; begin
  perform _t_login('70200000-0000-0000-0000-000000000001');
  select count(*) into n from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 7);
  if n <> 4 then raise exception 'G20 FAIL: a 7-day horizon holds % movements rather than 4', n; end if;
  select count(*) into n from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 7)
   where source_id in ('70300000-0000-0000-0000-000000000004', '70500000-0000-0000-0000-000000000003');
  if n <> 0 then
    raise exception 'G20 FAIL: a 7-day horizon still held % movements dated 20 and 45 days out', n;
  end if;
  select * into r from app.partner_cashflow('70100000-0000-0000-0000-000000000001', 7) where ordinal = 1;
  if r.net_cents <> -23000 then
    raise exception 'G20 FAIL: shortening the horizon changed the OVERDUE bucket to % — the past is not in the window', r.net_cents;
  end if;
  select * into r from app.partner_cashflow('70100000-0000-0000-0000-000000000001', 7) where ordinal = 5;
  if r.running_cents <> -46000 then
    raise exception 'G20 FAIL: a 7-day forecast ends at % rather than -46000', r.running_cents;
  end if;
end $$;

-- ── (i) A rival workshop on the SAME farm reads zeros ───────────────────────
-- Both functions are SECURITY INVOKER with no workshop check in the body, so passing
-- somebody else's id is answered by RLS on the underlying tables. A second check written
-- here would be a weaker copy of a rule the database already enforces.
do $$ declare n bigint; v bigint; begin
  perform _t_login('70200000-0000-0000-0000-000000000002');       -- the rival's staff
  select count(*) into n from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365);
  if n <> 0 then raise exception 'G20 FAIL [COMPETITOR]: a rival workshop read % of its competitor''s expected movements', n; end if;
  select coalesce(sum(abs(net_cents)), 0) into v from app.partner_cashflow('70100000-0000-0000-0000-000000000001', 365);
  if v <> 0 then raise exception 'G20 FAIL [COMPETITOR]: a rival workshop read a forecast worth %', v; end if;
end $$;

-- ── (j) The farm it works for reads none of its contractor's buying ────────
-- What a workshop pays its suppliers, what it has on order and what it bills on standing
-- arrangements is the margin behind every quote that farm is given, and RLS keeps all
-- three workshop-scoped. What the farm DOES see through these functions is the invoices it
-- was itself sent — its own debt, which it has every right to read and already reads on
-- /documents. That is the correct answer rather than a leak, and it is asserted here so
-- that nobody later "fixes" it by writing a workshop check into the function body: such a
-- check would be a second, weaker copy of the rule RLS already enforces, and the first
-- thing it would do is start disagreeing with the policies.
do $$ declare n bigint; v_out bigint; begin
  perform _t_login('70200000-0000-0000-0000-000000000003');       -- the farm's owner
  select count(*) into n from app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365)
   where source in ('expense', 'purchase_order', 'recurring');
  if n <> 0 then
    raise exception 'G20 FAIL [MARGIN LEAK]: a farm read % of its contractor''s purchases, orders or standing income', n;
  end if;
  select coalesce(sum(out_cents), 0) into v_out
    from app.partner_cashflow('70100000-0000-0000-0000-000000000001', 365);
  if v_out <> 0 then
    raise exception 'G20 FAIL [MARGIN LEAK]: a farm read % of money leaving its contractor''s bank', v_out;
  end if;
end $$;
reset role;

-- ── (k) anon runs none of it ────────────────────────────────────────────────
-- A function created with no explicit grant defaults to EXECUTE TO PUBLIC — the shape that
-- left `public._f14_probe` on production (0440) — so the revoke is asserted, not assumed.
set role anon;
do $$ declare ok boolean := false; begin
  begin perform app.partner_cashflow('70100000-0000-0000-0000-000000000001', 365);
  exception when others then ok := true; end;
  if not ok then raise exception 'G20 FAIL: anon ran app.partner_cashflow'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform app.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365);
  exception when others then ok := true; end;
  if not ok then raise exception 'G20 FAIL: anon ran app.partner_cashflow_items'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform public.partner_cashflow('70100000-0000-0000-0000-000000000001', 365);
  exception when others then ok := true; end;
  if not ok then raise exception 'G20 FAIL: anon ran the public cashflow wrapper'; end if;
end $$;
do $$ declare ok boolean := false; begin
  begin perform public.partner_cashflow_items('70100000-0000-0000-0000-000000000001', 365);
  exception when others then ok := true; end;
  if not ok then raise exception 'G20 FAIL: anon ran the public cashflow-items wrapper'; end if;
end $$;
reset role;

select 'ALL G20 CASHFLOW TESTS PASSED' as result;
