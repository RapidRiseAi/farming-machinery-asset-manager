\set ON_ERROR_STOP on
begin;
insert into farms(id,name,status) values
 ('da000000-0000-4000-8000-000000000001','Driving Farm','active'),
 ('da000000-0000-4000-8000-000000000002','Other Farm','active');
insert into auth.users(id,email) values
 ('da100000-0000-4000-8000-000000000001','driving-owner@example.test'),
 ('da100000-0000-4000-8000-000000000002','driving-driver@example.test'),
 ('da100000-0000-4000-8000-000000000003','driving-other@example.test'),
 ('da100000-0000-4000-8000-000000000004','driving-admin@example.test'),
 ('da100000-0000-4000-8000-000000000005','driving-second@example.test');
insert into users(id,farm_id,role,name,email) values
 ('da100000-0000-4000-8000-000000000001','da000000-0000-4000-8000-000000000001','owner','Owner','driving-owner@example.test'),
 ('da100000-0000-4000-8000-000000000002','da000000-0000-4000-8000-000000000001','operator','Driver','driving-driver@example.test'),
 ('da100000-0000-4000-8000-000000000003','da000000-0000-4000-8000-000000000002','owner','Other','driving-other@example.test'),
 ('da100000-0000-4000-8000-000000000004',null,'rr_admin','Staff','driving-admin@example.test'),
 ('da100000-0000-4000-8000-000000000005','da000000-0000-4000-8000-000000000001','operator','Second','driving-second@example.test');
insert into machines(id,farm_id,name,type,meter_type,public_token) values
 ('da200000-0000-4000-8000-000000000001','da000000-0000-4000-8000-000000000001','Vehicle','tractor','hours','da300000-0000-4000-8000-000000000001'),
 ('da200000-0000-4000-8000-000000000002','da000000-0000-4000-8000-000000000002','Other vehicle','tractor','hours','da300000-0000-4000-8000-000000000002');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"da100000-0000-4000-8000-000000000002","role":"authenticated"}',true);
do $$ declare first_result jsonb; retry_result jsonb; begin
 first_result:=record_member_qr('da300000-0000-4000-8000-000000000001','fault','{"p_description":"Retry test","p_urgency":"can_work"}','da400000-0000-4000-8000-000000000001');
 retry_result:=record_member_qr('da300000-0000-4000-8000-000000000001','fault','{"p_description":"Retry test","p_urgency":"can_work"}','da400000-0000-4000-8000-000000000001');
 if first_result->>'ok'<>'true' or first_result is distinct from retry_result then raise exception 'QR retry created another fault'; end if;
 begin
   perform record_member_qr('da300000-0000-4000-8000-000000000001','fault','{"p_description":"Changed retry","p_urgency":"can_work"}','da400000-0000-4000-8000-000000000001');
   raise exception 'QR retry payload changed';
 exception when invalid_parameter_value then null; end;
end $$;
do $$ begin
 if (select count(*) from resolve_member_qr('da300000-0000-4000-8000-000000000001'))<>1 then raise exception 'member cannot scan'; end if;
 if (select count(*) from resolve_member_qr('da300000-0000-4000-8000-000000000002'))<>0 then raise exception 'QR leaks other farm'; end if;
 if (select count(*) from driving_vehicles('da000000-0000-4000-8000-000000000001'))<>1 then raise exception 'driver cannot choose vehicle'; end if;
 if record_member_qr('da300000-0000-4000-8000-000000000001','reading','{"p_reading":10,"p_reporter":"Impostor"}')->>'ok'<>'true' then raise exception 'member reading failed'; end if;
 if record_member_qr('da300000-0000-4000-8000-000000000001','fault','{"p_description":"Leak","p_urgency":"can_work","p_reporter":"Impostor"}')->>'ok'<>'true' then raise exception 'member fault failed'; end if;
 begin
   perform record_member_qr('da300000-0000-4000-8000-000000000002','reading','{"p_reading":10}');
   raise exception 'cross farm QR write succeeded';
 exception when insufficient_privilege then null; end;
 begin
   perform configure_driver_connection('da000000-0000-4000-8000-000000000001','Unauthorised','tracker',repeat('a',64));
   raise exception 'driver provisioned connection';
 exception when insufficient_privilege then null; end;
 perform record_driving_event('da000000-0000-4000-8000-000000000001','da200000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000002','start',now()-interval '4 hours');
 begin
   perform record_driving_event('da000000-0000-4000-8000-000000000001','da200000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000002','start',now()-interval '3 hours');
   raise exception 'duplicate session allowed';
 exception when invalid_parameter_value then null; end;
 begin
   perform record_driving_event('da000000-0000-4000-8000-000000000001','da200000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000002','depart',now()-interval '3 hours');
   raise exception 'departure without arrival allowed';
 exception when invalid_parameter_value then null; end;
 perform record_driving_event('da000000-0000-4000-8000-000000000001','da200000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000002','arrive',now()-interval '3 hours','Mill');
 begin
   perform record_driving_event('da000000-0000-4000-8000-000000000001','da200000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000002','end',now()-interval '5 hours');
   raise exception 'backwards event allowed';
 exception when invalid_parameter_value then null; end;
 begin
   update driving_sessions set driver_id='da100000-0000-4000-8000-000000000005';
   raise exception 'direct session tampering allowed';
 exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claims','{"sub":"da100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $$ begin
 perform record_driving_event('da000000-0000-4000-8000-000000000001','da200000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000002','depart',now()-interval '2 hours');
 perform record_driving_event('da000000-0000-4000-8000-000000000001','da200000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000002','end',now()-interval '1 hour');
 if (select count(*) from driving_events where source='manager')<>2 then raise exception 'manager attribution lost'; end if;
 begin
   perform configure_driver_connection('da000000-0000-4000-8000-000000000001','Not purchased','tracker',repeat('a',64));
   raise exception 'farm owner enabled paid feature';
 exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claims','{"sub":"da100000-0000-4000-8000-000000000005","role":"authenticated"}',true);
do $$ begin
 if exists(select 1 from driving_sessions) or exists(select 1 from driving_events) then raise exception 'driver sees coworker history'; end if;
 begin
   perform record_driving_event('da000000-0000-4000-8000-000000000001','da200000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000002','start');
   raise exception 'driver impersonates coworker';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"sub":"da100000-0000-4000-8000-000000000003","role":"authenticated"}',true);
