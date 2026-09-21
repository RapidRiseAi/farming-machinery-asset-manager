-- A fuel draw and its driver-usage log are one write, or they are nothing.
--
-- The action used to insert the issue and then the usage log, never reading the second
-- result: the litres and the cost were saved and the driver's utilisation history was not.
-- `record_fuel_issue` (20260920090000) does both in one transaction. These assertions are
-- about that: every refusal must leave NOTHING behind, and the accepted call must leave
-- exactly both rows.
--
-- Section (a) is a reachability check. The TypeScript tests mock the Supabase client, so
-- they assert arguments and never whether the function exists, and PostgREST resolves
-- overloads by PARAMETER NAME, so a renamed argument breaks `supabase.rpc()` as completely
-- as a deletion.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _fuel_atomic_login(p_user uuid)
returns void language sql as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _fuel_atomic_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, settings) values
  ('fa000000-0000-4000-9000-000000000001', 'Fuel atomic farm', 'professional', 'active',
   '{"vat_rate_bps": 1500}'::jsonb),
  ('fa000000-0000-4000-9000-000000000002', 'Fuel other farm', 'professional', 'active', '{}'::jsonb),
  ('fa000000-0000-4000-9000-000000000003', 'Fuel essential farm', 'essential', 'active', '{}'::jsonb);

insert into auth.users (id, email) values
  ('fa100000-0000-4000-9000-000000000001', 'fuel.operator@example.test'),
  ('fa100000-0000-4000-9000-000000000002', 'fuel.essential@example.test'),
  ('fa100000-0000-4000-9000-000000000003', 'fuel.owner@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('fa100000-0000-4000-9000-000000000001', 'fa000000-0000-4000-9000-000000000001',
   'operator', 'Fuel operator', 'fuel.operator@example.test'),
  ('fa100000-0000-4000-9000-000000000002', 'fa000000-0000-4000-9000-000000000003',
   'owner', 'Essential owner', 'fuel.essential@example.test'),
  ('fa100000-0000-4000-9000-000000000003', 'fa000000-0000-4000-9000-000000000001',
   'owner', 'Fuel owner', 'fuel.owner@example.test');

-- The two farm-A machines are ASSIGNED to the operator: an operator sees only the machines
-- assigned to them (`app.row_visible_to_role`, F7), and drawing diesel for your own tractor
-- is the case this command exists for.
insert into public.machines (id, farm_id, name, type, meter_type, status, assigned_operator_id) values
  ('fa200000-0000-4000-9000-000000000001', 'fa000000-0000-4000-9000-000000000001',
   'Fuel tractor', 'tractor', 'hours', 'active', 'fa100000-0000-4000-9000-000000000001'),
  ('fa200000-0000-4000-9000-000000000002', 'fa000000-0000-4000-9000-000000000001',
   'Fuel pump', 'pump_generator', 'none', 'active', 'fa100000-0000-4000-9000-000000000001'),
  ('fa200000-0000-4000-9000-000000000003', 'fa000000-0000-4000-9000-000000000002',
   'Other farm tractor', 'tractor', 'hours', 'active', null),
  ('fa200000-0000-4000-9000-000000000004', 'fa000000-0000-4000-9000-000000000003',
   'Essential tractor', 'tractor', 'hours', 'active', null);

insert into public.fuel_tanks (id, farm_id, name) values
  ('fa300000-0000-4000-9000-000000000001', 'fa000000-0000-4000-9000-000000000001', 'Main tank'),
  ('fa300000-0000-4000-9000-000000000002', 'fa000000-0000-4000-9000-000000000002', 'Other tank'),
  ('fa300000-0000-4000-9000-000000000003', 'fa000000-0000-4000-9000-000000000003', 'Essential tank');

-- == (a) Reachable, invoker-rights, and named the way the app calls it ========
do $$
declare v_args text;
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'record_fuel_issue'
  ) then
    raise exception 'FUEL ATOMIC FAIL: record_fuel_issue does not exist';
  end if;

  select pg_get_function_arguments(p.oid) into v_args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_fuel_issue';
  -- The names, in order, are what `supabase.rpc("record_fuel_issue", {...})` sends.
  if v_args not like 'p_farm %' or v_args not like '%p_tank %' or v_args not like '%p_machine %'
     or v_args not like '%p_date %' or v_args not like '%p_litres %' or v_args not like '%p_meter %'
     or v_args not like '%p_cost_incl_cents %' or v_args not like '%p_activity %'
     or v_args not like '%p_driver_user %' then
    raise exception 'FUEL ATOMIC FAIL: parameter names changed (%)', v_args;
  end if;

  if (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'record_fuel_issue') then
    raise exception 'FUEL ATOMIC FAIL: record_fuel_issue is SECURITY DEFINER; RLS must decide';
  end if;
  if (select p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'record_fuel_issue') is null then
    raise exception 'FUEL ATOMIC FAIL: record_fuel_issue has no pinned search_path';
  end if;

  if has_function_privilege('anon',
       'public.record_fuel_issue(uuid,uuid,uuid,date,numeric,numeric,bigint,text,uuid)', 'EXECUTE') then
    raise exception 'FUEL ATOMIC FAIL: anon gained EXECUTE';
  end if;
  if not has_function_privilege('authenticated',
       'public.record_fuel_issue(uuid,uuid,uuid,date,numeric,numeric,bigint,text,uuid)', 'EXECUTE') then
    raise exception 'FUEL ATOMIC FAIL: authenticated cannot execute it';
  end if;
