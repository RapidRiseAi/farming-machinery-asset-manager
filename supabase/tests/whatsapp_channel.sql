\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',false);
insert into public.farms(id,name,plan,status) values
 ('fa000000-0000-0000-0000-000000000001','WhatsApp A','complete','active'),
 ('fa000000-0000-0000-0000-000000000002','WhatsApp B','complete','active');
insert into auth.users(id,email) values
 ('fa100000-0000-0000-0000-000000000001','wa-a@example.test'),
 ('fa100000-0000-0000-0000-000000000002','wa-b@example.test');
insert into public.users(id,farm_id,role,name,email) values
 ('fa100000-0000-0000-0000-000000000001','fa000000-0000-0000-0000-000000000001','owner','A','wa-a@example.test'),
 ('fa100000-0000-0000-0000-000000000002','fa000000-0000-0000-0000-000000000002','owner','B','wa-b@example.test');
insert into public.user_farm_memberships(user_id,farm_id,role) values
 ('fa100000-0000-0000-0000-000000000001','fa000000-0000-0000-0000-000000000001','owner'),
 ('fa100000-0000-0000-0000-000000000001','fa000000-0000-0000-0000-000000000002','manager');
insert into public.machines(id,farm_id,name,type,meter_type) values
 ('fa200000-0000-0000-0000-000000000001','fa000000-0000-0000-0000-000000000001','A tractor','tractor','hours'),
 ('fa200000-0000-0000-0000-000000000002','fa000000-0000-0000-0000-000000000002','B tractor','tractor','hours');

do $$ begin
 if has_table_privilege('authenticated','public.whatsapp_links','SELECT')
   or has_table_privilege('authenticated','public.whatsapp_link_challenges','INSERT')
   or has_table_privilege('anon','public.whatsapp_inbox','SELECT')
   or has_function_privilege('authenticated','public.whatsapp_verify_link(text,text)','EXECUTE')
   or has_function_privilege('anon','public.whatsapp_finish_link(uuid)','EXECUTE') then
   raise exception 'WhatsApp private identity/queue data exposed'; end if;
end $$;

set role authenticated;
select set_config('request.jwt.claims','{"sub":"fa100000-0000-0000-0000-000000000001","role":"authenticated"}',false);
select public.whatsapp_begin_link('fa000000-0000-0000-0000-000000000001','27820000001',repeat('a',64),true,true);
reset role;
do $$ declare c uuid; denied boolean:=false; begin
 select id into c from public.whatsapp_link_challenges where token_hash=repeat('a',64);
 begin perform public.whatsapp_finish_link(c); exception when insufficient_privilege then denied:=true; end;
 if not denied then raise exception 'Unverified number linked'; end if;
 if public.whatsapp_verify_link(repeat('a',64),'27820000002') then raise exception 'Wrong phone verified'; end if;
 if not public.whatsapp_verify_link(repeat('a',64),'27820000001') then raise exception 'Correct phone refused'; end if;
 perform public.whatsapp_finish_link(c);
 denied:=false;
 begin perform public.whatsapp_finish_link(c); exception when insufficient_privilege then denied:=true; end;
 if not denied then raise exception 'Link code replayed'; end if;
end $$;

-- Delivery workers have no browser identity; membership must resolve from the link.
select set_config('request.jwt.claims','{"role":"service_role"}',false);
set role service_role;
do $$ declare target jsonb; begin
 select public.whatsapp_delivery_target(id) into target from public.whatsapp_links where phone='27820000001';
 if target is null or target->>'user_id' is distinct from 'fa100000-0000-0000-0000-000000000001' then
   raise exception 'Service worker could not resolve the verified identity without a browser session'; end if;
end $$;
reset role;

-- Another logged-in account cannot finish our challenge or take an active number.
select set_config('request.jwt.claims','{"sub":"fa100000-0000-0000-0000-000000000002","role":"authenticated"}',false);
do $$ declare c uuid; denied boolean:=false; begin
 select id into c from public.whatsapp_link_challenges where token_hash=repeat('a',64);
 begin perform public.whatsapp_finish_link(c); exception when insufficient_privilege then denied:=true; end;
 if not denied then raise exception 'Other user finished challenge'; end if;
 c:=public.whatsapp_begin_link('fa000000-0000-0000-0000-000000000002','27820000001',repeat('b',64),true,true);
 perform public.whatsapp_verify_link(repeat('b',64),'27820000001');
 denied:=false;
 begin perform public.whatsapp_finish_link(c); exception when unique_violation then denied:=true; end;
 if not denied then raise exception 'Number stolen from other account'; end if;
end $$;

-- Role-scoped JWT resolves only the pinned farm, despite genuine membership in both.
select set_config('request.jwt.claims',jsonb_build_object('sub','fa100000-0000-0000-0000-000000000001',
 'role','authenticated','fw_channel','whatsapp','fw_farm_id','fa000000-0000-0000-0000-000000000001',
 'fw_link_id',(select id from public.whatsapp_links where phone='27820000001' and revoked_at is null))::text,false);
