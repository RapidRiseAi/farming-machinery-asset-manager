-- The plan audit of 4 November 2026 (20261104220000): the book-value register is
-- Professional, and hardware and provider feeds are Done-For-You, in the database as well
-- as on the screen.
\set ON_ERROR_STOP on
set client_min_messages to warning;
begin;
select set_config('request.jwt.claims','',false);

insert into public.farms(id,name,plan,status) values
 ('fc000000-0000-4000-9000-000000000001','Essential Farm','essential','active'),
 ('fc000000-0000-4000-9000-000000000002','Professional Farm','professional','active'),
 ('fc000000-0000-4000-9000-000000000003','DFY Farm','done_for_you','active');
insert into auth.users(id,email) values
 ('fc100000-0000-4000-9000-000000000001','pb-ess@example.test'),
 ('fc100000-0000-4000-9000-000000000002','pb-pro@example.test'),
 ('fc100000-0000-4000-9000-000000000009','pb-staff@example.test');
insert into public.users(id,farm_id,role,name,email) values
 ('fc100000-0000-4000-9000-000000000001','fc000000-0000-4000-9000-000000000001','owner','E','pb-ess@example.test'),
 ('fc100000-0000-4000-9000-000000000002','fc000000-0000-4000-9000-000000000002','owner','P','pb-pro@example.test'),
 ('fc100000-0000-4000-9000-000000000009',null,'rr_admin','Staff','pb-staff@example.test');
insert into public.machines(id,farm_id,name,type,meter_type,purchase_price_cents,purchase_date,depreciation_method,useful_life_months) values
 ('fc200000-0000-4000-9000-000000000001','fc000000-0000-4000-9000-000000000001','E tractor','tractor','hours',100000000,'2024-01-01','straight_line',120),
 ('fc200000-0000-4000-9000-000000000002','fc000000-0000-4000-9000-000000000002','P tractor','tractor','hours',100000000,'2024-01-01','straight_line',120),
 ('fc200000-0000-4000-9000-000000000003','fc000000-0000-4000-9000-000000000003','D tractor','tractor','hours',100000000,'2024-01-01','straight_line',120),
 ('fc200000-0000-4000-9000-000000000004','fc000000-0000-4000-9000-000000000001','E bakkie','bakkie','km',null,null,'none',null);

-- (a) Book value: the Essential owner reads none, the Professional owner reads theirs.
set role authenticated;
select set_config('request.jwt.claims','{"sub":"fc100000-0000-4000-9000-000000000001","role":"authenticated"}',true);
do $$ begin
  if exists(select 1 from public.farm_book_values('fc000000-0000-4000-9000-000000000001')) then
    raise exception 'PLAN FAIL [a]: an Essential farm read its book value register through the RPC'; end if;
  -- The purchase price itself is still a record the Essential owner keeps.
  if not exists(select 1 from public.machines where id='fc200000-0000-4000-9000-000000000001') then
    raise exception 'PLAN FAIL [a]: the Essential owner lost sight of their own machine'; end if;
end $$;
select set_config('request.jwt.claims','{"sub":"fc100000-0000-4000-9000-000000000002","role":"authenticated"}',true);
do $$ declare n int; begin
  select count(*) into n from public.farm_book_values('fc000000-0000-4000-9000-000000000002');
  if n <> 1 then raise exception 'PLAN FAIL [a]: the Professional owner read % book value row(s), expected 1', n; end if;
  -- And never another farm's, whatever its plan.
  if exists(select 1 from public.farm_book_values('fc000000-0000-4000-9000-000000000003')) then
    raise exception 'PLAN FAIL [a]: book value crossed into another farm'; end if;
end $$;
reset role;

-- (b) A feed is switched on only for a Done-For-You farm, even by staff with a quote.
set role authenticated;
select set_config('request.jwt.claims','{"sub":"fc100000-0000-4000-9000-000000000009","role":"authenticated","aal":"aal2"}',true);
do $$ declare v_ok boolean := false; v_id uuid; begin
  if not app.is_rr_admin() then raise exception 'PLAN SETUP: the staff fixture is not unlocked'; end if;
  begin
    perform public.configure_driver_connection('fc000000-0000-4000-9000-000000000002','Tracker','tracker',
      repeat('b',64),null,true,'Q-2026-001');
  exception when invalid_parameter_value then
    v_ok := sqlerrm = 'plan_required';
  end;
  if not v_ok then raise exception 'PLAN FAIL [b]: a feed was switched on for a Professional farm'; end if;
  -- Created switched OFF is allowed on any plan (staff prepare it before the agreement).
  v_id := public.configure_driver_connection('fc000000-0000-4000-9000-000000000002','Tracker','tracker',
    repeat('c',64),null,false,null);
  if v_id is null then raise exception 'PLAN FAIL [b]: an inactive feed could not be prepared'; end if;
  -- On Done-For-You it switches on.
  v_id := public.configure_driver_connection('fc000000-0000-4000-9000-000000000003','Tracker','tracker',
    repeat('d',64),null,true,'Q-2026-002');
  if not (select active from public.driver_connections where id=v_id) then
    raise exception 'PLAN FAIL [b]: a Done-For-You farm could not switch its feed on'; end if;
end $$;
reset role;

-- (c) Events stop when the farm leaves Done-For-You or is paused.
select set_config('request.jwt.claims','',false);
insert into public.driver_connections(id,farm_id,name,kind,active,quote_reference) values
  ('fc300000-0000-4000-9000-000000000001','fc000000-0000-4000-9000-000000000003','Feed','tracker',true,'Q-1');
insert into public.driver_device_links(farm_id,connection_id,external_id,machine_id,driver_id) values
  ('fc000000-0000-4000-9000-000000000003','fc300000-0000-4000-9000-000000000001','veh-1','fc200000-0000-4000-9000-000000000003',null);
do $$ declare v_code text; begin
  update public.farms set plan='complete' where id='fc000000-0000-4000-9000-000000000003';
  begin
    perform public.ingest_driving_event('fc300000-0000-4000-9000-000000000001','veh-1','drv-1','evt-1','start',now());
    v_code := 'none';
  exception when others then v_code := sqlerrm; end;
  if v_code is distinct from 'plan_required' then
    raise exception 'PLAN FAIL [c]: a farm that left Done-For-You still had its feed accepted (%)', v_code; end if;

  update public.farms set plan='done_for_you', status='suspended' where id='fc000000-0000-4000-9000-000000000003';
  begin
    perform public.ingest_driving_event('fc300000-0000-4000-9000-000000000001','veh-1','drv-1','evt-2','start',now());
    v_code := 'none';
  exception when others then v_code := sqlerrm; end;
  if v_code is distinct from 'plan_required' then
    raise exception 'PLAN FAIL [c]: a paused farm still had its feed accepted (%)', v_code; end if;

  -- Active and on Done-For-You, the plan check passes (the unmapped driver is the next refusal).
  update public.farms set status='active' where id='fc000000-0000-4000-9000-000000000003';
  begin
    perform public.ingest_driving_event('fc300000-0000-4000-9000-000000000001','veh-1','drv-1','evt-3','start',now());
    v_code := 'none';
  exception when others then v_code := sqlerrm; end;
  if v_code = 'plan_required' then
    raise exception 'PLAN FAIL [c]: an active Done-For-You farm was refused on its plan'; end if;
end $$;

rollback;
