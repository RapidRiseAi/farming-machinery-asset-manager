\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',false);
insert into public.farms(id,name,plan,status) values('9b000000-0000-4000-8000-000000000001','Revision farm','complete','active');
insert into auth.users(id,email) values('9b100000-0000-4000-8000-000000000001','revision@example.test');
insert into public.users(id,farm_id,role,name) values('9b100000-0000-4000-8000-000000000001','9b000000-0000-4000-8000-000000000001','owner','Revision owner');
insert into public.machines(id,farm_id,name,type,meter_type,status,current_reading,current_reading_date)
 values('9b200000-0000-4000-8000-000000000001','9b000000-0000-4000-8000-000000000001','Tractor','tractor','hours','active',100,current_date-10);
insert into public.service_plan_lines(id,farm_id,machine_id,task,interval_hours,last_done_reading,last_done_date) values
 ('9b300000-0000-4000-8000-000000000001','9b000000-0000-4000-8000-000000000001','9b200000-0000-4000-8000-000000000001','Oil',250,50,current_date-20),
 ('9b300000-0000-4000-8000-000000000002','9b000000-0000-4000-8000-000000000001','9b200000-0000-4000-8000-000000000001','Filter',250,50,current_date-20);
insert into public.job_cards(id,farm_id,machine_id,type,status,date_in,work_performed,meter_reading,recommendations) values
 ('9b400000-0000-4000-8000-000000000001','9b000000-0000-4000-8000-000000000001','9b200000-0000-4000-8000-000000000001','scheduled_service','in_progress',current_date-5,'Oil changed',120,'Check belt'),
 ('9b400000-0000-4000-8000-000000000002','9b000000-0000-4000-8000-000000000001','9b200000-0000-4000-8000-000000000001','scheduled_service','in_progress',current_date-2,'Filter changed',130,null);
-- A trusted import of an already completed card has the same missing provenance
-- as a card completed before this migration. Its old history must not be guessed.
insert into public.job_cards(id,farm_id,machine_id,type,status,date_in,date_out,work_performed,meter_reading) values
 ('9b400000-0000-4000-8000-000000000003','9b000000-0000-4000-8000-000000000001','9b200000-0000-4000-8000-000000000001','repair','completed',current_date-30,current_date-30,'Historical repair',40);
insert into public.job_card_service_lines(job_card_id,service_plan_line_id,farm_id,machine_id) values
 ('9b400000-0000-4000-8000-000000000001','9b300000-0000-4000-8000-000000000001','9b000000-0000-4000-8000-000000000001','9b200000-0000-4000-8000-000000000001'),
 ('9b400000-0000-4000-8000-000000000002','9b300000-0000-4000-8000-000000000002','9b000000-0000-4000-8000-000000000001','9b200000-0000-4000-8000-000000000001');
insert into public.service_kits(id,farm_id,machine_type,name) values
 ('9b600000-0000-4000-8000-000000000001','9b000000-0000-4000-8000-000000000001','tractor','Tractor kit');
insert into public.service_kit_items(farm_id,service_kit_id,description,qty,unit_cost_cents) values
 ('9b000000-0000-4000-8000-000000000001','9b600000-0000-4000-8000-000000000001','Kit filter',1,1000),
 ('9b000000-0000-4000-8000-000000000001','9b600000-0000-4000-8000-000000000001','Kit oil',2,500);
