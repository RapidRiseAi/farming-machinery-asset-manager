\set ON_ERROR_STOP on
begin;
set client_min_messages to warning;
select set_config('request.jwt.claims','',false);
insert into farms(id,name,plan,status) values ('9f000000-0000-4000-9000-000000000001','Receipt test','professional','active');
insert into auth.users(id,email) values ('9f100000-0000-4000-9000-000000000001','receipt.owner@example.test');
insert into users(id,farm_id,role,name) values ('9f100000-0000-4000-9000-000000000001','9f000000-0000-4000-9000-000000000001','owner','Receipt owner');
insert into machines(id,farm_id,name,type,meter_type,status) values ('9f200000-0000-4000-9000-000000000001','9f000000-0000-4000-9000-000000000001','Receipt asset','tractor','none','active');
insert into workshops(id,name) values ('9f500000-0000-4000-9000-000000000001','Receipt supplier');
insert into workshop_links(farm_id,workshop_id,status,see_all_vehicles,see_costs) values
 ('9f000000-0000-4000-9000-000000000001','9f500000-0000-4000-9000-000000000001','active',true,true);
insert into auth.users(id,email) values ('9f100000-0000-4000-9000-000000000002','receipt.provider@example.test');
insert into users(id,workshop_id,role,name) values
 ('9f100000-0000-4000-9000-000000000002','9f500000-0000-4000-9000-000000000001','workshop','Receipt provider');
insert into job_cards(id,farm_id,machine_id,type,status,work_mode,external_provider_name,date_in,work_performed) values
  ('9f300000-0000-4000-9000-000000000001','9f000000-0000-4000-9000-000000000001','9f200000-0000-4000-9000-000000000001','repair','open','internal',null,current_date,'Fixed internally'),
  ('9f300000-0000-4000-9000-000000000002','9f000000-0000-4000-9000-000000000001','9f200000-0000-4000-9000-000000000001','repair','open','external','Outside Repairs',current_date,'Replaced pump');
insert into job_cards(id,farm_id,machine_id,type,status,work_mode,workshop_id,date_in,date_out,work_performed) values
 ('9f300000-0000-4000-9000-000000000003','9f000000-0000-4000-9000-000000000001','9f200000-0000-4000-9000-000000000001','repair','completed','external','9f500000-0000-4000-9000-000000000001',current_date,current_date,'Supplier work');
set role authenticated;
select set_config('request.jwt.claims','{"sub":"9f100000-0000-4000-9000-000000000001","role":"authenticated"}',false);

do $$ declare v_rejected boolean; v_count integer; begin
  perform record_job_card_media('9f300000-0000-4000-9000-000000000001','9f400000-0000-4000-9000-000000000001','photo',
    '9f000000-0000-4000-9000-000000000001/9f300000-0000-4000-9000-000000000001/photo-9f400000-0000-4000-9000-000000000001.image');
  -- Retrying a capture after losing its response creates exactly one attachment.
  perform record_job_card_media('9f300000-0000-4000-9000-000000000001','9f400000-0000-4000-9000-000000000001','photo',
    '9f000000-0000-4000-9000-000000000001/9f300000-0000-4000-9000-000000000001/photo-9f400000-0000-4000-9000-000000000001.image');
  select count(*) into v_count from attachments where parent_id='9f300000-0000-4000-9000-000000000001';
  if v_count <> 1 then raise exception 'Duplicate photo receipt'; end if;
  v_rejected := false;
  begin
    perform record_job_card_media('9f300000-0000-4000-9000-000000000001','9f400000-0000-4000-9000-000000000002','invoice',
      '9f000000-0000-4000-9000-000000000001/9f300000-0000-4000-9000-000000000001/invoice-9f400000-0000-4000-9000-000000000002.pdf',1000,'Own invoice');
  exception when check_violation then v_rejected:=true; end;
  if not v_rejected then raise exception 'Internal invoice accepted'; end if;
  v_rejected := false;
  begin
    perform record_job_card_media('9f300000-0000-4000-9000-000000000002','9f400000-0000-4000-9000-000000000002','invoice',
      '9f000000-0000-4000-9000-000000000001/9f300000-0000-4000-9000-000000000002/invoice-9f400000-0000-4000-9000-000000000002.pdf',1000,'Early bill');
  exception when check_violation then v_rejected:=true; end;
  if not v_rejected then raise exception 'Premature invoice accepted'; end if;
end $$;

update job_cards set status='in_progress' where id='9f300000-0000-4000-9000-000000000002';
insert into job_card_lines(farm_id,job_card_id,kind,description,qty,unit_cost_cents) values
 ('9f000000-0000-4000-9000-000000000001','9f300000-0000-4000-9000-000000000002','part','Pump',1,800);
