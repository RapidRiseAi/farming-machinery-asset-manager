\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',false);
insert into public.farms(id,name,plan,status) values
 ('fd000000-0000-0000-0000-000000000001','Offline primary','professional','active'),
 ('fd000000-0000-0000-0000-000000000002','Offline secondary','professional','active'),
 ('fd000000-0000-0000-0000-000000000003','Offline pending billing','professional','active'),
 ('fd000000-0000-0000-0000-000000000004','Offline closed billing','professional','active');
insert into public.billing_subscriptions(farm_id,plan,status,ended_on) values
 ('fd000000-0000-0000-0000-000000000003','professional','pending',null),
 ('fd000000-0000-0000-0000-000000000004','professional','cancelled',
   current_date - coalesce((select lapsed_grace_days from public.billing_settings where singleton),30) - 1);
insert into public.workshops(id,name) values ('fd600000-0000-0000-0000-000000000001','Offline workshop');
insert into auth.users(id,email) values
 ('fd100000-0000-0000-0000-000000000001','offline@example.test'),
 ('fd100000-0000-0000-0000-000000000002','offline.mechanic@example.test'),
 ('fd100000-0000-0000-0000-000000000003','offline.workshop@example.test');
insert into public.users(id,farm_id,role,name,email) values
 ('fd100000-0000-0000-0000-000000000001','fd000000-0000-0000-0000-000000000001','owner','Offline owner','offline@example.test'),
 ('fd100000-0000-0000-0000-000000000002','fd000000-0000-0000-0000-000000000001','operator','Offline mechanic','offline.mechanic@example.test');
insert into public.users(id,workshop_id,role,name,email) values
 ('fd100000-0000-0000-0000-000000000003','fd600000-0000-0000-0000-000000000001','workshop','Offline workshop user','offline.workshop@example.test');
insert into public.user_farm_memberships(user_id,farm_id,role,active) values
 ('fd100000-0000-0000-0000-000000000001','fd000000-0000-0000-0000-000000000002','operator',true),
 ('fd100000-0000-0000-0000-000000000002','fd000000-0000-0000-0000-000000000002','mechanic',true),
 ('fd100000-0000-0000-0000-000000000002','fd000000-0000-0000-0000-000000000003','mechanic',true),
 ('fd100000-0000-0000-0000-000000000002','fd000000-0000-0000-0000-000000000004','mechanic',true);
insert into public.workshop_links(workshop_id,farm_id,status,see_all_vehicles) values
 ('fd600000-0000-0000-0000-000000000001','fd000000-0000-0000-0000-000000000002','active',false);
insert into public.machines(id,farm_id,name,type,meter_type,status,assigned_operator_id,public_token) values
 ('fd200000-0000-0000-0000-000000000001','fd000000-0000-0000-0000-000000000002','Assigned tractor','tractor','hours','active','fd100000-0000-0000-0000-000000000001','fd900000-0000-0000-0000-000000000001'),
 ('fd200000-0000-0000-0000-000000000002','fd000000-0000-0000-0000-000000000002','Unassigned tractor','tractor','hours','active',null,'fd900000-0000-0000-0000-000000000002');
insert into public.machines(id,farm_id,name,type,meter_type,status,public_token,current_reading,current_reading_date) values
 ('fd200000-0000-0000-0000-000000000003','fd000000-0000-0000-0000-000000000003','Pending billing tractor','tractor','hours','active','fd900000-0000-0000-0000-000000000003',25,current_date),
 ('fd200000-0000-0000-0000-000000000004','fd000000-0000-0000-0000-000000000004','Closed billing tractor','tractor','hours','active','fd900000-0000-0000-0000-000000000004',25,current_date);