set role authenticated;
select set_config('request.jwt.claims','{"sub":"9b100000-0000-4000-8000-000000000001","role":"authenticated"}',false);
do $$ declare denied boolean:=false; version timestamptz; changed integer; begin
 begin update public.job_cards set status='in_progress',review_note='Correct historical details'
   where id='9b400000-0000-4000-8000-000000000003';
 exception when check_violation then denied:=true; end;
 if not denied then raise exception 'REVISION FAIL: legacy completion was returned without reversible history'; end if;
 denied:=false;
 begin update public.job_cards set completion_effects_recorded=true
   where id='9b400000-0000-4000-8000-000000000002';
 exception when check_violation then denied:=true; end;
 if not denied then raise exception 'REVISION FAIL: completion provenance can be forged'; end if;
 update public.job_cards set status='approved' where id='9b400000-0000-4000-8000-000000000003';
 if not exists(select 1 from public.job_cards where id='9b400000-0000-4000-8000-000000000003'
   and status='approved' and not completion_effects_recorded) then
   raise exception 'REVISION FAIL: historical work can no longer be reviewed'; end if;

 select updated_at into version from public.job_cards where id='9b400000-0000-4000-8000-000000000002';
 delete from public.job_card_service_lines where job_card_id='9b400000-0000-4000-8000-000000000002';
 if (select updated_at from public.job_cards where id='9b400000-0000-4000-8000-000000000002')=version then
   raise exception 'REVISION FAIL: removing service coverage did not change the job version'; end if;
 update public.job_cards set status='completed',date_out=current_date-1
   where id='9b400000-0000-4000-8000-000000000002' and updated_at=version;
 get diagnostics changed = row_count;
 if changed<>0 then raise exception 'REVISION FAIL: stale completion accepted unseen coverage changes'; end if;
 select updated_at into version from public.job_cards where id='9b400000-0000-4000-8000-000000000002';
 insert into public.job_card_service_lines(job_card_id,service_plan_line_id,farm_id,machine_id) values
   ('9b400000-0000-4000-8000-000000000002','9b300000-0000-4000-8000-000000000002','9b000000-0000-4000-8000-000000000001','9b200000-0000-4000-8000-000000000001');
 if (select updated_at from public.job_cards where id='9b400000-0000-4000-8000-000000000002')=version then
   raise exception 'REVISION FAIL: adding service coverage did not change the job version'; end if;
end $$;
do $$ declare a uuid; b uuid; changed boolean:=false; begin
 a:=public.record_job_card_line('9b400000-0000-4000-8000-000000000001','9b500000-0000-4000-8000-000000000001','{"kind":"part","description":"Oil","qty":1,"unit_cost_cents":500}');
 b:=public.record_job_card_line('9b400000-0000-4000-8000-000000000001','9b500000-0000-4000-8000-000000000001','{"kind":"part","description":"Oil","qty":1,"unit_cost_cents":500}');
 if a<>b or (select count(*) from public.job_card_lines where job_card_id='9b400000-0000-4000-8000-000000000001')<>1 then raise exception 'REVISION FAIL: online retry duplicated a line'; end if;
 begin perform public.record_job_card_line('9b400000-0000-4000-8000-000000000001','9b500000-0000-4000-8000-000000000001','{"kind":"part","description":"Oil","qty":2,"unit_cost_cents":500}');
 exception when check_violation then changed:=true; end;
 if not changed then raise exception 'REVISION FAIL: changed retry accepted'; end if;
 update public.job_card_lines set qty=2 where id=a;
 perform public.record_job_card_line('9b400000-0000-4000-8000-000000000001','9b500000-0000-4000-8000-000000000001','{"kind":"part","description":"Oil","qty":1,"unit_cost_cents":500}');
 if (select qty from public.job_card_lines where id=a)<>2 then raise exception 'REVISION FAIL: retry reverted an edited line'; end if;
end $$;
do $$ declare denied boolean:=false; begin
 perform public.apply_job_card_kit('9b400000-0000-4000-8000-000000000001','9b600000-0000-4000-8000-000000000001','9b700000-0000-4000-8000-000000000001');
 perform public.apply_job_card_kit('9b400000-0000-4000-8000-000000000001','9b600000-0000-4000-8000-000000000001','9b700000-0000-4000-8000-000000000001');
 if (select count(*) from public.job_card_lines where job_card_id='9b400000-0000-4000-8000-000000000001')<>3 then
   raise exception 'REVISION FAIL: template kit retry duplicated or lost parts'; end if;
 begin update public.job_cards set mechanic_user_id='9b100000-0000-4000-8000-000000000099' where id='9b400000-0000-4000-8000-000000000001';
 exception when check_violation then denied:=true; end;
 if not denied then raise exception 'REVISION FAIL: invalid assignee accepted'; end if;
 denied:=false;
 begin update public.job_cards set status='completed',date_out=current_date,meter_reading=90 where id='9b400000-0000-4000-8000-000000000001';
 exception when check_violation then denied:=true; end;
 if not denied then raise exception 'REVISION FAIL: current completion decreased meter'; end if;
