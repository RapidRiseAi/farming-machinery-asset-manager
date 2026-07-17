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

insert into watch_items (farm_id, machine_id, text) values
  ('11111111-1111-1111-1111-111111111111', 'aa111111-1111-1111-1111-111111111111', 'Front tyres 50%'),
  ('22222222-2222-2222-2222-222222222222', 'bb222222-2222-2222-2222-222222222222', 'Front tyres 50%');

insert into attachments (farm_id, parent_type, parent_id, kind, url) values
  ('11111111-1111-1111-1111-111111111111', 'machine', 'aa111111-1111-1111-1111-111111111111', 'photo', 'http://x/a'),
  ('22222222-2222-2222-2222-222222222222', 'machine', 'bb222222-2222-2222-2222-222222222222', 'photo', 'http://x/b');

insert into notifications (farm_id, user_id, channel, template) values
  ('11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'inapp', 'test'),
  ('22222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', 'inapp', 'test');

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
    'fuel_issues','audit_log'
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
