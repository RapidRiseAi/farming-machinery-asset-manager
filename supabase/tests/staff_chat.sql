\set ON_ERROR_STOP on
set client_min_messages to warning;
begin;
select set_config('request.jwt.claims','',true);
insert into public.farms(id,name,plan,status,billing_period) values
 ('bc000000-0000-4000-9000-000000000001','Chat A','essential','active','monthly'),
 ('bc000000-0000-4000-9000-000000000002','Chat B','essential','active','monthly');
insert into auth.users(id,email) select ('bc100000-0000-4000-9000-00000000000'||n)::uuid,'chat'||n||'@example.test' from generate_series(1,6)n;
insert into public.users(id,farm_id,role,name,email,active)
select ('bc100000-0000-4000-9000-00000000000'||n)::uuid,
 ('bc000000-0000-4000-9000-00000000000'||case when n=5 then 2 else 1 end)::uuid,
 case when n in (1,5) then 'owner'::public.user_role else 'operator'::public.user_role end,
 'Person '||n,'chat'||n||'@example.test',true from generate_series(1,6)n;
create function pg_temp.login(n integer) returns void language sql as $$
 select set_config('request.jwt.claims',jsonb_build_object('sub','bc100000-0000-4000-9000-00000000000'||n,'role','authenticated','aal','aal2')::text,true);
