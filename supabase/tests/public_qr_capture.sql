\set ON_ERROR_STOP on

-- Focused regression coverage for the server-only public QR RPCs. Everything lives in
-- one rolled-back transaction so this file can run after the larger isolation suites
-- without changing their fixtures or leaving ours behind.
begin;
reset role;

insert into farms (id, name, plan, status, settings) values
  ('9c000000-0000-0000-0000-000000000001', 'QR professional', 'professional', 'active', '{"vat_rate_bps":1500}'),
  ('9c000000-0000-0000-0000-000000000002', 'QR rollback',     'professional', 'active', '{"vat_rate_bps":1500}'),
  ('9c000000-0000-0000-0000-000000000003', 'QR essential',    'essential',    'active', '{"vat_rate_bps":1500}'),
  ('9c000000-0000-0000-0000-000000000004', 'QR suspended',    'professional','suspended', '{}'),
  ('9c000000-0000-0000-0000-000000000005', 'QR pending billing', 'professional', 'active', '{}'),
  ('9c000000-0000-0000-0000-000000000006', 'QR closed billing',  'professional', 'active', '{}');

insert into public.billing_subscriptions(farm_id,plan,status,ended_on) values
  ('9c000000-0000-0000-0000-000000000005','professional','pending',null),
  ('9c000000-0000-0000-0000-000000000006','professional','cancelled',
    current_date - coalesce((select lapsed_grace_days from public.billing_settings where singleton),30) - 1);

insert into machines (
  id, farm_id, name, type, meter_type, status, public_token,
  current_reading, current_reading_date
) values
  ('9c300000-0000-0000-0000-000000000001', '9c000000-0000-0000-0000-000000000001',
   'QR Tractor', 'tractor', 'hours', 'active', '9c900000-0000-0000-0000-000000000001', 100, current_date),
  ('9c300000-0000-0000-0000-000000000002', '9c000000-0000-0000-0000-000000000002',
   'QR Rollback Tractor', 'tractor', 'hours', 'active', '9c900000-0000-0000-0000-000000000002', 50, current_date),
  ('9c300000-0000-0000-0000-000000000003', '9c000000-0000-0000-0000-000000000003',
   'QR Essential Tractor', 'tractor', 'hours', 'active', '9c900000-0000-0000-0000-000000000003', 25, current_date),
  ('9c300000-0000-0000-0000-000000000004', '9c000000-0000-0000-0000-000000000004',
   'QR Suspended Tractor', 'tractor', 'hours', 'active', '9c900000-0000-0000-0000-000000000004', 25, current_date),
  ('9c300000-0000-0000-0000-000000000005', '9c000000-0000-0000-0000-000000000005',
   'QR Pending Billing Tractor', 'tractor', 'hours', 'active', '9c900000-0000-0000-0000-000000000005', 25, current_date),
  ('9c300000-0000-0000-0000-000000000006', '9c000000-0000-0000-0000-000000000006',
   'QR Closed Billing Tractor', 'tractor', 'hours', 'active', '9c900000-0000-0000-0000-000000000006', 25, current_date);

-- These are trusted-server primitives, not anonymous RPC endpoints. They borrow no
-- privileges and service_role is the only application role allowed to execute them.
do $$
declare r record;
begin
  if has_function_privilege('anon', 'public.record_public_qr_reading(uuid,numeric,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.record_public_qr_reading(uuid,numeric,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.record_public_qr_fuel(uuid,numeric,numeric,text,text,bigint)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.record_public_qr_fuel(uuid,numeric,numeric,text,text,bigint)', 'EXECUTE')
     or has_function_privilege('anon', 'public.record_public_qr_fault(uuid,text,fault_urgency,text,text,numeric,numeric)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.record_public_qr_fault(uuid,text,fault_urgency,text,text,numeric,numeric)', 'EXECUTE') then
    raise exception 'PUBLIC QR RPC FAIL: anon/authenticated gained EXECUTE';
  end if;
  if not has_function_privilege('service_role', 'public.record_public_qr_reading(uuid,numeric,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.record_public_qr_fuel(uuid,numeric,numeric,text,text,bigint)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.record_public_qr_fault(uuid,text,fault_urgency,text,text,numeric,numeric)', 'EXECUTE') then
    raise exception 'PUBLIC QR RPC FAIL: service_role cannot execute the capture RPCs';
  end if;

  for r in
    select p.proname, p.prosecdef, p.proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('record_public_qr_reading', 'record_public_qr_fuel', 'record_public_qr_fault')
  loop
    if r.prosecdef then
      raise exception 'PUBLIC QR RPC FAIL: % is SECURITY DEFINER', r.proname;
    end if;
    if r.proconfig is null
       or not exists (select 1 from unnest(r.proconfig) c where c like 'search_path=%') then
      raise exception 'PUBLIC QR RPC FAIL: % has no pinned search_path', r.proname;
    end if;
  end loop;
