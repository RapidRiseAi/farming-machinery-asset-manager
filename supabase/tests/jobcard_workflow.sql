\set ON_ERROR_STOP on
set client_min_messages to warning;
begin;

create function public._jc_login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,false);
$$;
create function public._jc_denied(p_sql text) returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when check_violation or insufficient_privilege then return;
  end;
  raise exception 'WORKFLOW FAIL: unexpectedly allowed %',p_sql;
end $$;
grant execute on function public._jc_login(uuid),public._jc_denied(text) to authenticated;

insert into public.farms(id,name,plan,status) values
 ('9a000000-0000-4000-9000-000000000001','Workflow farm','professional','active');
insert into public.workshops(id,name) values
 ('9a200000-0000-4000-9000-000000000001','Assigned provider'),
 ('9a200000-0000-4000-9000-000000000002','Other provider');
insert into public.workshop_links(farm_id,workshop_id,status,see_all_vehicles) values
 ('9a000000-0000-4000-9000-000000000001','9a200000-0000-4000-9000-000000000001','active',true),
 ('9a000000-0000-4000-9000-000000000001','9a200000-0000-4000-9000-000000000002','active',true);
insert into auth.users(id,email) values
 ('9a100000-0000-4000-9000-000000000001','workflow.owner@example.test'),
 ('9a100000-0000-4000-9000-000000000002','workflow.mechanic@example.test'),
 ('9a100000-0000-4000-9000-000000000003','workflow.provider@example.test'),
 ('9a100000-0000-4000-9000-000000000004','workflow.other@example.test');
insert into public.users(id,farm_id,role,name,workshop_id) values
 ('9a100000-0000-4000-9000-000000000001','9a000000-0000-4000-9000-000000000001','owner','Owner',null),
 ('9a100000-0000-4000-9000-000000000002','9a000000-0000-4000-9000-000000000001','mechanic','Mechanic',null),
 ('9a100000-0000-4000-9000-000000000003',null,'workshop','Provider','9a200000-0000-4000-9000-000000000001'),
 ('9a100000-0000-4000-9000-000000000004',null,'workshop','Other','9a200000-0000-4000-9000-000000000002');
insert into public.machines(id,farm_id,name,type,meter_type,status) values
 ('9a300000-0000-4000-9000-000000000001','9a000000-0000-4000-9000-000000000001','Tractor','tractor','hours','active'),
 ('9a300000-0000-4000-9000-000000000002','9a000000-0000-4000-9000-000000000001','Implement','implement','none','active');
insert into public.job_cards(id,farm_id,machine_id,type,date_in,mechanic_user_id) values
 ('9a400000-0000-4000-9000-000000000001','9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000001','scheduled_service',current_date,'9a100000-0000-4000-9000-000000000002'),
 ('9a400000-0000-4000-9000-000000000002','9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000002','scheduled_service',current_date,'9a100000-0000-4000-9000-000000000002');
insert into public.service_plan_lines(id,farm_id,machine_id,task,interval_hours) values
 ('9a600000-0000-4000-9000-000000000001','9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000001','Oil service',250);
insert into public.job_card_service_lines(job_card_id,farm_id,machine_id,service_plan_line_id) values
 ('9a400000-0000-4000-9000-000000000001','9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000001','9a600000-0000-4000-9000-000000000001');

set role authenticated;
select public._jc_login('9a100000-0000-4000-9000-000000000002');
do $$ begin
 if app.job_card_worker('9a100000-0000-4000-9000-000000000001','9a400000-0000-4000-9000-000000000001') then
   raise exception 'WORKFLOW FAIL: worker helper accepted a different online actor'; end if;
end $$;
select public._jc_denied($q$insert into public.job_cards(farm_id,machine_id,type,status)
 values('9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000001','repair','approved')$q$);
