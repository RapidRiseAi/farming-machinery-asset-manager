-- A forged job-card request must not connect faults or service tasks across machines or
-- farms, and crew roles must not manufacture an already-approved card.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _jobcard_binding_login(p_user uuid)
returns void language sql as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _jobcard_binding_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('9e000000-0000-4000-9000-000000000001', 'Job binding farm A', 'professional', 'active'),
  ('9e000000-0000-4000-9000-000000000002', 'Job binding farm B', 'professional', 'active');

insert into auth.users (id, email) values
  ('9e100000-0000-4000-9000-000000000001', 'job.mechanic@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('9e100000-0000-4000-9000-000000000001',
   '9e000000-0000-4000-9000-000000000001',
   'mechanic', 'Job binding mechanic', 'job.mechanic@example.test');

insert into public.machines (id, farm_id, name, type, meter_type, status) values
  ('9e200000-0000-4000-9000-000000000001', '9e000000-0000-4000-9000-000000000001',
   'Farm A tractor', 'tractor', 'hours', 'active'),
  ('9e200000-0000-4000-9000-000000000002', '9e000000-0000-4000-9000-000000000002',
   'Farm B tractor', 'tractor', 'hours', 'active');

insert into public.faults
  (id, farm_id, machine_id, description, urgency, status)
values
  ('9e300000-0000-4000-9000-000000000001', '9e000000-0000-4000-9000-000000000001',
   '9e200000-0000-4000-9000-000000000001', 'Farm A fault', 'limping', 'open'),
  ('9e300000-0000-4000-9000-000000000002', '9e000000-0000-4000-9000-000000000002',
   '9e200000-0000-4000-9000-000000000002', 'Farm B fault', 'limping', 'open');

insert into public.service_plan_lines
  (id, farm_id, machine_id, task, interval_hours)
values
  ('9e400000-0000-4000-9000-000000000001', '9e000000-0000-4000-9000-000000000001',
   '9e200000-0000-4000-9000-000000000001', 'Farm A oil', 250),
  ('9e400000-0000-4000-9000-000000000002', '9e000000-0000-4000-9000-000000000002',
   '9e200000-0000-4000-9000-000000000002', 'Farm B oil', 250);

insert into public.job_cards
  (id, farm_id, machine_id, type, status, date_in)
values
  ('9e500000-0000-4000-9000-000000000001', '9e000000-0000-4000-9000-000000000001',
   '9e200000-0000-4000-9000-000000000001', 'scheduled_service', 'open', current_date);

set role authenticated;

do $$
declare
  v_denied boolean := false;
  v_status fault_status;
  v_link uuid;
  v_id uuid;
begin
  perform _jobcard_binding_login('9e100000-0000-4000-9000-000000000001');

  -- These commands all lock the machine row. The mechanic may use the operational
  -- command, but the companion WITH CHECK=false policy must still block direct edits.
  v_id := public.record_meter_reading(
    '9e000000-0000-4000-9000-000000000001',
    '9e200000-0000-4000-9000-000000000001', 10, current_date,
    '9e100000-0000-4000-9000-000000000001'
  );
  if v_id is null then
    raise exception 'JOB BINDING FAIL: mechanic meter command returned no row';
  end if;

  v_id := public.record_fault(
    '9e000000-0000-4000-9000-000000000001',
    '9e200000-0000-4000-9000-000000000001',
    'Operational lock test', 'can_work', null
  );
  if v_id is null then
    raise exception 'JOB BINDING FAIL: mechanic fault command returned no row';
  end if;

  v_id := public.record_completed_service(
    '9e000000-0000-4000-9000-000000000001',
    '9e200000-0000-4000-9000-000000000001', 11, current_date,
    'Operational lock test service'
  );
  if v_id is null then
    raise exception 'JOB BINDING FAIL: mechanic service command returned no row';
  end if;

  v_denied := false;
  begin
    update public.machines
       set name = 'mechanic forged an admin edit'
     where id = '9e200000-0000-4000-9000-000000000001';
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'JOB BINDING FAIL: operational lock policy allowed a machine edit';
  end if;

  v_denied := false;
  begin
    insert into public.job_cards
      (id, farm_id, machine_id, created_from_fault_id, type, status, date_in)
    values
      ('9e500000-0000-4000-9000-000000000002',
       '9e000000-0000-4000-9000-000000000001',
       '9e200000-0000-4000-9000-000000000001',
       '9e300000-0000-4000-9000-000000000002', 'repair', 'open', current_date);
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'JOB BINDING FAIL: cross-farm source fault was accepted';
  end if;

  v_denied := false;
  begin
    insert into public.job_card_service_lines
      (job_card_id, service_plan_line_id, farm_id, machine_id)
    values
      ('9e500000-0000-4000-9000-000000000001',
       '9e400000-0000-4000-9000-000000000002',
       '9e000000-0000-4000-9000-000000000001',
       '9e200000-0000-4000-9000-000000000001');
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'JOB BINDING FAIL: cross-farm service task was accepted';
  end if;

  v_denied := false;
  begin
    insert into public.job_cards
      (id, farm_id, machine_id, type, status, locked, approved_by, approved_at, date_in)
    values
      ('9e500000-0000-4000-9000-000000000003',
       '9e000000-0000-4000-9000-000000000001',
       '9e200000-0000-4000-9000-000000000001', 'repair', 'approved', true,
       '9e100000-0000-4000-9000-000000000001', now(), current_date);
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'JOB BINDING FAIL: mechanic inserted an approved card';
  end if;

  insert into public.job_cards
    (id, farm_id, machine_id, created_from_fault_id, type, status, date_in)
  values
    ('9e500000-0000-4000-9000-000000000004',
     '9e000000-0000-4000-9000-000000000001',
     '9e200000-0000-4000-9000-000000000001',
     '9e300000-0000-4000-9000-000000000001', 'repair', 'open', current_date);

  select status, job_card_id into v_status, v_link
    from public.faults
   where id = '9e300000-0000-4000-9000-000000000001';
  if v_status <> 'in_job' or v_link <> '9e500000-0000-4000-9000-000000000004' then
    raise exception 'JOB BINDING FAIL: valid source fault was not linked atomically';
  end if;

  -- The UPDATE predicate is rechecked under the row lock. A second request may not
  -- steal the fault link after its first job card has already been created.
  v_denied := false;
  begin
    insert into public.job_cards
      (id, farm_id, machine_id, created_from_fault_id, type, status, date_in)
    values
      ('9e500000-0000-4000-9000-000000000005',
       '9e000000-0000-4000-9000-000000000001',
       '9e200000-0000-4000-9000-000000000001',
       '9e300000-0000-4000-9000-000000000001', 'repair', 'open', current_date);
  exception when foreign_key_violation then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'JOB BINDING FAIL: second job card stole the existing source fault';
  end if;
  select job_card_id into v_link from public.faults
   where id = '9e300000-0000-4000-9000-000000000001';
  if v_link <> '9e500000-0000-4000-9000-000000000004'
     or exists (select 1 from public.job_cards where id = '9e500000-0000-4000-9000-000000000005') then
    raise exception 'JOB BINDING FAIL: failed second link left partial changes';
  end if;

  insert into public.job_card_service_lines
    (job_card_id, service_plan_line_id, farm_id, machine_id)
  values
    ('9e500000-0000-4000-9000-000000000001',
     '9e400000-0000-4000-9000-000000000001',
     '9e000000-0000-4000-9000-000000000001',
     '9e200000-0000-4000-9000-000000000001');
end;
$$;

reset role;
select 'ALL JOB-CARD TENANT BINDING TESTS PASSED' as result;
rollback;