end $$;

set role service_role;

-- A reading is one atomic capture: history, current machine state and usage attribution.
do $$
declare v_result jsonb; v_id uuid; v_current numeric; v_count integer;
begin
  v_result := public.record_public_qr_reading(
    '9c900000-0000-0000-0000-000000000001', 125.5, 'Field tester'
  );
  if v_result ->> 'ok' is distinct from 'true' then
    raise exception 'PUBLIC QR READING FAIL: success returned %', v_result;
  end if;
  v_id := (v_result ->> 'reading_id')::uuid;

  select count(*) into v_count from meter_readings
   where id = v_id and machine_id = '9c300000-0000-0000-0000-000000000001'
     and reading = 125.5 and source = 'qr';
  if v_count <> 1 then raise exception 'PUBLIC QR READING FAIL: history row missing'; end if;

  select current_reading into v_current from machines
   where id = '9c300000-0000-0000-0000-000000000001';
  if v_current is distinct from 125.5 then
    raise exception 'PUBLIC QR READING FAIL: machine stayed at %', v_current;
  end if;

  select count(*) into v_count from usage_logs
   where machine_id = '9c300000-0000-0000-0000-000000000001'
     and driver_name = 'Field tester' and meter_reading = 125.5 and source = 'qr';
  if v_count <> 1 then raise exception 'PUBLIC QR READING FAIL: usage row missing'; end if;
end $$;

-- A same-day reading may not quietly move the asset backwards, and rejection writes
-- nothing. The caller gets a stable, translatable code rather than a raw SQL sentence.
do $$
declare v_result jsonb; v_readings integer; v_usage integer; v_current numeric;
begin
  select count(*) into v_readings from meter_readings
   where machine_id = '9c300000-0000-0000-0000-000000000001';
  select count(*) into v_usage from usage_logs
   where machine_id = '9c300000-0000-0000-0000-000000000001';

  v_result := public.record_public_qr_reading(
    '9c900000-0000-0000-0000-000000000001', 120, 'Field tester'
  );
  if v_result ->> 'error' is distinct from 'reading_backwards' then
    raise exception 'PUBLIC QR READING FAIL: backwards reading returned %', v_result;
  end if;
  if (select count(*) from meter_readings where machine_id = '9c300000-0000-0000-0000-000000000001') <> v_readings
     or (select count(*) from usage_logs where machine_id = '9c300000-0000-0000-0000-000000000001') <> v_usage then
    raise exception 'PUBLIC QR READING FAIL: rejected reading wrote rows';
  end if;
  select current_reading into v_current from machines
   where id = '9c300000-0000-0000-0000-000000000001';
  if v_current is distinct from 125.5 then raise exception 'PUBLIC QR READING FAIL: rejection changed machine'; end if;
end $$;

-- A fuel capture creates/resolves the tank, stores ex-VAT cost and writes usage as one
-- unit. R115.00 inclusive at 15% is R100.00 ex VAT.
do $$
declare v_result jsonb; v_issue uuid; r record; v_count integer;
begin
  v_result := public.record_public_qr_fuel(
    '9c900000-0000-0000-0000-000000000001', 5, 130,
    'Fuel tester', 'ploughing', 11500
  );
  if v_result ->> 'ok' is distinct from 'true' then
    raise exception 'PUBLIC QR FUEL FAIL: success returned %', v_result;
  end if;
  v_issue := (v_result ->> 'fuel_issue_id')::uuid;

  select litres, meter_reading, cost_cents, price_per_l_cents, vat_rate_bps,
         activity, driver_name into r
    from fuel_issues where id = v_issue;
  if not found then
    raise exception 'PUBLIC QR FUEL FAIL: issue row missing';
  end if;
  if r.litres is distinct from 5 or r.meter_reading is distinct from 130
     or r.cost_cents is distinct from 10000 or r.price_per_l_cents is distinct from 2000
     or r.vat_rate_bps is distinct from 1500 or r.activity is distinct from 'ploughing'
     or r.driver_name is distinct from 'Fuel tester' then
    raise exception 'PUBLIC QR FUEL FAIL: stored issue is %', row_to_json(r);
  end if;
  select count(*) into v_count from fuel_tanks
   where farm_id = '9c000000-0000-0000-0000-000000000001' and deleted_at is null;
  if v_count <> 1 then raise exception 'PUBLIC QR FUEL FAIL: expected one default tank, got %', v_count; end if;
  select count(*) into v_count from usage_logs
   where machine_id = '9c300000-0000-0000-0000-000000000001'
     and driver_name = 'Fuel tester' and meter_reading = 130 and source = 'qr';
  if v_count <> 1 then raise exception 'PUBLIC QR FUEL FAIL: usage row missing'; end if;