update job_cards set status='completed',date_out=current_date where id='9f300000-0000-4000-9000-000000000002';
update job_cards set status='approved',locked=true,approved_by=auth.uid(),approved_at=now() where id='9f300000-0000-4000-9000-000000000002';
do $$ declare v_count integer; v_sum bigint; v_rejected boolean:=false; begin
  begin
    perform record_job_card_media('9f300000-0000-4000-9000-000000000002','9f400000-0000-4000-9000-000000000004','invoice',
      '9f000000-0000-4000-9000-000000000001/9f300000-0000-4000-9000-000000000002/invoice-9f400000-0000-4000-9000-000000000004.pdf',null,'Amount missing');
  exception when check_violation then v_rejected:=true; end;
  if not v_rejected then raise exception 'Outside supplier invoice accepted without its amount'; end if;
  if exists(select 1 from attachments where id='9f400000-0000-4000-9000-000000000004') then
    raise exception 'Missing amount left a partial invoice attachment'; end if;
  perform record_job_card_media('9f300000-0000-4000-9000-000000000002','9f400000-0000-4000-9000-000000000005','invoice',
    '9f000000-0000-4000-9000-000000000001/9f300000-0000-4000-9000-000000000002/invoice-9f400000-0000-4000-9000-000000000005.pdf',0,'No charge');
  select sum(amount_cents) into v_sum from cost_entries where machine_id='9f200000-0000-4000-9000-000000000001' and deleted_at is null;
  if v_sum<>0 then raise exception 'No-charge supplier bill retained estimated costs: %',v_sum; end if;
  v_rejected:=false;
  perform record_job_card_media('9f300000-0000-4000-9000-000000000002','9f400000-0000-4000-9000-000000000003','invoice',
    '9f000000-0000-4000-9000-000000000001/9f300000-0000-4000-9000-000000000002/invoice-9f400000-0000-4000-9000-000000000003.pdf',1000,'Supplier INV-1');
  perform record_job_card_media('9f300000-0000-4000-9000-000000000002','9f400000-0000-4000-9000-000000000003','invoice',
    '9f000000-0000-4000-9000-000000000001/9f300000-0000-4000-9000-000000000002/invoice-9f400000-0000-4000-9000-000000000003.pdf',1000,'Supplier INV-1');
  select count(*) into v_count from cost_entries where id='9f400000-0000-4000-9000-000000000003';
  if v_count<>1 then raise exception 'Invoice retry doubled cost'; end if;
  select sum(amount_cents) into v_sum from cost_entries where machine_id='9f200000-0000-4000-9000-000000000001' and deleted_at is null;
  if v_sum<>1000 then raise exception 'Invoice and component work double counted: %',v_sum; end if;
  begin
    perform record_job_card_media('9f300000-0000-4000-9000-000000000002','9f400000-0000-4000-9000-000000000003','invoice',
      '9f000000-0000-4000-9000-000000000001/9f300000-0000-4000-9000-000000000002/invoice-9f400000-0000-4000-9000-000000000003.pdf',9999,'Changed capture');
  exception when check_violation then v_rejected:=true; end;
  if not v_rejected then raise exception 'Capture silently accepted changed amount'; end if;
end $$;
-- Receiving farms can file a connected supplier's proof without authoring its
-- amount. The assigned standalone supplier still has to record its final total.
select record_job_card_media('9f300000-0000-4000-9000-000000000003','9f400000-0000-4000-9000-000000000006','invoice',
 '9f000000-0000-4000-9000-000000000001/9f300000-0000-4000-9000-000000000003/invoice-9f400000-0000-4000-9000-000000000006.pdf',null,'Received supplier proof');
select set_config('request.jwt.claims','{"sub":"9f100000-0000-4000-9000-000000000002","role":"authenticated"}',false);
do $$ declare rejected boolean:=false; begin
 begin
   perform record_job_card_media('9f300000-0000-4000-9000-000000000003','9f400000-0000-4000-9000-000000000007','invoice',
     '9f000000-0000-4000-9000-000000000001/9f300000-0000-4000-9000-000000000003/invoice-9f400000-0000-4000-9000-000000000007.pdf');
 exception when check_violation then rejected:=true; end;
 if not rejected then raise exception 'Standalone supplier invoice omitted its final amount'; end if;
 perform record_job_card_media('9f300000-0000-4000-9000-000000000003','9f400000-0000-4000-9000-000000000007','invoice',
   '9f000000-0000-4000-9000-000000000001/9f300000-0000-4000-9000-000000000003/invoice-9f400000-0000-4000-9000-000000000007.pdf',0,'Warranty: no charge');
end $$;
reset role;
do $$ begin
  if has_function_privilege('anon','public.record_job_card_media(uuid,uuid,text,text,bigint,text)','execute') then raise exception 'Anonymous media mutation grant'; end if;
end $$;
rollback;