select public._jc_denied($q$update public.job_cards set status='approved' where id='9a400000-0000-4000-9000-000000000001'$q$);
select public._jc_denied($q$update public.job_cards set status='completed',date_out=current_date where id='9a400000-0000-4000-9000-000000000001'$q$);
update public.job_cards set status='in_progress' where id in ('9a400000-0000-4000-9000-000000000001','9a400000-0000-4000-9000-000000000002');
update public.job_cards set work_performed='Replaced oil',recommendations='Inspect belts',meter_reading=100
 where id='9a400000-0000-4000-9000-000000000001';
insert into public.job_card_lines(id,farm_id,job_card_id,kind,description,qty,unit_cost_cents) values
 ('9a500000-0000-4000-9000-000000000001','9a000000-0000-4000-9000-000000000001','9a400000-0000-4000-9000-000000000001','part','Oil',2,10000);
update public.job_cards set status='completed',date_out=current_date where id='9a400000-0000-4000-9000-000000000001';
select public._jc_denied($q$update public.job_card_lines set qty=3 where id='9a500000-0000-4000-9000-000000000001'$q$);
select public._jc_denied($q$delete from public.job_card_service_lines where job_card_id='9a400000-0000-4000-9000-000000000001'$q$);
select public._jc_denied($q$update public.job_cards set diagnosis='Changed after review' where id='9a400000-0000-4000-9000-000000000001'$q$);
select public._jc_denied($q$update public.job_cards set status='in_progress',review_note='Repair leak' where id='9a400000-0000-4000-9000-000000000001'$q$);
-- A calendar-only machine never needs a fabricated meter value.
update public.job_cards set status='completed',date_out=current_date,work_performed='Greased pivots'
 where id='9a400000-0000-4000-9000-000000000002';

select public._jc_login('9a100000-0000-4000-9000-000000000001');
select public._jc_denied($q$update public.job_cards set status='in_progress' where id='9a400000-0000-4000-9000-000000000001'$q$);
update public.job_cards set status='in_progress',review_note='Correct the oil quantity'
 where id='9a400000-0000-4000-9000-000000000001';
select public._jc_login('9a100000-0000-4000-9000-000000000002');
update public.job_card_lines set qty=3 where id='9a500000-0000-4000-9000-000000000001';
update public.job_cards set status='completed',date_out=current_date where id='9a400000-0000-4000-9000-000000000001';
select public._jc_login('9a100000-0000-4000-9000-000000000001');
update public.job_cards set status='approved' where id='9a400000-0000-4000-9000-000000000001';
select public._jc_denied($q$update public.job_card_lines set job_card_id='9a400000-0000-4000-9000-000000000002' where id='9a500000-0000-4000-9000-000000000001'$q$);
select public._jc_denied($q$insert into public.cost_entries(farm_id,machine_id,type,amount_cents,source_type,source_id,occurred_on)
 values('9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000001','invoice',30000,'job_card','9a400000-0000-4000-9000-000000000001',current_date)$q$);

do $$ declare n int; j record; begin
 select * into j from public.job_cards_visible where id='9a400000-0000-4000-9000-000000000001';
 if not j.locked or j.approved_by is distinct from auth.uid() or j.approved_at is null or j.total_cents <> 30000 then
   raise exception 'WORKFLOW FAIL: approval failed to freeze the corrected job and totals'; end if;
 select count(*) into n from public.meter_readings where source_job_card_id=j.id;
 if n <> 1 then raise exception 'WORKFLOW FAIL: correction duplicated meter records (%)',n; end if;
 select count(*) into n from public.usage_logs where source_job_card_id=j.id;
 if n <> 1 then raise exception 'WORKFLOW FAIL: correction duplicated usage records (%)',n; end if;
 select count(*) into n from public.watch_items where source_job_card_id=j.id;
 if n <> 1 then raise exception 'WORKFLOW FAIL: correction duplicated recommendations (%)',n; end if;
end $$;