end $$;

set role authenticated;

create temporary table _fuel_atomic_ids (id uuid);
grant all on table _fuel_atomic_ids to public;

-- == (b) The accepted draw writes BOTH rows ==================================
do $$
declare
  v_id uuid;
  v_issues int;
  v_usage int;
begin
  perform _fuel_atomic_login('fa100000-0000-4000-9000-000000000001');
  v_id := public.record_fuel_issue(
    p_farm => 'fa000000-0000-4000-9000-000000000001',
    p_tank => 'fa300000-0000-4000-9000-000000000001',
    p_machine => 'fa200000-0000-4000-9000-000000000001',
    p_date => current_date,
    p_litres => 100,
    p_meter => 1250,
    p_cost_incl_cents => 11500,
    p_activity => 'ploughing',
    p_driver_user => null
  );

  select count(*) into v_issues from public.fuel_issues where id = v_id;
  if v_issues <> 1 then raise exception 'FUEL ATOMIC FAIL: the draw was not recorded'; end if;

  select count(*) into v_usage from public.usage_logs
   where machine_id = 'fa200000-0000-4000-9000-000000000001'
     and occurred_on = current_date and meter_reading = 1250;
  if v_usage <> 1 then
    raise exception 'FUEL ATOMIC FAIL: the driver-usage log is missing (% rows)', v_usage;
  end if;

  insert into _fuel_atomic_ids(id) values (v_id);
end $$;

-- == (c) A farm-level draw has no machine, so it writes no usage log ==========
-- As the OWNER: `fuel_issues_ins` lets an operator record a draw only for a machine
-- assigned to them, so a draw with no machine is the farm office's to record. The command
-- does not decide that, RLS does, and this is the proof it still applies underneath it.
do $$
declare v_id uuid; v_usage int;
begin
  perform _fuel_atomic_login('fa100000-0000-4000-9000-000000000003');
  v_id := public.record_fuel_issue(
    p_farm => 'fa000000-0000-4000-9000-000000000001',
    p_tank => 'fa300000-0000-4000-9000-000000000001',
    p_machine => null,
    p_date => current_date,
    p_litres => 20,
    p_meter => null,
    p_cost_incl_cents => null,
    p_activity => null,
    p_driver_user => null
  );
  if v_id is null then raise exception 'FUEL ATOMIC FAIL: farm-level draw refused'; end if;
  select count(*) into v_usage from public.usage_logs where machine_id is null;
  if v_usage <> 0 then
    raise exception 'FUEL ATOMIC FAIL: a farm-level draw invented a usage log';
  end if;
end $$;

-- == (d) Every refusal leaves NOTHING behind ==================================
do $$
declare
  v_before int;
  v_after int;
  v_refused int := 0;
  v_case text;