insert into public.job_cards(id,farm_id,machine_id,type,status,date_in) values
 ('fd300000-0000-0000-0000-000000000001','fd000000-0000-0000-0000-000000000002','fd200000-0000-0000-0000-000000000001','repair','open',current_date),
 ('fd300000-0000-0000-0000-000000000002','fd000000-0000-0000-0000-000000000002','fd200000-0000-0000-0000-000000000002','repair','open',current_date),
 ('fd300000-0000-0000-0000-000000000003','fd000000-0000-0000-0000-000000000003','fd200000-0000-0000-0000-000000000003','repair','open',current_date),
 ('fd300000-0000-0000-0000-000000000004','fd000000-0000-0000-0000-000000000004','fd200000-0000-0000-0000-000000000004','repair','open',current_date);
insert into public.work_requests(farm_id,machine_id,workshop_id,title) values
 ('fd000000-0000-0000-0000-000000000002','fd200000-0000-0000-0000-000000000002','fd600000-0000-0000-0000-000000000001','Offline contractor scope');
do $$ begin
 if has_function_privilege('authenticated','public.apply_offline_capture(uuid,timestamptz,text,text,uuid,jsonb)','EXECUTE')
   or has_function_privilege('anon','public.apply_offline_capture(uuid,timestamptz,text,text,uuid,jsonb)','EXECUTE')
   or not has_function_privilege('service_role','public.apply_offline_capture(uuid,timestamptz,text,text,uuid,jsonb)','EXECUTE') then
   raise exception 'OFFLINE FAIL: trusted-only RPC grants';
 end if;
end $$;
set role service_role;
do $$
declare
 actor uuid := 'fd100000-0000-0000-0000-000000000001';
 machine uuid := 'fd200000-0000-0000-0000-000000000001';
 key uuid := 'fd400000-0000-0000-0000-000000000001';
 fields jsonb := jsonb_build_object('machine_id',machine::text,'reading','10','reading_date',current_date::text);
 r jsonb;
 denied boolean;
begin
 r := public.apply_offline_capture(key,now(),'log_reading','app',actor,fields);
 if r->>'status' <> 'applied' or (r->>'entity_id') is null then raise exception 'OFFLINE FAIL: assigned capture'; end if;
 r := public.apply_offline_capture(key,now(),'log_reading','app',actor,fields);
 if r->>'duplicate' <> 'true' or (select count(*) from public.meter_readings where machine_id=machine) <> 1
   or (select count(*) from public.usage_logs where machine_id=machine) <> 1 then
   raise exception 'OFFLINE FAIL: duplicate created data'; end if;
 r := public.apply_offline_capture(key,now(),'log_reading','app',actor,fields || '{"reading":"11"}');
 if r->>'status' <> 'needs_review' then raise exception 'OFFLINE FAIL: mismatched replay acknowledged'; end if;
 r := public.apply_offline_capture(gen_random_uuid(),now(),'log_reading','app',actor,fields || '{"reading":"9"}');
 if r->>'status' <> 'conflict' or (select current_reading from public.machines where id=machine) <> 10 then
   raise exception 'OFFLINE FAIL: decreasing reading moved meter'; end if;
 r := public.apply_offline_capture(gen_random_uuid(),now(),'log_reading','app',actor,
   fields || jsonb_build_object('reading','8','reading_date',(current_date-1)::text));
 if r->>'status' <> 'applied' or (select current_reading from public.machines where id=machine) <> 10 then
   raise exception 'OFFLINE FAIL: historical reading replaced current'; end if;
 denied := false;
 begin
   perform public.apply_offline_capture(gen_random_uuid(),now(),'log_reading','app',actor,
     fields || '{"machine_id":"fd200000-0000-0000-0000-000000000002"}');
 exception when insufficient_privilege then denied := true; end;
 if not denied then raise exception 'OFFLINE FAIL: operator unassigned mutation'; end if;
 denied := false;
 begin
   perform public.apply_offline_capture(gen_random_uuid(),now(),'complete_job','app',actor,
     '{"job_card_id":"fd300000-0000-0000-0000-000000000001"}');
 exception when insufficient_privilege then denied := true; end;
 if not denied then raise exception 'OFFLINE FAIL: primary owner escalated secondary operator'; end if;
 denied := false;
 begin
   perform public.apply_offline_capture(gen_random_uuid(),now(),'log_reading','app',actor,fields || '{"reading":""}');
 exception when invalid_parameter_value then denied := true; end;
 if not denied then raise exception 'OFFLINE FAIL: blank reading accepted'; end if;
 r := public.apply_offline_capture(gen_random_uuid(),now(),'report_fault','public',null,
   '{"token":"fd900000-0000-0000-0000-000000000001","description":"Offline QR fault","urgency":"stopped"}');
 if r->>'status' <> 'applied' then raise exception 'OFFLINE FAIL: QR fault'; end if;
 if exists(select 1 from public.sync_log where farm_id='fd000000-0000-0000-0000-000000000002' and payload ? 'token') then
   raise exception 'OFFLINE FAIL: public credential stored in audit payload'; end if;