end $$;
reset role;
select set_config('request.jwt.claims','',false);
set role service_role;
do $$ declare result jsonb; begin
 result:=public.apply_offline_capture(gen_random_uuid(),now(),'add_job_line','app','9b100000-0000-4000-8000-000000000001',
   '{"job_card_id":"9b400000-0000-4000-8000-000000000001","draft_token":"9b500000-0000-4000-8000-000000000001","kind":"part","description":"Oil","qty":"1","unit_cost_cents":"500"}');
 if result->>'status'<>'applied' or (select count(*) from public.job_card_lines where job_card_id='9b400000-0000-4000-8000-000000000001')<>3 then
   raise exception 'REVISION FAIL: offline retry of online draft duplicated or lost a line'; end if;
end $$;
reset role;
set role authenticated;
select set_config('request.jwt.claims','{"sub":"9b100000-0000-4000-8000-000000000001","role":"authenticated"}',false);
update public.job_cards set status='completed',date_out=current_date-4 where id='9b400000-0000-4000-8000-000000000001';
do $$ begin
 if not exists(select 1 from public.job_cards where id='9b400000-0000-4000-8000-000000000001' and completion_effects_recorded) then
   raise exception 'REVISION FAIL: newly completed pending work lacks reversible history'; end if;
end $$;
update public.job_cards set status='in_progress',review_note='Wrong meter and task' where id='9b400000-0000-4000-8000-000000000001';
do $$ begin
 if (select current_reading from public.machines where id='9b200000-0000-4000-8000-000000000001')<>100 then raise exception 'REVISION FAIL: returned work left the wrong current meter'; end if;
 if (select last_done_reading from public.service_plan_lines where id='9b300000-0000-4000-8000-000000000001')<>50 then raise exception 'REVISION FAIL: returned service still marked done'; end if;
 if exists(select 1 from public.watch_items where source_job_card_id='9b400000-0000-4000-8000-000000000001' and deleted_at is null) then raise exception 'REVISION FAIL: returned recommendation still active'; end if;
end $$;
delete from public.job_card_service_lines where job_card_id='9b400000-0000-4000-8000-000000000001';
insert into public.job_card_service_lines(job_card_id,service_plan_line_id,farm_id,machine_id) values
 ('9b400000-0000-4000-8000-000000000001','9b300000-0000-4000-8000-000000000002','9b000000-0000-4000-8000-000000000001','9b200000-0000-4000-8000-000000000001');
update public.job_cards set meter_reading=110,recommendations=null where id='9b400000-0000-4000-8000-000000000001';
update public.job_cards set status='completed' where id='9b400000-0000-4000-8000-000000000001';
update public.job_cards set status='completed',date_out=current_date-1 where id='9b400000-0000-4000-8000-000000000002';
update public.job_cards set status='in_progress',review_note='Check historical details' where id='9b400000-0000-4000-8000-000000000001';
do $$ begin
 if (select last_done_reading from public.service_plan_lines where id='9b300000-0000-4000-8000-000000000002')<>130 then raise exception 'REVISION FAIL: correction overwrote a later service'; end if;
 if (select current_reading from public.machines where id='9b200000-0000-4000-8000-000000000001')<>130 then raise exception 'REVISION FAIL: correction overwrote a later meter'; end if;
end $$;
update public.job_cards set status='in_progress',review_note='Later service also incorrect' where id='9b400000-0000-4000-8000-000000000002';
do $$ begin
 if (select last_done_reading from public.service_plan_lines where id='9b300000-0000-4000-8000-000000000002')<>50 then raise exception 'REVISION FAIL: correction restored another returned service'; end if;
end $$;
reset role;
select set_config('request.jwt.claims','',false);
set role service_role;
do $$ declare result jsonb; version text; begin
 select updated_at::text into version from public.job_cards where id='9b400000-0000-4000-8000-000000000001';
 result:=public.apply_offline_capture(gen_random_uuid(),now(),'complete_job','app','9b100000-0000-4000-8000-000000000001',
 jsonb_build_object('id','9b400000-0000-4000-8000-000000000001','updated_at',(now()-interval '1 day')::text));
 if result->>'status'<>'conflict' then raise exception 'REVISION FAIL: stale offline completion accepted'; end if;
 result:=public.apply_offline_capture(gen_random_uuid(),now(),'complete_job','app','9b100000-0000-4000-8000-000000000001',
 jsonb_build_object('id','9b400000-0000-4000-8000-000000000001','updated_at',version,'meter_reading','900'));
 if result->>'status'<>'applied' then raise exception 'REVISION FAIL: saved historical completion rejected'; end if;
 if not exists(select 1 from public.job_cards where id='9b400000-0000-4000-8000-000000000001' and date_out=current_date-4 and meter_reading=110) then
 raise exception 'REVISION FAIL: offline completion changed saved handover'; end if;