end $$;

-- Entitlement and token failures are explicit and leave no partial tank or issue.
do $$
declare v_result jsonb; v_count integer;
begin
  v_result := public.record_public_qr_fuel(
    '9c900000-0000-0000-0000-000000000003', 10, 30, null, null, null
  );
  if v_result ->> 'error' is distinct from 'upgrade' then
    raise exception 'PUBLIC QR FUEL FAIL: Essential plan returned %', v_result;
  end if;
  select count(*) into v_count from fuel_tanks
   where farm_id = '9c000000-0000-0000-0000-000000000003';
  if v_count <> 0 then raise exception 'PUBLIC QR FUEL FAIL: upgrade rejection created a tank'; end if;

  v_result := public.record_public_qr_fuel(
    '9c999999-0000-0000-0000-000000000099', 10, null, null, null, null
  );
  if v_result ->> 'error' is distinct from 'not_found' then
    raise exception 'PUBLIC QR FUEL FAIL: unknown token returned %', v_result;
  end if;
end $$;

-- Public fault capture carries bounded descriptions and optional paired coordinates.
-- Missing coordinates remain NULL; a partial or invalid coordinate is rejected.
do $$
declare v_result jsonb; v_fault uuid; r record; v_count integer;
begin
  v_result := public.record_public_qr_fault(
    '9c900000-0000-0000-0000-000000000001', '  Leaking hydraulic hose  ',
    'limping', 'Hydraulics', 'Field tester', null, null
  );
  if v_result ->> 'ok' is distinct from 'true'
     or v_result ->> 'farm_id' <> '9c000000-0000-0000-0000-000000000001' then
    raise exception 'PUBLIC QR FAULT FAIL: capture returned %', v_result;
  end if;
  v_fault := (v_result ->> 'fault_id')::uuid;
  select description, lat, lng, status, reported_by into r from faults where id = v_fault;
  if r.description <> 'Leaking hydraulic hose' or r.lat is not null or r.lng is not null
     or r.status <> 'open' or r.reported_by is not null then
    raise exception 'PUBLIC QR FAULT FAIL: wrong fault fields %', row_to_json(r);
  end if;
  select count(*) into v_count from faults where farm_id = '9c000000-0000-0000-0000-000000000001';
  v_result := public.record_public_qr_fault(
    '9c900000-0000-0000-0000-000000000001', 'Invalid coordinate',
    'limping', null, null, -33, null
  );
  if v_result ->> 'error' is distinct from 'invalid_fault' then
    raise exception 'PUBLIC QR FAULT FAIL: partial coordinate returned %', v_result;
  end if;
  v_result := public.record_public_qr_fault(
    '9c900000-0000-0000-0000-000000000001', repeat('x', 2001),
    'limping', null, null, null, null
  );
  if v_result ->> 'error' is distinct from 'invalid_fault'
     or (select count(*) from faults where farm_id = '9c000000-0000-0000-0000-000000000001') <> v_count then
    raise exception 'PUBLIC QR FAULT FAIL: invalid payload wrote a fault';
  end if;
end $$;

-- Farm suspension closes every public capture path even while its token still exists.
do $$
declare v_result jsonb;
begin
  v_result := public.record_public_qr_reading('9c900000-0000-0000-0000-000000000004', 30, null);
  if v_result ->> 'error' is distinct from 'not_found' then
    raise exception 'PUBLIC QR STATUS FAIL: suspended reading returned %', v_result;
  end if;
  v_result := public.record_public_qr_fuel('9c900000-0000-0000-0000-000000000004', 5, null, null, null, null);
  if v_result ->> 'error' is distinct from 'not_found' then
    raise exception 'PUBLIC QR STATUS FAIL: suspended fuel returned %', v_result;
  end if;
  v_result := public.record_public_qr_fault(
    '9c900000-0000-0000-0000-000000000004', 'Suspended fault', 'limping', null, null, null, null
  );
  if v_result ->> 'error' is distinct from 'not_found'
     or exists (select 1 from faults where farm_id = '9c000000-0000-0000-0000-000000000004')
     or exists (select 1 from meter_readings where farm_id = '9c000000-0000-0000-0000-000000000004')
     or exists (select 1 from fuel_tanks where farm_id = '9c000000-0000-0000-0000-000000000004') then
    raise exception 'PUBLIC QR STATUS FAIL: suspended capture wrote rows';
  end if;