end $$;
-- Selected-farm mechanics and scoped contractors must retain their full crew workflow.
do $$
declare
 actor uuid := 'fd100000-0000-0000-0000-000000000002';
 card uuid := 'fd300000-0000-0000-0000-000000000001';
 machine uuid := 'fd200000-0000-0000-0000-000000000001';
 key uuid := 'fd400000-0000-0000-0000-000000000020';
 fields jsonb := jsonb_build_object('job_card_id',card::text,'kind','part','qty','2','unit_cost_cents','115','incl_vat','1');
 bad jsonb;
 denied boolean;
 r jsonb;
 reading_count bigint;
 usage_count bigint;
begin
 r := public.apply_offline_capture(key,now(),'add_job_line','app',actor,fields);
 if r->>'status' is distinct from 'applied'
   or (select total_cents from public.job_card_lines where id=(r->>'entity_id')::uuid) is distinct from 200::bigint then
   raise exception 'OFFLINE FAIL: mechanic part VAT calculation'; end if;
 r := public.apply_offline_capture(key,now(),'add_job_line','app',actor,fields);
 if r->>'duplicate' is distinct from 'true' or (select count(*) from public.job_card_lines where job_card_id=card) <> 1 then
   raise exception 'OFFLINE FAIL: duplicate job line'; end if;
 r := public.apply_offline_capture(gen_random_uuid(),now(),'add_job_line','app',actor,
   jsonb_build_object('job_card_id',card::text,'kind','labour','hours','1.5','rate_cents','230','incl_vat','1'));
 if r->>'status' is distinct from 'applied'
   or (select total_cents from public.job_card_lines where id=(r->>'entity_id')::uuid) is distinct from 300::bigint then
   raise exception 'OFFLINE FAIL: mechanic labour VAT calculation'; end if;
 r := public.apply_offline_capture(gen_random_uuid(),now(),'add_job_line','app',actor,
   jsonb_build_object('job_card_id',card::text,'kind','other','unit_cost_cents','50'));
 if r->>'status' is distinct from 'applied' or (select total_cents from public.job_cards where id=card) is distinct from 550::bigint then
   raise exception 'OFFLINE FAIL: crew totals'; end if;
 for bad in select value from jsonb_array_elements('[
   {"kind":"part","qty":"NaN"}, {"kind":"part","qty":"10000000000"},
   {"kind":"part","qty":"0.001"}, {"kind":"labour","hours":"NaN"},
   {"kind":"labour","hours":"Infinity"}, {"kind":"labour","hours":"-1"}
 ]'::jsonb) loop
   denied := false;
   begin
     perform public.apply_offline_capture(gen_random_uuid(),now(),'add_job_line','app',actor,fields || bad);
   exception when invalid_parameter_value then denied := true; end;
   if not denied then raise exception 'OFFLINE FAIL: invalid crew quantity accepted: %',bad; end if;
 end loop;
 for bad in select value from jsonb_array_elements('[
   {"reading":"NaN"}, {"reading":"0.11"}, {"reading_date":"infinity"},
   {"reading_date":"1969-12-31"}
 ]'::jsonb) loop
   denied := false;
   begin
     perform public.apply_offline_capture(gen_random_uuid(),now(),'log_reading','app',actor,
       jsonb_build_object('machine_id',machine::text,'reading','10') || bad);
   exception when invalid_parameter_value then denied := true; end;
   if not denied then raise exception 'OFFLINE FAIL: invalid reading accepted: %',bad; end if;
 end loop;
 r := public.apply_offline_capture(gen_random_uuid(),now(),'complete_job','app',actor,
   jsonb_build_object('job_card_id',card::text,'meter_reading','9'));
 if r->>'status' is distinct from 'conflict' or (select status from public.job_cards where id=card) <> 'open'
   or (select current_reading from public.machines where id=machine) <> 10 then
   raise exception 'OFFLINE FAIL: completion rolled meter backwards'; end if;
 select count(*) into reading_count from public.meter_readings where machine_id=machine;
 select count(*) into usage_count from public.usage_logs where machine_id=machine;
 key := gen_random_uuid();
 fields := jsonb_build_object('job_card_id',card::text,'meter_reading','10');
 r := public.apply_offline_capture(key,now(),'complete_job','app',actor,fields);
 if r->>'status' is distinct from 'applied' or (select status from public.job_cards where id=card) <> 'completed' then
   raise exception 'OFFLINE FAIL: mechanic completion'; end if;
 r := public.apply_offline_capture(key,now(),'complete_job','app',actor,fields);
 if r->>'duplicate' is distinct from 'true'
   or (select count(*) from public.meter_readings where machine_id=machine) <> reading_count+1
   or (select count(*) from public.usage_logs where machine_id=machine) <> usage_count+1 then
   raise exception 'OFFLINE FAIL: completion side effects duplicated'; end if;
 actor := 'fd100000-0000-0000-0000-000000000003';
 denied := false;
 begin
   perform public.apply_offline_capture(gen_random_uuid(),now(),'add_job_line','app',actor,
     jsonb_build_object('job_card_id',card::text,'kind','other','unit_cost_cents','5'));
 exception when insufficient_privilege then denied := true; end;
 if not denied then raise exception 'OFFLINE FAIL: workshop escaped assigned-machine scope'; end if;
 card := 'fd300000-0000-0000-0000-000000000002';
 r := public.apply_offline_capture(gen_random_uuid(),now(),'add_job_line','app',actor,
   jsonb_build_object('job_card_id',card::text,'kind','other','unit_cost_cents','5'));
 if r->>'status' is distinct from 'applied' then raise exception 'OFFLINE FAIL: scoped workshop line'; end if;
 r := public.apply_offline_capture(gen_random_uuid(),now(),'complete_job','app',actor,
   jsonb_build_object('job_card_id',card::text,'meter_reading','5'));
 if r->>'status' is distinct from 'applied' or (select status from public.job_cards where id=card) <> 'completed' then
   raise exception 'OFFLINE FAIL: scoped workshop completion'; end if;