end $$;
reset role;
set role authenticated;
select set_config('request.jwt.claims','{"sub":"9b100000-0000-4000-8000-000000000001","role":"authenticated"}',false);
do $$ declare line_id uuid; denied boolean:=false; begin
 line_id:=public.record_job_card_line('9b400000-0000-4000-8000-000000000002',gen_random_uuid(),'{"kind":"other","description":"Transport","unit_cost_cents":500}');
 if public.remove_job_card_line('9b400000-0000-4000-8000-000000000002',line_id,now()-interval '1 day') then
   raise exception 'REVISION FAIL: stale removal succeeded'; end if;
 if not public.remove_job_card_line('9b400000-0000-4000-8000-000000000002',line_id,(select updated_at from public.job_card_lines where id=line_id)) then
   raise exception 'REVISION FAIL: line removal failed'; end if;
 if (select total_cents from public.job_cards_visible where id='9b400000-0000-4000-8000-000000000002')<>0
   or exists(select 1 from public.cost_entries where source_type='job_card_line' and source_id=line_id and deleted_at is null) then
   raise exception 'REVISION FAIL: removed line still contributes costs'; end if;
 if not public.remove_job_card_line('9b400000-0000-4000-8000-000000000002',line_id,null) then
   raise exception 'REVISION FAIL: removal retry was not acknowledged'; end if;
 begin perform public.record_job_card_line('9b400000-0000-4000-8000-000000000002',line_id,'{"kind":"other","description":"Transport","unit_cost_cents":500}');
 exception when check_violation then denied:=true; end;
 if not denied then raise exception 'REVISION FAIL: deleted line retry reported a false success'; end if;
end $$;

-- A replacement rebases the saved service reading without changing its service
-- date. Returning a later job must preserve that baseline instead of restoring
-- the old meter's raw reading from an earlier job on the same service date.
select public.record_meter_replacement('9b000000-0000-4000-8000-000000000001',
  '9b200000-0000-4000-8000-000000000001',0,current_date-2,'Replacement before later service');
insert into public.job_cards(id,farm_id,machine_id,type,status,date_in) values
 ('9b400000-0000-4000-8000-000000000004','9b000000-0000-4000-8000-000000000001','9b200000-0000-4000-8000-000000000001','scheduled_service','open',current_date);
update public.job_cards set status='in_progress',work_performed='New meter service',meter_reading=10,date_out=current_date
 where id='9b400000-0000-4000-8000-000000000004';
insert into public.job_card_service_lines(job_card_id,service_plan_line_id,farm_id,machine_id) values
 ('9b400000-0000-4000-8000-000000000004','9b300000-0000-4000-8000-000000000002','9b000000-0000-4000-8000-000000000001','9b200000-0000-4000-8000-000000000001');
update public.job_cards set status='completed' where id='9b400000-0000-4000-8000-000000000004';
update public.job_cards set status='in_progress',review_note='Check service after replacement'
 where id='9b400000-0000-4000-8000-000000000004';
do $$ begin
 if (select last_done_reading from public.service_plan_lines where id='9b300000-0000-4000-8000-000000000002')<>0 then
   raise exception 'REVISION FAIL: returned service restored a reading from the replaced meter'; end if;
end $$;
update public.service_plan_lines set last_done_reading=2 where id='9b300000-0000-4000-8000-000000000002';
update public.job_cards set status='completed' where id='9b400000-0000-4000-8000-000000000004';
update public.job_cards set status='in_progress',review_note='Check service after manual baseline correction'
 where id='9b400000-0000-4000-8000-000000000004';
do $$ begin
 if (select last_done_reading from public.service_plan_lines where id='9b300000-0000-4000-8000-000000000002')<>2 then
   raise exception 'REVISION FAIL: repeat completion lost the newly corrected service baseline'; end if;
end $$;
rollback;