begin
  -- Both counts are taken as the OWNER. A SELECT is RLS-filtered like any other, and an
  -- operator cannot see a farm-level draw, so counting under two identities would compare
  -- two different questions.
  perform _fuel_atomic_login('fa100000-0000-4000-9000-000000000003');
  select count(*) into v_before from public.fuel_issues;

  -- Another farm's tank and machine, as an operator with no access to it.
  begin
    perform _fuel_atomic_login('fa100000-0000-4000-9000-000000000001');
    perform public.record_fuel_issue(
      p_farm => 'fa000000-0000-4000-9000-000000000002',
      p_tank => 'fa300000-0000-4000-9000-000000000002',
      p_machine => 'fa200000-0000-4000-9000-000000000003',
      p_date => current_date, p_litres => 50, p_meter => 10,
      p_cost_incl_cents => null, p_activity => null, p_driver_user => null);
    v_case := 'another farm''s fuel was recorded';
  exception when others then v_refused := v_refused + 1;
  end;

  -- A plan that does not include fuel.
  begin
    perform _fuel_atomic_login('fa100000-0000-4000-9000-000000000002');
    perform public.record_fuel_issue(
      p_farm => 'fa000000-0000-4000-9000-000000000003',
      p_tank => 'fa300000-0000-4000-9000-000000000003',
      p_machine => 'fa200000-0000-4000-9000-000000000004',
      p_date => current_date, p_litres => 50, p_meter => 10,
      p_cost_incl_cents => null, p_activity => null, p_driver_user => null);
    v_case := coalesce(v_case, 'an essential-plan farm recorded fuel');
  exception when others then v_refused := v_refused + 1;
  end;

  perform _fuel_atomic_login('fa100000-0000-4000-9000-000000000001');

  -- A meter reading on a machine that keeps none.
  begin
    perform public.record_fuel_issue(
      p_farm => 'fa000000-0000-4000-9000-000000000001',
      p_tank => 'fa300000-0000-4000-9000-000000000001',
      p_machine => 'fa200000-0000-4000-9000-000000000002',
      p_date => current_date, p_litres => 50, p_meter => 10,
      p_cost_incl_cents => null, p_activity => null, p_driver_user => null);
    v_case := coalesce(v_case, 'a meterless machine took a meter reading');
  exception when others then v_refused := v_refused + 1;
  end;

  -- A draw dated in the future.
  begin
    perform public.record_fuel_issue(
      p_farm => 'fa000000-0000-4000-9000-000000000001',
      p_tank => 'fa300000-0000-4000-9000-000000000001',
      p_machine => 'fa200000-0000-4000-9000-000000000001',
      p_date => current_date + 1, p_litres => 50, p_meter => 1300,
      p_cost_incl_cents => null, p_activity => null, p_driver_user => null);
    v_case := coalesce(v_case, 'a draw was dated in the future');
  exception when others then v_refused := v_refused + 1;
  end;

  -- Nonsense litres.
  begin
    perform public.record_fuel_issue(
      p_farm => 'fa000000-0000-4000-9000-000000000001',
      p_tank => 'fa300000-0000-4000-9000-000000000001',
      p_machine => 'fa200000-0000-4000-9000-000000000001',
      p_date => current_date, p_litres => 0, p_meter => null,
      p_cost_incl_cents => null, p_activity => null, p_driver_user => null);
    v_case := coalesce(v_case, 'zero litres was accepted');
  exception when others then v_refused := v_refused + 1;
  end;

  -- An activity that is not one of ours.
  begin
    perform public.record_fuel_issue(
      p_farm => 'fa000000-0000-4000-9000-000000000001',
      p_tank => 'fa300000-0000-4000-9000-000000000001',
      p_machine => 'fa200000-0000-4000-9000-000000000001',
      p_date => current_date, p_litres => 10, p_meter => null,
      p_cost_incl_cents => null, p_activity => 'smuggling', p_driver_user => null);
    v_case := coalesce(v_case, 'an unknown activity was accepted');
  exception when others then v_refused := v_refused + 1;
  end;

  if v_case is not null then
    raise exception 'FUEL ATOMIC FAIL: %', v_case;
  end if;
  if v_refused <> 6 then
    raise exception 'FUEL ATOMIC FAIL: expected 6 refusals, counted %', v_refused;
  end if;

  perform _fuel_atomic_login('fa100000-0000-4000-9000-000000000003');
  select count(*) into v_after from public.fuel_issues;
  if v_after <> v_before then
    raise exception 'FUEL ATOMIC FAIL: a refused draw still wrote % row(s)', v_after - v_before;
  end if;
end $$;

reset role;

-- == (e) The money, read by somebody allowed to see it =======================
-- The operator who recorded the draw may NOT read `cost_cents`, those columns are
-- revoked at column level for cost-masked roles (20260908112728), which is why this
-- assertion runs after `reset role` rather than inside the capture block above.
do $$
declare v_cost bigint; v_price bigint; v_rate int;
begin
  select cost_cents, price_per_l_cents, vat_rate_bps into v_cost, v_price, v_rate
    from public.fuel_issues
   where id = (select id from _fuel_atomic_ids limit 1);
  -- R115,00 inclusive at 15% is R100,00 ex-VAT, the same arithmetic as `exVatCents`
  -- and as the QR path, and the rate is captured alongside it.
  if v_cost <> 10000 then raise exception 'FUEL ATOMIC FAIL: ex-VAT cost is % not 10000', v_cost; end if;
  if v_price <> 100 then raise exception 'FUEL ATOMIC FAIL: price per litre is % not 100', v_price; end if;
  if v_rate <> 1500 then raise exception 'FUEL ATOMIC FAIL: VAT rate not captured (%)', v_rate; end if;
end $$;

rollback;