end $$;
-- Active farms with pending or expired billing cannot capture through either scope.
-- The successful fixtures above have no subscription and must remain grandfathered.
do $$
declare
 fixture record;
 capture record;
 denied boolean;
 machine_before jsonb;
 card_before jsonb;
begin
 for fixture in
   select m.id as machine_id,m.farm_id,m.public_token,j.id as card_id,
     case when s.status = 'pending' then 'pending' else 'closed' end as expected_gate
   from public.machines m
   join public.job_cards j on j.machine_id=m.id and j.farm_id=m.farm_id
   join public.billing_subscriptions s on s.farm_id=m.farm_id
   where m.farm_id in ('fd000000-0000-0000-0000-000000000003','fd000000-0000-0000-0000-000000000004')
 loop
   if app.farm_billing_gate(fixture.farm_id) is distinct from fixture.expected_gate then
     raise exception 'OFFLINE BILLING FAIL: fixture should be %',fixture.expected_gate;
   end if;
   select to_jsonb(m) into machine_before from public.machines m where m.id=fixture.machine_id;
   select to_jsonb(j) into card_before from public.job_cards j where j.id=fixture.card_id;
   for capture in select * from (values
     ('log_reading','app',jsonb_build_object('machine_id',fixture.machine_id::text,'reading','30')),
     ('report_fault','app',jsonb_build_object('machine_id',fixture.machine_id::text,'description','Billing blocked fault','urgency','stopped')),
     ('add_job_line','app',jsonb_build_object('job_card_id',fixture.card_id::text,'kind','other','unit_cost_cents','100')),
     ('complete_job','app',jsonb_build_object('job_card_id',fixture.card_id::text,'meter_reading','30')),
     ('log_reading','public',jsonb_build_object('token',fixture.public_token::text,'reading','30')),
     ('report_fault','public',jsonb_build_object('token',fixture.public_token::text,'description','Billing blocked QR fault','urgency','stopped'))
   ) as captures(mutation,scope,fields)
   loop
     denied := false;
     begin
       perform public.apply_offline_capture(gen_random_uuid(),now(),capture.mutation,capture.scope,
         case when capture.scope = 'app' then 'fd100000-0000-0000-0000-000000000002'::uuid end,
         capture.fields);
     exception when no_data_found then denied := true; end;
     if not denied then
       raise exception 'OFFLINE BILLING FAIL: % billing allowed % %',fixture.expected_gate,capture.scope,capture.mutation;
     end if;
   end loop;
   if exists(select 1 from public.meter_readings where farm_id=fixture.farm_id)
     or exists(select 1 from public.usage_logs where farm_id=fixture.farm_id)
     or exists(select 1 from public.faults where farm_id=fixture.farm_id)
     or exists(select 1 from public.job_card_lines where farm_id=fixture.farm_id)
     or exists(select 1 from public.cost_entries where farm_id=fixture.farm_id)
     or exists(select 1 from public.sync_log where farm_id=fixture.farm_id)
     or (select to_jsonb(m) from public.machines m where m.id=fixture.machine_id) is distinct from machine_before
     or (select to_jsonb(j) from public.job_cards j where j.id=fixture.card_id) is distinct from card_before then
     raise exception 'OFFLINE BILLING FAIL: % rejection changed data or acknowledgement',fixture.expected_gate;
   end if;
 end loop;