set role authenticated;
do $$ begin
 if (select count(*) from public.machines where id in ('fa200000-0000-0000-0000-000000000001','fa200000-0000-0000-0000-000000000002'))<>1
   then raise exception 'WhatsApp cross-farm read'; end if;
 if exists(select 1 from public.users where id='fa100000-0000-0000-0000-000000000002') then raise exception 'WhatsApp other-user read'; end if;
 if public.whatsapp_assistant_role('fa000000-0000-0000-0000-000000000001')<>'owner'
   or public.whatsapp_assistant_role('fa000000-0000-0000-0000-000000000002') is not null then
   raise exception 'WhatsApp farm role widened'; end if;
 begin
   perform public.whatsapp_manage_link('authorize');
   raise exception 'WhatsApp token renewed itself';
 exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Revoked primary membership must not fall back to the legacy users.farm_id grant.
update public.user_farm_memberships set active=false where user_id='fa100000-0000-0000-0000-000000000001'
 and farm_id='fa000000-0000-0000-0000-000000000001';
set role authenticated;
do $$ begin
 if exists(select 1 from public.machines where id='fa200000-0000-0000-0000-000000000001')
   or app.effective_farm_role(auth.uid(),'fa000000-0000-0000-0000-000000000001') is not null then
   raise exception 'Revoked membership still authorized'; end if;
end $$;
reset role;
update public.user_farm_memberships set active=true where user_id='fa100000-0000-0000-0000-000000000001';

-- Live operator permissions are the same as the web agent, including machine assignment.
update public.user_farm_memberships set role='operator' where user_id='fa100000-0000-0000-0000-000000000001'
 and farm_id='fa000000-0000-0000-0000-000000000001';
set role authenticated;
do $$ begin
 if exists(select 1 from public.machines where id='fa200000-0000-0000-0000-000000000001') then
   raise exception 'Operator read an unassigned machine'; end if;
end $$;
reset role;
update public.user_farm_memberships set role='owner' where user_id='fa100000-0000-0000-0000-000000000001';

-- WhatsApp uses the real shared operational confirmation, including idempotent replay.
insert into public.ai_interactions(id,farm_id,user_id,channel,locale,route_tier,intent,tool_name,tool_args,
 confirmation_status,result_status,proposal_expires_at) values
 ('fa400000-0000-4000-8000-000000000001','fa000000-0000-0000-0000-000000000001',
  'fa100000-0000-0000-0000-000000000001','whatsapp','en-ZA',1,'report_fault','report_fault',
  jsonb_build_object('intent','report_fault','machineQuery',null,'machineId','fa200000-0000-0000-0000-000000000001',
    'description','WhatsApp exactly once','category',null,'urgency','can_work','reading',null,'readingDate',null,
    'serviceDate',null,'workPerformed',null,'confidence',1),'pending','proposed',now()+interval '15 minutes');
set role authenticated;
do $$ declare first_result jsonb; replay jsonb; begin
 first_result:=public.apply_assistant_proposal('fa400000-0000-4000-8000-000000000001','confirm','fa000000-0000-0000-0000-000000000001');
 replay:=public.apply_assistant_proposal('fa400000-0000-4000-8000-000000000001','confirm','fa000000-0000-0000-0000-000000000001');
 if first_result->>'ok'<>'true' or replay->>'replayed'<>'true'
    or first_result->>'linkedRecordId' is distinct from replay->>'linkedRecordId' then
   raise exception 'Shared WhatsApp confirmation failed or duplicated: % / %',first_result,replay;
 end if;
 begin
   perform public.apply_assistant_proposal('fa400000-0000-4000-8000-000000000001','confirm','fa000000-0000-0000-0000-000000000002');
   raise exception 'WhatsApp crossed pinned farm in SECURITY DEFINER confirmation';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
 if (select count(*) from public.faults where description='WhatsApp exactly once')<>1 then raise exception 'WhatsApp confirmation wrote twice'; end if;
end $$;

-- Queued message deduplication and per-person processing serialization.
set role service_role;
select public.whatsapp_receive('wa-message-1','27820000001','status',now());
select public.whatsapp_receive('wa-message-1','27820000001','status',now());
-- Distinct provider timestamps make chronological order explicit; now() is constant in this transaction.
select public.whatsapp_receive('wa-message-2','27820000001','another request',now()+interval '1 second');
do $$ declare i public.whatsapp_inbox; lease uuid:=gen_random_uuid(); tag text; begin
 if (select count(*) from public.whatsapp_inbox where provider_id='wa-message-1')<>1 then raise exception 'Webhook duplicated'; end if;
 select * into i from public.whatsapp_claim(lease);
 if i.provider_id is distinct from 'wa-message-1' then raise exception 'Queue ordering'; end if;
 if exists(select 1 from public.whatsapp_claim(gen_random_uuid())) then raise exception 'Concurrent conversation claimed'; end if;
 if public.whatsapp_save_reply(i.id,gen_random_uuid(),'bad','{}','permissions') then raise exception 'Unrelated worker changed conversation'; end if;
 tag:=public.whatsapp_delivery_target(i.link_id)->>'authority_tag';
 if tag is null then raise exception 'Missing live authority fingerprint'; end if;
 if not public.whatsapp_save_reply(i.id,lease,'ok','{}',tag) then raise exception 'Owning worker could not save'; end if;
 if (select conversation_authority_tag from public.whatsapp_links where id=i.link_id) is distinct from tag then
   raise exception 'Conversation lost its authorization context'; end if;
