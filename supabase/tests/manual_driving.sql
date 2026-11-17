\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',true);
insert into public.farms(id,name,status,plan) values
 ('db000000-0000-4000-9000-000000000001','Manual drive','active','essential'),
 ('db000000-0000-4000-9000-000000000002','Other business','active','essential');
insert into auth.users(id,email) select ('db100000-0000-4000-9000-00000000000'||n)::uuid,'manual'||n||'@example.test' from generate_series(1,4)n;
insert into public.users(id,farm_id,role,name,email) select ('db100000-0000-4000-9000-00000000000'||n)::uuid,
 ('db000000-0000-4000-9000-00000000000'||case when n=4 then 2 else 1 end)::uuid,
 case when n=1 then 'owner'::public.user_role else 'operator'::public.user_role end,'Person '||n,'manual'||n||'@example.test' from generate_series(1,4)n;
insert into public.machines(id,farm_id,name,type,meter_type) values
 ('db200000-0000-4000-9000-000000000001','db000000-0000-4000-9000-000000000001','Truck','truck','km'),
 ('db200000-0000-4000-9000-000000000002','db000000-0000-4000-9000-000000000001','Equipment','trailer','none');
update public.machines set profile='equipment' where id='db200000-0000-4000-9000-000000000002';
update public.feature_flags set released=true where key='map';
create function pg_temp.login(n integer) returns void language sql as $$select set_config('request.jwt.claims',jsonb_build_object('sub','db100000-0000-4000-9000-00000000000'||n,'role','authenticated','aal','aal2')::text,true)$$;
create function pg_temp.assert(ok boolean,why text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'MANUAL: %',why;end if;end$$;
create function public._manual_refused(q text) returns boolean language plpgsql as $$begin execute q;return false;exception when insufficient_privilege or invalid_parameter_value then return true;end$$;
create temporary table ids(kind text primary key,id uuid);grant all on ids to authenticated;
select pg_temp.login(2);set local role authenticated;
insert into ids values('start',public.record_manual_driving_event('db300000-0000-4000-9000-000000000001','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000001','db100000-0000-4000-9000-000000000002','start',p_at=>now()-interval '1 hour',p_km=>100.1,p_destination=>'Mill',p_stops=>array['Depot','Mill']));
insert into ids select 'session',session_id from public.driving_events where id=(select id from ids where kind='start');
select pg_temp.assert((select destination='Mill' and planned_stops=array['Depot','Mill'] and start_km=100.1 from public.driving_sessions),'Essential manual itinerary and km');
select pg_temp.assert((select lat is null and lng is null from public.driving_events where id=(select id from ids where kind='start')),'no coordinates required');
select pg_temp.assert(public.record_manual_driving_event('db300000-0000-4000-9000-000000000001','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000001','db100000-0000-4000-9000-000000000002','start',p_at=>now()-interval '1 hour',p_km=>100.1,p_destination=>'Mill',p_stops=>array['Depot','Mill'])=(select id from ids where kind='start'),'lost-response retry returns original');
select pg_temp.assert((select count(*)=1 from public.driving_events),'retry creates one event');
select pg_temp.assert(public._manual_refused($q$select public.record_manual_driving_event('db300000-0000-4000-9000-000000000001','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000001','db100000-0000-4000-9000-000000000002','start',p_km=>200)$q$),'changed retry refused');
select pg_temp.login(3);
select pg_temp.assert((select count(*)=0 from public.driving_sessions),'coworker cannot read another log');
select pg_temp.assert(public._manual_refused($q$select public.record_manual_driving_event('db300000-0000-4000-9000-000000000004','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000001','db100000-0000-4000-9000-000000000002','start')$q$),'coworker cannot impersonate');
select pg_temp.login(4);
select pg_temp.assert((select count(*)=0 from public.driving_events),'wrong customer cannot read itinerary');
select pg_temp.assert(public._manual_refused($q$select public.record_manual_driving_event('db300000-0000-4000-9000-000000000005','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000001','db100000-0000-4000-9000-000000000004','start')$q$),'wrong customer cannot write');
select pg_temp.login(2);
select pg_temp.assert(public._manual_refused('select public.record_manual_driving_event(''db300000-0000-4000-9000-000000000006'',''db000000-0000-4000-9000-000000000001'',''db200000-0000-4000-9000-000000000001'',''db100000-0000-4000-9000-000000000002'',''end'',p_session=>'''||(select id from ids where kind='session')||''',p_km=>99)'),'backward reading refused');
select pg_temp.assert(public._manual_refused('select public.record_manual_driving_event(''db300000-0000-4000-9000-000000000007'',''db000000-0000-4000-9000-000000000001'',''db200000-0000-4000-9000-000000000001'',''db100000-0000-4000-9000-000000000002'',''end'',p_session=>'''||(select id from ids where kind='session')||''',p_lat=>-26,p_lng=>28)'),'Essential cannot attach coordinates on new path');
select public.record_manual_driving_event('db300000-0000-4000-9000-000000000008','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000001','db100000-0000-4000-9000-000000000002','arrive',p_session=>(select id from ids where kind='session'),p_at=>now()-interval '30 minutes',p_location=>'Depot',p_km=>110);
select pg_temp.assert(public._manual_refused($q$select public.record_manual_driving_event('db300000-0000-4000-9000-000000000020','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000001','db100000-0000-4000-9000-000000000002','depart',p_session=>(select id from ids where kind='session'),p_km=>105)$q$),'reading cannot fall below intermediate reading');
select pg_temp.assert(public._manual_refused($q$select public.record_manual_driving_event('db300000-0000-4000-9000-000000000021','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000001','db100000-0000-4000-9000-000000000002','depart',p_session=>(select id from ids where kind='session'),p_km=>'NaN'::numeric)$q$),'nonfinite reading refused');
select pg_temp.assert(public._manual_refused($q$select public.record_manual_driving_event('db300000-0000-4000-9000-000000000022','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000001','db100000-0000-4000-9000-000000000002','depart',p_session=>(select id from ids where kind='session'),p_stops=>array_fill('Stop'::text,array[51]),p_plan_version=>1)$q$),'stop ceiling enforced');
select pg_temp.assert(public._manual_refused($q$select public.record_manual_driving_event('db300000-0000-4000-9000-000000000023','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000001','db100000-0000-4000-9000-000000000002','depart',p_session=>(select id from ids where kind='session'),p_stops=>array[null]::text[],p_plan_version=>1)$q$),'null stop refused');
select pg_temp.assert(public._manual_refused('select public.record_manual_driving_event(''db300000-0000-4000-9000-000000000012'',''db000000-0000-4000-9000-000000000001'',''db200000-0000-4000-9000-000000000001'',''db100000-0000-4000-9000-000000000002'',''depart'',p_session=>'''||(select id from ids where kind='session')||''',p_destination=>''Old destination'',p_plan_version=>0)'),'stale itinerary cannot overwrite current plan');
select pg_temp.assert((select destination='Mill' and plan_version=1 from public.driving_sessions),'failed stale update leaves itinerary intact');
select pg_temp.login(1);
insert into ids values('end',public.record_manual_driving_event('db300000-0000-4000-9000-000000000009','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000001','db100000-0000-4000-9000-000000000002','end',p_session=>(select id from ids where kind='session'),p_km=>120.3));
select pg_temp.assert((select end_km-start_km=20.2 and ended_at is not null and planned_stops=array['Depot','Mill'] from public.driving_sessions),'finish computes distance without erasing itinerary');
select pg_temp.assert((select source='manager' and recorded_by='db100000-0000-4000-9000-000000000001' from public.driving_events where id=(select id from ids where kind='end')),'manager attribution');
select pg_temp.assert(public.record_manual_driving_event('db300000-0000-4000-9000-000000000009','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000001','db100000-0000-4000-9000-000000000002','end',p_session=>(select id from ids where kind='session'),p_km=>120.3)=(select id from ids where kind='end'),'end retry succeeds after session closed');
select pg_temp.assert(public._manual_refused($q$select public.record_manual_driving_event('db300000-0000-4000-9000-000000000010','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000002','db100000-0000-4000-9000-000000000002','start')$q$),'equipment rejected');
reset role;select set_config('request.jwt.claims','',true);
update public.users set active=false where id='db100000-0000-4000-9000-000000000001';
select pg_temp.login(1);set local role authenticated;
select pg_temp.assert(public._manual_refused('select public.record_manual_driving_event(''db300000-0000-4000-9000-000000000009'',''db000000-0000-4000-9000-000000000001'',''db200000-0000-4000-9000-000000000001'',''db100000-0000-4000-9000-000000000002'',''end'',p_session=>'''||(select id from ids where kind='session')||''',p_km=>120.3)'),'revoked user cannot replay a successful request');
reset role;select set_config('request.jwt.claims','',true);
update public.farms set status='suspended',suspended_for='billing' where id='db000000-0000-4000-9000-000000000001';
select pg_temp.login(2);set local role authenticated;
select pg_temp.assert(public._manual_refused($q$select public.record_manual_driving_event('db300000-0000-4000-9000-000000000011','db000000-0000-4000-9000-000000000001','db200000-0000-4000-9000-000000000001','db100000-0000-4000-9000-000000000002','start')$q$),'suspended write refused');
reset role;
select pg_temp.assert(not has_function_privilege('anon','public.record_manual_driving_event(uuid,uuid,uuid,uuid,text,uuid,timestamptz,text,text,numeric,text,text[],double precision,double precision,integer)','execute'),'anonymous RPC refused');
rollback;