end $$;

-- Billing closes otherwise active farms across every RPC. Successful fixtures above
-- have no subscription and continue to exercise grandfathered access.
do $$
declare fixture record; v_result jsonb; v_machine_before jsonb;
begin
  for fixture in
    select m.id as machine_id,m.farm_id,m.public_token,
      case when s.status = 'pending' then 'pending' else 'closed' end as expected_gate
    from public.machines m
    join public.billing_subscriptions s on s.farm_id=m.farm_id
    where m.farm_id in ('9c000000-0000-0000-0000-000000000005','9c000000-0000-0000-0000-000000000006')
  loop
    if app.farm_billing_gate(fixture.farm_id) is distinct from fixture.expected_gate then
      raise exception 'PUBLIC QR BILLING FAIL: fixture should be %',fixture.expected_gate;
    end if;
    select to_jsonb(m) into v_machine_before from public.machines m where m.id=fixture.machine_id;
    v_result := public.record_public_qr_reading(fixture.public_token,30,null);
    if v_result ->> 'error' is distinct from 'not_found' then
      raise exception 'PUBLIC QR BILLING FAIL: % reading returned %',fixture.expected_gate,v_result;
    end if;
    v_result := public.record_public_qr_fuel(fixture.public_token,5,30,'Billing tester',null,11500);
    if v_result ->> 'error' is distinct from 'not_found' then
      raise exception 'PUBLIC QR BILLING FAIL: % fuel returned %',fixture.expected_gate,v_result;
    end if;
    v_result := public.record_public_qr_fault(
      fixture.public_token,'Billing blocked fault','stopped',null,null,null,null
    );
    if v_result ->> 'error' is distinct from 'not_found' then
      raise exception 'PUBLIC QR BILLING FAIL: % fault returned %',fixture.expected_gate,v_result;
    end if;
    if exists(select 1 from public.meter_readings where farm_id=fixture.farm_id)
      or exists(select 1 from public.usage_logs where farm_id=fixture.farm_id)
      or exists(select 1 from public.fuel_tanks where farm_id=fixture.farm_id)
      or exists(select 1 from public.fuel_issues where farm_id=fixture.farm_id)
      or exists(select 1 from public.faults where farm_id=fixture.farm_id)
      or exists(select 1 from public.cost_entries where farm_id=fixture.farm_id)
      or (select to_jsonb(m) from public.machines m where m.id=fixture.machine_id) is distinct from v_machine_before then
      raise exception 'PUBLIC QR BILLING FAIL: % rejection changed data',fixture.expected_gate;
    end if;
  end loop;
end $$;

-- The row lock serializes the count-and-insert boundary; the first excess call is
-- refused without writing history, costs or usage. Each path has its own limit.
do $$
declare v_result jsonb; v_count integer;
begin
  for i in 1..29 loop
    v_result := public.record_public_qr_reading('9c900000-0000-0000-0000-000000000001', 130, null);
    if v_result ->> 'ok' is distinct from 'true' then
      raise exception 'PUBLIC QR RATE FAIL: reading % rejected before limit: %', i, v_result;
    end if;
  end loop;
  v_result := public.record_public_qr_reading('9c900000-0000-0000-0000-000000000001', 130, null);
  if v_result ->> 'error' is distinct from 'rate_limited' then
    raise exception 'PUBLIC QR RATE FAIL: excess reading returned %', v_result;
  end if;
  for i in 1..19 loop
    v_result := public.record_public_qr_fuel('9c900000-0000-0000-0000-000000000001', 1, null, null, null, null);
    if v_result ->> 'ok' is distinct from 'true' then
      raise exception 'PUBLIC QR RATE FAIL: fuel % rejected before limit: %', i, v_result;
    end if;
  end loop;
  v_result := public.record_public_qr_fuel('9c900000-0000-0000-0000-000000000001', 1, null, null, null, null);
  if v_result ->> 'error' is distinct from 'rate_limited' then
    raise exception 'PUBLIC QR RATE FAIL: excess fuel returned %', v_result;
  end if;
  for i in 1..9 loop
    v_result := public.record_public_qr_fault(
      '9c900000-0000-0000-0000-000000000001', 'Limit fixture', 'can_work', null, null, null, null
    );
    if v_result ->> 'ok' is distinct from 'true' then
      raise exception 'PUBLIC QR RATE FAIL: fault % rejected before limit: %', i, v_result;
    end if;
  end loop;
  select count(*) into v_count from usage_logs where machine_id = '9c300000-0000-0000-0000-000000000001';
  v_result := public.record_public_qr_fault(
    '9c900000-0000-0000-0000-000000000001', 'Excess fixture', 'can_work', null, null, null, null
  );
  if v_result ->> 'error' is distinct from 'rate_limited'
     or (select count(*) from faults where machine_id = '9c300000-0000-0000-0000-000000000001') <> 10
     or (select count(*) from meter_readings where machine_id = '9c300000-0000-0000-0000-000000000001' and source = 'qr') <> 30
     or (select count(*) from fuel_issues where machine_id = '9c300000-0000-0000-0000-000000000001') <> 20
     or (select count(*) from usage_logs where machine_id = '9c300000-0000-0000-0000-000000000001') <> v_count then
    raise exception 'PUBLIC QR RATE FAIL: excess capture was not rejected cleanly';
  end if;
