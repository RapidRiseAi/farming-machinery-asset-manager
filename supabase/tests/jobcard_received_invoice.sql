\set ON_ERROR_STOP on
set client_min_messages to warning;
begin;

create function public._received_login(p_user uuid) returns void language sql as $$
 select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,false);
$$;
grant execute on function public._received_login(uuid) to authenticated;

insert into public.farms(id,name,plan,status) values
 ('9d000000-0000-4000-9000-000000000001','Received invoice farm','professional','active');
insert into public.workshops(id,name) values ('9d200000-0000-4000-9000-000000000001','Warranty supplier');
insert into public.workshop_links(farm_id,workshop_id,status,see_all_vehicles) values
 ('9d000000-0000-4000-9000-000000000001','9d200000-0000-4000-9000-000000000001','active',true);
insert into auth.users(id,email) values
 ('9d100000-0000-4000-9000-000000000001','received.owner@example.test'),
 ('9d100000-0000-4000-9000-000000000002','received.supplier@example.test');
insert into public.users(id,farm_id,role,name,workshop_id) values
 ('9d100000-0000-4000-9000-000000000001','9d000000-0000-4000-9000-000000000001','owner','Receiving owner',null),
 ('9d100000-0000-4000-9000-000000000002',null,'workshop','Supplier','9d200000-0000-4000-9000-000000000001');
insert into public.machines(id,farm_id,name,type,meter_type,status) values
 ('9d300000-0000-4000-9000-000000000001','9d000000-0000-4000-9000-000000000001','Warranty implement','implement','none','active');

set role authenticated;
select public._received_login('9d100000-0000-4000-9000-000000000001');
insert into public.work_requests(id,farm_id,machine_id,workshop_id,title) values
 ('9d700000-0000-4000-9000-000000000001','9d000000-0000-4000-9000-000000000001',
 '9d300000-0000-4000-9000-000000000001','9d200000-0000-4000-9000-000000000001','Warranty replacement');
select public.update_work_request('9d700000-0000-4000-9000-000000000001',p_status=>'accepted');
select public.convert_work_request_to_job_card('9d700000-0000-4000-9000-000000000001');

-- The receiving owner can retain a draft supplier document, but it cannot bill
-- unfinished work. The same draft will be retried after the work completes.
insert into public.partner_documents(id,farm_id,machine_id,workshop_id,work_request_id,
 kind,source,status,number,upload_path,subtotal_cents,vat_cents,total_cents,vat_rate_bps,created_by) values
 ('9d800000-0000-4000-9000-000000000001','9d000000-0000-4000-9000-000000000001',
 '9d300000-0000-4000-9000-000000000001','9d200000-0000-4000-9000-000000000001','9d700000-0000-4000-9000-000000000001',
 'invoice','uploaded','draft','I-RECEIVED-ZERO','fixture/warranty.pdf',0,0,0,1500,auth.uid());
do $$ begin
 begin
  update public.partner_documents set status='sent',sent_at=now() where id='9d800000-0000-4000-9000-000000000001';
  raise exception 'RECEIVED FAIL: billed unfinished work';
 exception when check_violation then null;
 end;
end $$;

select public._received_login('9d100000-0000-4000-9000-000000000002');
do $$ declare j uuid; begin
 select job_card_id into j from public.work_requests where id='9d700000-0000-4000-9000-000000000001';
 update public.job_cards set status='in_progress' where id=j;
 insert into public.job_card_lines(farm_id,job_card_id,kind,description,qty,unit_cost_cents)
 values('9d000000-0000-4000-9000-000000000001',j,'part','Replacement seal estimate',1,5000);
 update public.job_cards set work_performed='Replaced failed seal under warranty',status='completed',date_out=current_date where id=j;
end $$;

select public._received_login('9d100000-0000-4000-9000-000000000001');
do $$ begin
 if (select sum(amount_cents) from public.cost_entries where farm_id='9d000000-0000-4000-9000-000000000001' and deleted_at is null) is distinct from 5000::bigint then
  raise exception 'RECEIVED FAIL: unsent draft replaced the estimate'; end if;
end $$;
update public.partner_documents set status='sent',sent_at=now() where id='9d800000-0000-4000-9000-000000000001' and status='draft';
-- The API's stable receipt reuses this UUID and conditional finalization. Repeating
-- the finalization must neither produce another document nor book another cost.
update public.partner_documents set status='sent',sent_at=now() where id='9d800000-0000-4000-9000-000000000001' and status='draft';
do $$ begin
 if not exists(select 1 from public.partner_documents where id='9d800000-0000-4000-9000-000000000001'
  and number='I-RECEIVED-ZERO' and source='uploaded' and workshop_id='9d200000-0000-4000-9000-000000000001'
  and created_by=auth.uid()) then
  raise exception 'RECEIVED FAIL: filing a supplied invoice changed its number or issuer'; end if;
 -- Even a new capture cannot book the same printed supplier invoice a second time.
 begin
  insert into public.partner_documents(id,farm_id,machine_id,workshop_id,work_request_id,
   kind,source,status,number,upload_path,subtotal_cents,vat_cents,total_cents,vat_rate_bps,created_by) values
   ('9d800000-0000-4000-9000-000000000002','9d000000-0000-4000-9000-000000000001',
   '9d300000-0000-4000-9000-000000000001','9d200000-0000-4000-9000-000000000001','9d700000-0000-4000-9000-000000000001',
   'invoice','uploaded','draft','I-RECEIVED-ZERO','fixture/warranty-copy.pdf',0,0,0,1500,auth.uid());
  raise exception 'RECEIVED FAIL: duplicate supplier invoice number was accepted';
 exception when unique_violation then null;
 end;
 if not exists(select 1 from public.work_requests_visible where id='9d700000-0000-4000-9000-000000000001' and status='invoiced' and invoice_amount_cents=0) then
  raise exception 'RECEIVED FAIL: no-charge supplied invoice did not advance billing'; end if;
 if exists(select 1 from public.cost_entries where farm_id='9d000000-0000-4000-9000-000000000001' and deleted_at is null and amount_cents<>0) then
  raise exception 'RECEIVED FAIL: no-charge supplier bill retained estimated or duplicate charges'; end if;
 if (select count(*) from public.partner_documents where work_request_id='9d700000-0000-4000-9000-000000000001')<>1 then
  raise exception 'RECEIVED FAIL: repeated upload created duplicate documents'; end if;
 if (select count(*) from public.work_request_events where work_request_id='9d700000-0000-4000-9000-000000000001' and to_status='invoiced')<>1 then
  raise exception 'RECEIVED FAIL: repeated finalization billed the request twice'; end if;
end $$;
select public.update_work_request('9d700000-0000-4000-9000-000000000001',p_status=>'closed');
do $$ begin
 if not exists(select 1 from public.job_cards j join public.work_requests w on w.job_card_id=j.id
  where w.id='9d700000-0000-4000-9000-000000000001' and w.status='closed' and j.status='approved' and j.locked) then
  raise exception 'RECEIVED FAIL: owner could not approve and close no-charge supplier work'; end if;
end $$;
rollback;