end $$;
reset role;

-- Demotion invalidates a cached proposal even while the number remains linked.
update public.user_farm_memberships set role='mechanic' where user_id='fa100000-0000-0000-0000-000000000001'
 and farm_id='fa000000-0000-0000-0000-000000000001';
do $$ declare l public.whatsapp_links; begin
 select * into l from public.whatsapp_links where phone='27820000001';
 if public.whatsapp_delivery_target(l.id)->>'authority_tag' is not distinct from l.conversation_authority_tag then
   raise exception 'Role change retained cached conversation authority'; end if;
end $$;
update public.user_farm_memberships set role='owner' where user_id='fa100000-0000-0000-0000-000000000001';

-- Link expiry blocks reads immediately without waiting for JWT expiry.
update public.whatsapp_links set assistant_until=now()-interval '1 second' where phone='27820000001';
set role authenticated;
do $$ begin
 if exists(select 1 from public.machines where id='fa200000-0000-0000-0000-000000000001') then raise exception 'Expired assistant session reads'; end if;
end $$;
reset role;
update public.whatsapp_links set assistant_until=now()+interval '1 hour' where phone='27820000001';

-- Assignment event targets the actual employee, and only once per changed assignment.
select set_config('request.jwt.claims','',false);
insert into public.job_cards(id,farm_id,machine_id,type,mechanic_user_id) values
 ('fa300000-0000-0000-0000-000000000001','fa000000-0000-0000-0000-000000000001',
  'fa200000-0000-0000-0000-000000000001','repair','fa100000-0000-0000-0000-000000000001');
update public.job_cards set mechanic_user_id=mechanic_user_id where id='fa300000-0000-0000-0000-000000000001';
do $$ begin
 if (select count(*) from public.notifications where template='job_assigned'
   and payload->>'job_card_id'='fa300000-0000-0000-0000-000000000001')<>1 then raise exception 'Assignment notification duplicate or absent'; end if;
end $$;

-- STOP revokes both features; an old delegated token is immediately useless.
set role service_role;
select public.whatsapp_receive('stop-message','27820000001','STOP',now());
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub','fa100000-0000-0000-0000-000000000001',
 'role','authenticated','fw_channel','whatsapp','fw_farm_id','fa000000-0000-0000-0000-000000000001',
 'fw_link_id',(select id from public.whatsapp_links where phone='27820000001'))::text,false);
set role authenticated;
do $$ begin
 if exists(select 1 from public.machines where id='fa200000-0000-0000-0000-000000000001')
   or app.effective_farm_role(auth.uid(),'fa000000-0000-0000-0000-000000000001') is not null then raise exception 'STOP failed to revoke'; end if;
 begin
   perform public.apply_assistant_proposal('fa400000-0000-4000-8000-000000000001','confirm','fa000000-0000-0000-0000-000000000001');
   raise exception 'Revoked WhatsApp replay returned protected result';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
-- New transport identities keep the production boundary between test and real farms.
select set_config('request.jwt.claims','',false);
insert into public.farms(id,name,plan,status,is_test) values
 ('fa000000-0000-0000-0000-000000000003','WhatsApp test farm','complete','active',true);
insert into auth.users(id,email) values
 ('fa100000-0000-0000-0000-000000000003','wa-test@example.test');
insert into public.users(id,farm_id,role,name,email) values
 ('fa100000-0000-0000-0000-000000000003','fa000000-0000-0000-0000-000000000003','owner','Test','wa-test@example.test');
do $$ begin
 if app.whatsapp_member('fa100000-0000-0000-0000-000000000003','fa000000-0000-0000-0000-000000000001') then
   raise exception 'Test identity resolved on a real farm'; end if;
 begin
   insert into public.whatsapp_links(user_id,farm_id,phone) values
     ('fa100000-0000-0000-0000-000000000003','fa000000-0000-0000-0000-000000000001','27820000003');
   raise exception 'Test identity linked to a real farm';
 exception when insufficient_privilege then null; end;
 begin
   insert into public.whatsapp_link_challenges(user_id,farm_id,phone,token_hash,notifications_enabled,assistant_enabled) values
     ('fa100000-0000-0000-0000-000000000001','fa000000-0000-0000-0000-000000000003','27820000004',repeat('f',64),true,true);
   raise exception 'Real identity challenged against a test farm';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