end $$;

reset role;

-- Force the LAST write in each RPC to fail. If transaction boundaries regress, the
-- earlier reading/machine or tank/issue writes will remain and these assertions fail.
alter table usage_logs add constraint _t_public_qr_usage_failure
  check (driver_name is distinct from '__force_qr_failure__') not valid;

set role service_role;

do $$
declare v_failed boolean := false; v_readings integer; v_usage integer; v_current numeric;
begin
  select count(*) into v_readings from meter_readings
   where machine_id = '9c300000-0000-0000-0000-000000000002';
  select count(*) into v_usage from usage_logs
   where machine_id = '9c300000-0000-0000-0000-000000000002';
  begin
    perform public.record_public_qr_reading(
      '9c900000-0000-0000-0000-000000000002', 60, '__force_qr_failure__'
    );
  exception when check_violation then
    v_failed := true;
  end;
  if not v_failed then raise exception 'PUBLIC QR ATOMICITY FAIL: forced reading failure did not fail'; end if;
  if (select count(*) from meter_readings where machine_id = '9c300000-0000-0000-0000-000000000002') <> v_readings
     or (select count(*) from usage_logs where machine_id = '9c300000-0000-0000-0000-000000000002') <> v_usage then
    raise exception 'PUBLIC QR ATOMICITY FAIL: partial reading rows survived';
  end if;
  select current_reading into v_current from machines
   where id = '9c300000-0000-0000-0000-000000000002';
  if v_current is distinct from 50 then raise exception 'PUBLIC QR ATOMICITY FAIL: partial machine update survived'; end if;
end $$;

do $$
declare v_failed boolean := false; v_count integer;
begin
  begin
    perform public.record_public_qr_fuel(
      '9c900000-0000-0000-0000-000000000002', 10, 55,
      '__force_qr_failure__', 'harvesting', 23000
    );
  exception when check_violation then
    v_failed := true;
  end;
  if not v_failed then raise exception 'PUBLIC QR ATOMICITY FAIL: forced fuel failure did not fail'; end if;

  select count(*) into v_count from fuel_tanks
   where farm_id = '9c000000-0000-0000-0000-000000000002';
  if v_count <> 0 then raise exception 'PUBLIC QR ATOMICITY FAIL: partial tank survived'; end if;
  select count(*) into v_count from fuel_issues
   where farm_id = '9c000000-0000-0000-0000-000000000002';
  if v_count <> 0 then raise exception 'PUBLIC QR ATOMICITY FAIL: partial fuel issue survived'; end if;
  select count(*) into v_count from usage_logs
   where farm_id = '9c000000-0000-0000-0000-000000000002';
  if v_count <> 0 then raise exception 'PUBLIC QR ATOMICITY FAIL: partial fuel usage survived'; end if;
  select count(*) into v_count from cost_entries
   where farm_id = '9c000000-0000-0000-0000-000000000002'
     and source_type = 'fuel_issue';
  if v_count <> 0 then raise exception 'PUBLIC QR ATOMICITY FAIL: partial fuel cost survived'; end if;
end $$;

reset role;
rollback;

select 'PUBLIC QR ATOMIC CAPTURE TESTS PASSED' as result;