end $$;
reset role;
-- An injected downstream failure must roll back the reading, machine, usage and ack.
create function public._offline_fail_usage() returns trigger language plpgsql as $$
begin raise exception 'injected offline failure'; end $$;
create trigger _offline_fail_usage before insert on public.usage_logs for each row execute function public._offline_fail_usage();
set role service_role;
do $$
declare denied boolean := false; reading_count bigint; usage_count bigint;
begin
 select count(*) into reading_count from public.meter_readings where machine_id='fd200000-0000-0000-0000-000000000001';
 select count(*) into usage_count from public.usage_logs where machine_id='fd200000-0000-0000-0000-000000000001';
 begin
 perform public.apply_offline_capture('fd400000-0000-0000-0000-000000000099',now(),'log_reading','app',
 'fd100000-0000-0000-0000-000000000001','{"machine_id":"fd200000-0000-0000-0000-000000000001","reading":"20"}');
 exception when raise_exception then denied := true; end;
 if not denied or exists(select 1 from public.sync_log where client_id='fd400000-0000-0000-0000-000000000099')
 or (select count(*) from public.meter_readings where machine_id='fd200000-0000-0000-0000-000000000001') <> reading_count
 or (select count(*) from public.usage_logs where machine_id='fd200000-0000-0000-0000-000000000001') <> usage_count
 or (select current_reading from public.machines where id='fd200000-0000-0000-0000-000000000001') <> 10 then
 raise exception 'OFFLINE FAIL: downstream failure did not roll back'; end if;
end $$;
reset role;
rollback;
\echo 'Atomic offline capture tests passed.'