-- The farm requests work; only the chosen provider quotes and records the bill.
insert into public.faults(id,farm_id,machine_id,description,status) values
 ('9a900000-0000-4000-9000-000000000001','9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000001','Pump leak','acknowledged');
insert into public.work_requests(id,farm_id,machine_id,workshop_id,title,created_from_fault_id) values
 ('9a700000-0000-4000-9000-000000000001','9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000001','9a200000-0000-4000-9000-000000000001','Replace pump','9a900000-0000-4000-9000-000000000001');
select public._jc_denied($q$select public.convert_work_request_to_job_card('9a700000-0000-4000-9000-000000000001')$q$);
select public._jc_denied($q$select public.update_work_request('9a700000-0000-4000-9000-000000000001',p_quote_cents=>100000)$q$);
select public._jc_login('9a100000-0000-4000-9000-000000000003');
select public.update_work_request('9a700000-0000-4000-9000-000000000001',p_quote_cents=>100000,p_note=>'Pump and labour');
select public._jc_denied($q$select public.update_work_request('9a700000-0000-4000-9000-000000000001',p_status=>'accepted')$q$);
select public._jc_login('9a100000-0000-4000-9000-000000000001');
select public.update_work_request('9a700000-0000-4000-9000-000000000001',p_status=>'accepted');
do $$ declare j uuid; j2 uuid; begin
 j := public.convert_work_request_to_job_card('9a700000-0000-4000-9000-000000000001');
 j2 := public.convert_work_request_to_job_card('9a700000-0000-4000-9000-000000000001');
 if j is distinct from j2 then raise exception 'WORKFLOW FAIL: repeat conversion created another card'; end if;
 if not exists(select 1 from public.faults where id='9a900000-0000-4000-9000-000000000001' and job_card_id=j and status='in_job') then
   raise exception 'WORKFLOW FAIL: contractor conversion lost the acknowledged source fault'; end if;
 perform public._jc_denied(format('update public.job_cards set work_performed=''Farm forged provider work'' where id=%L',j));
end $$;
select public._jc_login('9a100000-0000-4000-9000-000000000003');
do $$ declare j uuid; begin
 select job_card_id into j from public.work_requests where id='9a700000-0000-4000-9000-000000000001';
 insert into public.job_card_lines(farm_id,job_card_id,kind,description,qty,unit_cost_cents)
 values('9a000000-0000-4000-9000-000000000001',j,'part','Pump',1,100000);
 update public.job_cards set status='in_progress',work_performed='Pump replaced' where id=j;
 perform public._jc_denied($q$select public.update_work_request('9a700000-0000-4000-9000-000000000001',p_status=>'completed')$q$);
 update public.job_cards set status='completed',date_out=current_date where id=j;
end $$;
select public._jc_login('9a100000-0000-4000-9000-000000000001');
select public._jc_denied($q$select public.update_work_request('9a700000-0000-4000-9000-000000000001',p_status=>'closed')$q$);
select public._jc_denied($q$select public.update_work_request('9a700000-0000-4000-9000-000000000001',p_invoice_cents=>120000)$q$);
select public._jc_login('9a100000-0000-4000-9000-000000000003');
select public.update_work_request('9a700000-0000-4000-9000-000000000001',p_invoice_cents=>120000,p_note=>'Final supplier bill');
select public._jc_login('9a100000-0000-4000-9000-000000000001');
do $$ declare n bigint; begin
 select sum(c.amount_cents) into n from public.cost_entries c where c.deleted_at is null and (
  (c.source_type='work_request' and c.source_id='9a700000-0000-4000-9000-000000000001')
  or (c.source_type='job_card_line' and c.source_id in(select l.id from public.job_card_lines l
      join public.work_requests w on w.job_card_id=l.job_card_id where w.id='9a700000-0000-4000-9000-000000000001')));
 if n <> 120000 then raise exception 'WORKFLOW FAIL: external work double counted (%)',n; end if;