$$;
create function pg_temp.assert(ok boolean,reason text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'CHAT: %',reason; end if; end $$;
create function public._chat_refused(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when insufficient_privilege then return true; end $$;
grant execute on function public._chat_refused(text) to authenticated;
select pg_temp.login(2);
set local role authenticated;
select pg_temp.assert(public._chat_refused($q$select public.chat_create('bc200000-0000-4000-9000-000000000001','bc000000-0000-4000-9000-000000000001','group','Private',array['bc100000-0000-4000-9000-000000000003'::uuid])$q$),'readiness off');
reset role;
insert into public.farm_feature_access(farm_id,key) values('bc000000-0000-4000-9000-000000000001','general_chat');
set local role authenticated;
select public.chat_create('bc200000-0000-4000-9000-000000000001','bc000000-0000-4000-9000-000000000001','group','Private',array['bc100000-0000-4000-9000-000000000003'::uuid]);
select public.chat_send('bc200000-0000-4000-9000-000000000001','bc300000-0000-4000-9000-000000000001','private secret');
select public.chat_send('bc200000-0000-4000-9000-000000000001','bc300000-0000-4000-9000-000000000001','private secret');
select pg_temp.assert((select count(*)=1 from public.chat_messages),'retry sends once');
select pg_temp.assert(public._chat_refused($q$insert into public.chat_members(conversation_id,farm_id,user_id,is_admin) values('bc200000-0000-4000-9000-000000000001','bc000000-0000-4000-9000-000000000001','bc100000-0000-4000-9000-000000000001',true)$q$),'no direct member writes');
select pg_temp.assert(public._chat_refused($q$select public.chat_manage('bc200000-0000-4000-9000-000000000001','add','bc100000-0000-4000-9000-000000000005')$q$),'no cross-customer invitation');
select pg_temp.login(1);
select pg_temp.assert((select count(*)=0 from public.chat_messages),'owner is not a secret member');
select pg_temp.assert((select count(*)=0 from public.chat_conversations),'owner cannot enumerate rooms');
select pg_temp.assert((select count(*)=0 from public.chat_events),'owner cannot read private audit');
select pg_temp.assert(public._chat_refused($q$select public.chat_room('bc200000-0000-4000-9000-000000000001')$q$),'owner RPC denied');
select pg_temp.login(3);
select pg_temp.assert((select count(*)=1 from public.chat_messages),'member reads');
select pg_temp.assert((select count(*)=1 from public.notifications where template='staff_chat'),'one notification on retry');
select pg_temp.assert(not exists(select 1 from public.notifications where template='staff_chat' and payload::text like '%private secret%'),'notification has no message');
select pg_temp.assert(public._chat_refused($q$select public.chat_manage('bc200000-0000-4000-9000-000000000001','add','bc100000-0000-4000-9000-000000000004')$q$),'no self escalation');
select pg_temp.assert(public._chat_refused($q$select public.chat_edit('bc200000-0000-4000-9000-000000000001','bc300000-0000-4000-9000-000000000001','changed')$q$),'only sender edits');
select pg_temp.login(2);
select public.chat_manage('bc200000-0000-4000-9000-000000000001','add','bc100000-0000-4000-9000-000000000004');
select pg_temp.login(4);
select pg_temp.assert((select count(*)=0 from public.chat_messages),'new member has no earlier history');
select pg_temp.login(2);
select public.chat_send('bc200000-0000-4000-9000-000000000001','bc300000-0000-4000-9000-000000000002','after join');
select pg_temp.login(4);
select pg_temp.assert((select count(*)=1 from public.chat_messages),'new member sees later messages');
select public.chat_mark_read('bc200000-0000-4000-9000-000000000001',9223372036854775807);
select pg_temp.assert((select last_read=(select max(sequence) from public.chat_messages) from public.chat_members where user_id='bc100000-0000-4000-9000-000000000004'),'read cursor cannot skip future messages');
select pg_temp.login(2);
select public.chat_manage('bc200000-0000-4000-9000-000000000001','remove','bc100000-0000-4000-9000-000000000003');
select pg_temp.login(3);
select pg_temp.assert((select count(*)=0 from public.chat_messages),'removed member reads nothing');
select pg_temp.assert(not app.chat_can_read('bc200000-0000-4000-9000-000000000001'),'realtime selection revoked');
select pg_temp.assert(public._chat_refused($q$select public.chat_send('bc200000-0000-4000-9000-000000000001','bc300000-0000-4000-9000-000000000003','stale client')$q$),'removed member cannot retry');
select pg_temp.login(2);
select public.chat_prepare('bc200000-0000-4000-9000-000000000001','bc300000-0000-4000-9000-000000000004');
create temporary table chat_test_intent as select (public.upload_begin('bc000000-0000-4000-9000-000000000001',null,'chat_message','bc300000-0000-4000-9000-000000000004','photo','photo','image/jpeg',1000,'bc400000-0000-4000-9000-000000000001','jpg')->>'id')::uuid as id;
reset role;
select app.upload_mark_verified((select id from chat_test_intent),1000,'image/jpeg',null,10,10);
set local role authenticated;
select public.upload_commit((select id from chat_test_intent));
select public.upload_commit((select id from chat_test_intent));
select pg_temp.assert((select count(*)=1 from public.chat_attachments),'attachment finalise idempotent');
select public.chat_send('bc200000-0000-4000-9000-000000000001','bc300000-0000-4000-9000-000000000004','');
select pg_temp.login(4);
select pg_temp.assert((select count(*)=1 from public.chat_attachments),'member sees attachment');
select pg_temp.login(1);
select pg_temp.assert((select count(*)=0 from public.chat_attachments),'owner cannot read attachment');
select pg_temp.login(2);
select public.chat_edit('bc200000-0000-4000-9000-000000000001','bc300000-0000-4000-9000-000000000004','',true);
select pg_temp.assert((select count(*)=0 from public.chat_attachments),'deleted message attachment hidden');
select pg_temp.assert((select count(*)=1 from public.chat_events where event='deleted'),'deletion has private audit evidence');
reset role;
select set_config('request.jwt.claims','',true);
update public.users set active=false where id='bc100000-0000-4000-9000-000000000004';
select pg_temp.login(4);
set local role authenticated;
select pg_temp.assert((select count(*)=0 from public.chat_messages),'inactive account denied');
reset role;
select set_config('request.jwt.claims','',true);
update public.farms set status='suspended',suspended_for='billing' where id='bc000000-0000-4000-9000-000000000001';
select pg_temp.login(2);
set local role authenticated;
select pg_temp.assert(public._chat_refused($q$select public.chat_send('bc200000-0000-4000-9000-000000000001','bc300000-0000-4000-9000-000000000005','paused')$q$),'suspended writes denied');
reset role;
select pg_temp.assert(not has_table_privilege('anon','public.chat_messages','select'),'anonymous table access denied');
select pg_temp.assert(not has_function_privilege('anon','public.chat_send(uuid,uuid,text)','execute'),'anonymous RPC denied');
rollback;