do $$ begin
 if exists(select 1 from driving_sessions) or exists(select 1 from driving_events) then raise exception 'cross farm history leak'; end if;
end $$;

select set_config('request.jwt.claims','{"sub":"da100000-0000-4000-8000-000000000004","role":"authenticated"}',true);
do $$ declare c uuid; begin
 c:=configure_driver_connection('da000000-0000-4000-8000-000000000001','Test provider','key_tag',repeat('a',64));
 perform link_driver_device(c,'device-1','da200000-0000-4000-8000-000000000001',null);
 perform link_driver_device(c,'tag-1',null,'da100000-0000-4000-8000-000000000002');
 begin
   perform link_driver_device(c,'bad-device','da200000-0000-4000-8000-000000000002',null);
   raise exception 'cross farm device mapped';
 exception when invalid_parameter_value then null; end;
 begin
   perform configure_driver_connection('da000000-0000-4000-8000-000000000001','Test provider','key_tag',null,c,true,null);
   raise exception 'activated without quote';
 exception when invalid_parameter_value then null; end;
end $$;
reset role;
set local role service_role;
do $$ declare c uuid; e uuid; again uuid; begin
 select id into c from driver_connections where name='Test provider';
 begin
   perform ingest_driving_event(c,'device-1','tag-1','event-1','start',now()-interval '30 minutes');
   raise exception 'inactive connection accepted';
 exception when invalid_parameter_value then null; end;
 update driver_connections set active=true,quote_reference='TEST-QUOTE' where id=c;
 e:=ingest_driving_event(c,'device-1','tag-1','event-1','start',now()-interval '30 minutes');
 again:=ingest_driving_event(c,'device-1','tag-1','event-1','start',now()-interval '30 minutes');
 if e<>again or (select count(*) from driving_events where connection_id=c)<>1 then raise exception 'retry duplicated event'; end if;
 begin
   perform ingest_driving_event(c,'device-1','tag-1','event-1','start',now()-interval '31 minutes');
   raise exception 'changed retry accepted';
 exception when invalid_parameter_value then null; end;
 -- Hardware providers often timestamp key-tag and ignition events in the same second.
 perform ingest_driving_event(c,'device-1','tag-1','event-2','engine_on',now()-interval '30 minutes');
 perform ingest_driving_event(c,'device-1','tag-1','event-3','arrive',now()-interval '20 minutes','Depot');
 perform ingest_driving_event(c,'device-1','tag-1','event-4','engine_off',now()-interval '19 minutes');
 perform ingest_driving_event(c,'device-1','tag-1','event-5','end',now()-interval '10 minutes');
end $$;
reset role;
do $$ begin
 if exists(select 1 from meter_readings where machine_id='da200000-0000-4000-8000-000000000001' and by_user is distinct from 'da100000-0000-4000-8000-000000000002'::uuid) then raise exception 'reading actor lost'; end if;
 if exists(select 1 from faults where machine_id='da200000-0000-4000-8000-000000000001' and (reported_by is distinct from 'da100000-0000-4000-8000-000000000002'::uuid or reporter_name='Impostor')) then raise exception 'QR identity spoofed'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"da100000-0000-4000-8000-000000000002","role":"authenticated"}',true);
do $$ declare total_stops integer; begin
 select sum(jsonb_array_length(stop_events)) into total_stops from driving_session_details(array(select id from driving_sessions));
 if total_stops is distinct from 5 then raise exception 'stop summary incomplete'; end if;
end $$;
reset role;
-- An explicitly revoked primary membership must not fall back to users.farm_id.
insert into user_farm_memberships(user_id,farm_id,role,active) values('da100000-0000-4000-8000-000000000002','da000000-0000-4000-8000-000000000001','operator',false)
on conflict(user_id,farm_id) do update set active=false;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"da100000-0000-4000-8000-000000000002","role":"authenticated"}',true);
do $$ begin
 if exists(select 1 from resolve_member_qr('da300000-0000-4000-8000-000000000001')) or exists(select 1 from driving_sessions) then raise exception 'revoked membership retains access'; end if;
end $$;
reset role;
set local role anon;
do $$ begin
 begin perform resolve_member_qr('da300000-0000-4000-8000-000000000001'); raise exception 'anonymous QR read'; exception when insufficient_privilege then null; end;
 begin perform * from driving_sessions; raise exception 'anonymous history'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