end $$;
-- The receiving farm retains review rights after disconnecting the supplier.
update public.workshop_links set status='revoked' where workshop_id='9a200000-0000-4000-9000-000000000001';
select public.update_work_request('9a700000-0000-4000-9000-000000000001',p_status=>'closed');
update public.workshop_links set status='active' where workshop_id='9a200000-0000-4000-9000-000000000001';
do $$ begin
 if not exists(select 1 from public.job_cards j join public.work_requests w on w.job_card_id=j.id
   where w.id='9a700000-0000-4000-9000-000000000001' and w.status='closed' and j.status='approved' and j.locked) then
   raise exception 'WORKFLOW FAIL: closing external work did not approve its job card'; end if;
end $$;

-- A linked provider does not gain edit rights to a different team's records.
select public._jc_login('9a100000-0000-4000-9000-000000000004');
select public._jc_denied($q$update public.job_cards set diagnosis='Other provider changed this'
 where id='9a400000-0000-4000-9000-000000000002'$q$);

-- The full document route advances the same request instead of leaving its
-- acceptance/invoice controls stuck behind a status that never changed.
select public._jc_login('9a100000-0000-4000-9000-000000000001');
insert into public.work_requests(id,farm_id,machine_id,workshop_id,title) values
 ('9a700000-0000-4000-9000-000000000002','9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000001','9a200000-0000-4000-9000-000000000001','Replace belt');
select public._jc_login('9a100000-0000-4000-9000-000000000003');
insert into public.partner_documents(id,farm_id,machine_id,workshop_id,work_request_id,
 kind,source,status,number,upload_path,subtotal_cents,vat_rate_bps,created_by) values
 ('9a800000-0000-4000-9000-000000000001','9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000001',
 '9a200000-0000-4000-9000-000000000001','9a700000-0000-4000-9000-000000000002',
 'quote','uploaded','sent','Q-WORKFLOW-1','fixture/quote.pdf',50000,0,auth.uid());
select public._jc_login('9a100000-0000-4000-9000-000000000001');
select public._jc_denied($q$select public.update_work_request('9a700000-0000-4000-9000-000000000002',p_status=>'accepted')$q$);
update public.partner_documents set status='accepted',accepted_at=now() where id='9a800000-0000-4000-9000-000000000001';
do $$ declare s work_request_status; begin
 select status into s from public.work_requests where id='9a700000-0000-4000-9000-000000000002';
 if s <> 'accepted' then raise exception 'WORKFLOW FAIL: accepted quote did not authorize work'; end if;
end $$;
select public._jc_login('9a100000-0000-4000-9000-000000000003');
select public.update_work_request('9a700000-0000-4000-9000-000000000002',p_status=>'in_progress');
select public.update_work_request('9a700000-0000-4000-9000-000000000002',p_status=>'completed');
select public._jc_login('9a100000-0000-4000-9000-000000000001');
select public._jc_denied($q$insert into public.partner_documents(farm_id,machine_id,workshop_id,work_request_id,
 kind,source,status,number,subtotal_cents,vat_rate_bps,created_by) values
 ('9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000001',
 '9a200000-0000-4000-9000-000000000001','9a700000-0000-4000-9000-000000000002',
 'invoice','built','sent','I-FARM-FORGED',50000,0,auth.uid())$q$);
insert into public.partner_documents(id,farm_id,machine_id,workshop_id,work_request_id,
 kind,source,status,number,upload_path,subtotal_cents,vat_rate_bps,created_by) values
 ('9a800000-0000-4000-9000-000000000002','9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000001',
 '9a200000-0000-4000-9000-000000000001','9a700000-0000-4000-9000-000000000002',
 'invoice','uploaded','sent','I-WORKFLOW-1','fixture/invoice.pdf',50000,0,auth.uid());
