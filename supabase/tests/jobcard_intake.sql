\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',false);
insert into public.farms(id,name,plan,status) values('e8000000-0000-4000-9000-000000000001','Intake farm','professional','active');
insert into public.workshops(id,name) values('e8200000-0000-4000-9000-000000000001','Intake supplier');
insert into public.workshop_links(farm_id,workshop_id,status,see_all_vehicles) values
 ('e8000000-0000-4000-9000-000000000001','e8200000-0000-4000-9000-000000000001','active',true);
insert into auth.users(id,email) values
 ('e8100000-0000-4000-9000-000000000001','intake.owner@example.test'),
 ('e8100000-0000-4000-9000-000000000002','intake.mechanic@example.test'),
 ('e8100000-0000-4000-9000-000000000003','intake.operator@example.test');
insert into public.users(id,farm_id,role,name) values
 ('e8100000-0000-4000-9000-000000000001','e8000000-0000-4000-9000-000000000001','owner','Owner'),
 ('e8100000-0000-4000-9000-000000000002','e8000000-0000-4000-9000-000000000001','mechanic','Mechanic'),
 ('e8100000-0000-4000-9000-000000000003','e8000000-0000-4000-9000-000000000001','operator','Operator');
insert into public.machines(id,farm_id,name,type,meter_type,status) values
 ('e8300000-0000-4000-9000-000000000001','e8000000-0000-4000-9000-000000000001','Tractor','tractor','hours','active');
insert into public.faults(id,farm_id,machine_id,description,status) values
 ('e8400000-0000-4000-9000-000000000001','e8000000-0000-4000-9000-000000000001','e8300000-0000-4000-9000-000000000001','Hydraulic leak','open');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"e8100000-0000-4000-9000-000000000001","role":"authenticated"}',false);
do $$ declare saved uuid; repeated uuid; rejected boolean; job jsonb; request jsonb; begin
 job:='{"farm_id":"e8000000-0000-4000-9000-000000000001","machine_id":"e8300000-0000-4000-9000-000000000001","type":"repair","work_mode":"internal","reported_problem":"Repair leak","created_from_fault_id":"e8400000-0000-4000-9000-000000000001"}';
 saved:=public.create_job_card_intake('e8500000-0000-4000-9000-000000000001',job);
 update public.job_cards set status='in_progress',reported_problem='Inspected leak' where id=saved;
 repeated:=public.create_job_card_intake('e8500000-0000-4000-9000-000000000001',job||jsonb_build_object('date_in',current_date+1,'vat_rate_bps',1400));
 if repeated<>saved or (select count(*) from public.job_cards where intake_capture='e8500000-0000-4000-9000-000000000001')<>1 then
   raise exception 'INTAKE FAIL: retry duplicated a card'; end if;
 if not exists(select 1 from public.job_cards where id=saved and reported_problem='Inspected leak' and date_in=current_date) then
   raise exception 'INTAKE FAIL: retry overwrote saved work'; end if;
 if (select job_card_id from public.faults where id='e8400000-0000-4000-9000-000000000001')<>saved then
   raise exception 'INTAKE FAIL: fault not linked'; end if;
 rejected:=false;
 begin perform public.create_job_card_intake('e8500000-0000-4000-9000-000000000001',job||'{"reported_problem":"Different repair"}'::jsonb);
 exception when check_violation then rejected:=true; end;
 if not rejected then raise exception 'INTAKE FAIL: changed capture accepted'; end if;
 rejected:=false;
 begin update public.job_cards set intake_payload='{}' where id=saved;
 exception when check_violation then rejected:=true; end;
 if not rejected then raise exception 'INTAKE FAIL: immutable receipt changed'; end if;

 request:='{"farm_id":"e8000000-0000-4000-9000-000000000001","machine_id":"e8300000-0000-4000-9000-000000000001","workshop_id":"e8200000-0000-4000-9000-000000000001","description":"Repair brakes","job_card_type":"repair","kind":"repair","priority":"normal"}';
 saved:=public.create_work_request_intake('e8500000-0000-4000-9000-000000000002',request);
 repeated:=public.create_work_request_intake('e8500000-0000-4000-9000-000000000002',request||'{"vat_rate_bps":1400}'::jsonb);
 if repeated<>saved or (select count(*) from public.work_request_events where work_request_id=saved)<>1 then
   raise exception 'INTAKE FAIL: request retry duplicated record or event'; end if;
 perform public.update_work_request(saved,'accepted');
 perform public.convert_work_request_to_job_card(saved);
 repeated:=public.create_work_request_intake('e8500000-0000-4000-9000-000000000002',request);
 if repeated<>saved then raise exception 'INTAKE FAIL: conversion invalidated intake receipt'; end if;
 rejected:=false;
 begin perform public.create_job_card_intake('e8500000-0000-4000-9000-000000000002',job);
 exception when check_violation then rejected:=true; end;
 if not rejected then raise exception 'INTAKE FAIL: request capture reused as job'; end if;
 rejected:=false;
 begin perform public.create_work_request_intake('e8500000-0000-4000-9000-000000000001',request);
 exception when check_violation then rejected:=true; end;
 if not rejected then raise exception 'INTAKE FAIL: job capture reused as request'; end if;
end $$;
select set_config('request.jwt.claims','{"sub":"e8100000-0000-4000-9000-000000000002","role":"authenticated"}',false);
do $$ declare rejected boolean:=false; begin
 begin perform public.create_job_card_intake('e8500000-0000-4000-9000-000000000001',
 '{"farm_id":"e8000000-0000-4000-9000-000000000001","machine_id":"e8300000-0000-4000-9000-000000000001","type":"repair","work_mode":"internal","reported_problem":"Repair leak","created_from_fault_id":"e8400000-0000-4000-9000-000000000001"}');
 exception when check_violation then rejected:=true; end;
 if not rejected then raise exception 'INTAKE FAIL: another actor claimed receipt'; end if;
end $$;
select set_config('request.jwt.claims','{"sub":"e8100000-0000-4000-9000-000000000003","role":"authenticated"}',false);
do $$ declare rejected boolean:=false; begin
 begin perform public.create_job_card_intake(gen_random_uuid(),
 '{"farm_id":"e8000000-0000-4000-9000-000000000001","machine_id":"e8300000-0000-4000-9000-000000000001","reported_problem":"Unauthorized repair"}');
 exception when insufficient_privilege then rejected:=true; end;
 if not rejected then raise exception 'INTAKE FAIL: operator created work'; end if;
end $$;
reset role;
do $$ begin
 if has_function_privilege('anon','public.create_job_card_intake(uuid,jsonb)','execute')
   or has_function_privilege('anon','public.create_work_request_intake(uuid,jsonb)','execute') then
   raise exception 'INTAKE FAIL: anonymous intake mutation allowed'; end if;
end $$;
rollback;