do $$ declare s work_request_status; n bigint; begin
 select status into s from public.work_requests where id='9a700000-0000-4000-9000-000000000002';
 if s <> 'invoiced' then raise exception 'WORKFLOW FAIL: supplied invoice did not advance work'; end if;
 select sum(amount_cents) into n from public.cost_entries where deleted_at is null
   and source_type in ('partner_document','work_request')
   and source_id in ('9a800000-0000-4000-9000-000000000002','9a700000-0000-4000-9000-000000000002');
 if n <> 50000 then raise exception 'WORKFLOW FAIL: supplied invoice double counted (%)',n; end if;
end $$;

-- An externally scheduled service must retain its service requirements.
-- Multiple supplier invoices aggregate, and voiding them never revives an old
-- request amount as a second source of costs.
insert into public.partner_documents(id,farm_id,machine_id,workshop_id,work_request_id,
 kind,source,status,number,upload_path,subtotal_cents,vat_rate_bps,created_by) values
 ('9a800000-0000-4000-9000-000000000003','9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000001',
 '9a200000-0000-4000-9000-000000000001','9a700000-0000-4000-9000-000000000002',
 'invoice','uploaded','sent','I-WORKFLOW-2','fixture/invoice2.pdf',25000,0,auth.uid());
do $$ begin
 if (select invoice_amount_cents from public.work_requests_visible where id='9a700000-0000-4000-9000-000000000002')<>75000 then
   raise exception 'WORKFLOW FAIL: invoice total is only the last invoice'; end if;
end $$;
update public.partner_documents set status='void',void_reason='Duplicate bill' where id='9a800000-0000-4000-9000-000000000002';
do $$ begin
 if (select invoice_amount_cents from public.work_requests_visible where id='9a700000-0000-4000-9000-000000000002')<>25000 then
   raise exception 'WORKFLOW FAIL: voided bill remains in request amount'; end if;
end $$;
update public.partner_documents set status='void',void_reason='Duplicate bill' where id='9a800000-0000-4000-9000-000000000003';
do $$ begin
 if not exists(select 1 from public.work_requests_visible where id='9a700000-0000-4000-9000-000000000002' and status='completed' and invoice_amount_cents is null) then
   raise exception 'WORKFLOW FAIL: all invoices void but request still billed'; end if;
 if exists(select 1 from public.cost_entries where source_type='work_request' and source_id='9a700000-0000-4000-9000-000000000002' and deleted_at is null) then
   raise exception 'WORKFLOW FAIL: void revived a duplicate request cost'; end if;
end $$;
insert into public.work_requests(id,farm_id,machine_id,workshop_id,title,job_card_type) values
 ('9a700000-0000-4000-9000-000000000003','9a000000-0000-4000-9000-000000000001','9a300000-0000-4000-9000-000000000001','9a200000-0000-4000-9000-000000000001','250 hour service','scheduled_service');
select public.update_work_request('9a700000-0000-4000-9000-000000000003',p_status=>'accepted');
do $$ declare j uuid; begin
 j := public.convert_work_request_to_job_card('9a700000-0000-4000-9000-000000000003');
 if not exists(select 1 from public.job_cards where id=j and type='scheduled_service') then
   raise exception 'WORKFLOW FAIL: contractor conversion lost the scheduled service type'; end if;
end $$;

reset role;
select set_config('request.jwt.claims','',false);
-- No-charge invoices are authoritative too: they remove estimated line costs.
update public.work_requests set invoice_amount_cents=0 where id='9a700000-0000-4000-9000-000000000001';
do $$ declare n int; begin
 select count(*) into n from public.cost_entries c where c.deleted_at is null and
 c.source_type='job_card_line' and c.source_id in(select l.id from public.job_card_lines l
   join public.work_requests w on w.job_card_id=l.job_card_id where w.id='9a700000-0000-4000-9000-000000000001');
 if n <> 0 then raise exception 'WORKFLOW FAIL: no-charge invoice retained estimated costs'; end if;
end $$;
rollback;
