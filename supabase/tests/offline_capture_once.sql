-- One capture, one record, online or queued (B3, R-123, 20261119130000). Scenario 35's
-- offline part and BRIEF section 19: request ids shared between online attempts and offline
-- envelopes; the plan asked again on reconnect.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',true);
insert into public.farms(id,name,status,plan) values
 ('ca000000-0000-4000-9000-000000000001','Offline Pro','active','professional'),
 ('ca000000-0000-4000-9000-000000000002','Offline Essential','active','essential');
insert into auth.users(id,email) values
 ('ca100000-0000-4000-9000-000000000001','off1@example.test'),
 ('ca100000-0000-4000-9000-000000000002','off2@example.test'),
 ('ca100000-0000-4000-9000-000000000003','off3@example.test');
insert into public.users(id,farm_id,role,name,email) values
 ('ca100000-0000-4000-9000-000000000001','ca000000-0000-4000-9000-000000000001','owner','Owner','off1@example.test'),
 ('ca100000-0000-4000-9000-000000000002','ca000000-0000-4000-9000-000000000001','manager','Manager','off2@example.test'),
 ('ca100000-0000-4000-9000-000000000003','ca000000-0000-4000-9000-000000000002','owner','Essential owner','off3@example.test');
insert into public.machines(id,farm_id,name,type,meter_type) values
 ('ca200000-0000-4000-9000-000000000001','ca000000-0000-4000-9000-000000000001','Truck','truck','km'),
 ('ca200000-0000-4000-9000-000000000002','ca000000-0000-4000-9000-000000000002','Tractor','tractor','hours');

create function pg_temp.assert(ok boolean, why text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'OFFLINE: %', why; end if; end
$$;
create function pg_temp.login(n integer) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub','ca100000-0000-4000-9000-00000000000'||n,'role','authenticated')::text, true)
$$;
-- The sync route's call, as the service.
create function pg_temp.sync(p_client uuid, p_actor uuid, p_type text, p_fields jsonb) returns jsonb language sql as $$
  select public.apply_offline_capture_once(p_client, now() - interval '1 minute', p_type, 'app', p_actor, p_fields)
$$;
create function pg_temp.readings() returns bigint language sql as $$
  select count(*) from public.meter_readings where machine_id = 'ca200000-0000-4000-9000-000000000001'
$$;

-- == The online attempt saved it, its answer was lost, and the phone queued it ===========
select pg_temp.login(1); set local role authenticated;
select public.claim_request('ca300000-0000-4000-9000-000000000001', 'readings:add');
select public.finish_request('ca300000-0000-4000-9000-000000000001', '/machines/ca200000-0000-4000-9000-000000000001?saved=reading');
reset role; select set_config('request.jwt.claims','',true);
select pg_temp.assert((pg_temp.sync('ca300000-0000-4000-9000-000000000001','ca100000-0000-4000-9000-000000000001','log_reading',
  '{"machine_id":"ca200000-0000-4000-9000-000000000001","reading":"100"}')->>'via') = 'online',
  'a capture the online attempt already saved is answered, not applied again');
select pg_temp.assert(pg_temp.readings() = 0, 'and no second reading is written');

-- == The online attempt is still running: the phone keeps it and tries later ==============
select pg_temp.login(1); set local role authenticated;
select public.claim_request('ca300000-0000-4000-9000-000000000002', 'readings:add');
reset role; select set_config('request.jwt.claims','',true);
select pg_temp.assert((pg_temp.sync('ca300000-0000-4000-9000-000000000002','ca100000-0000-4000-9000-000000000001','log_reading',
  '{"machine_id":"ca200000-0000-4000-9000-000000000001","reading":"110"}')->>'status') = 'retry',
  'a capture whose online attempt is still running waits');
select pg_temp.assert(pg_temp.readings() = 0, 'nothing written while the online attempt runs');

-- == No online attempt: the capture applies once and claims its id ========================
select pg_temp.assert((pg_temp.sync('ca300000-0000-4000-9000-000000000003','ca100000-0000-4000-9000-000000000001','log_reading',
  '{"machine_id":"ca200000-0000-4000-9000-000000000001","reading":"120"}')->>'status') = 'applied', 'an offline capture applies');
select pg_temp.assert(pg_temp.readings() = 1, 'one reading');
select pg_temp.assert((pg_temp.sync('ca300000-0000-4000-9000-000000000003','ca100000-0000-4000-9000-000000000001','log_reading',
  '{"machine_id":"ca200000-0000-4000-9000-000000000001","reading":"120"}')->>'duplicate') = 'true', 'its replay is a duplicate');
select pg_temp.assert(pg_temp.readings() = 1, 'still one reading');
select pg_temp.assert((select finished_at is not null and action = 'capture:log_reading' from public.request_claims
  where request_id = 'ca300000-0000-4000-9000-000000000003'), 'the capture holds its id');
-- A late online request with the same id is answered, not run (and not refused as a reused id).
select pg_temp.login(1); set local role authenticated;
select pg_temp.assert((public.claim_request('ca300000-0000-4000-9000-000000000003', 'readings:add')->>'state') = 'done',
  'the online action finds the capture already done');
-- Somebody else cannot use that id.
select pg_temp.login(2);
do $t$ begin
  perform public.claim_request('ca300000-0000-4000-9000-000000000003', 'readings:add');
  raise exception 'OFFLINE: another person took over a capture''s id';
exception when unique_violation then null;
end $t$;
reset role; select set_config('request.jwt.claims','',true);
select pg_temp.assert((pg_temp.sync('ca300000-0000-4000-9000-000000000003','ca100000-0000-4000-9000-000000000002','log_reading',
  '{"machine_id":"ca200000-0000-4000-9000-000000000001","reading":"120"}')->>'status') = 'needs_review',
  'another person''s capture under the same id goes to review');

-- == A refused capture leaves no claim behind, so the corrected one can go ================
do $t$ begin
  perform pg_temp.sync('ca300000-0000-4000-9000-000000000004','ca100000-0000-4000-9000-000000000001','log_reading',
    '{"machine_id":"ca200000-0000-4000-9000-000000000001","reading":"-5"}');
  raise exception 'OFFLINE: a negative reading was accepted';
exception when invalid_parameter_value then null;
end $t$;
select pg_temp.assert(not exists (select 1 from public.request_claims where request_id = 'ca300000-0000-4000-9000-000000000004'),
  'a refused capture keeps no claim');

-- == The plan, asked again on reconnect ====================================================
do $t$ begin
  perform pg_temp.sync('ca300000-0000-4000-9000-000000000005','ca100000-0000-4000-9000-000000000003','log_fuel',
    '{"machine_id":"ca200000-0000-4000-9000-000000000002","litres":"40"}');
  raise exception 'OFFLINE: a diesel draw was replayed on a plan without fuel';
exception when raise_exception then
  if sqlerrm <> 'plan-feature-fuel' then raise; end if;
end $t$;
-- A reading is every plan's: the same business's queued reading still applies.
select pg_temp.assert((pg_temp.sync('ca300000-0000-4000-9000-000000000006','ca100000-0000-4000-9000-000000000003','log_reading',
  '{"machine_id":"ca200000-0000-4000-9000-000000000002","reading":"55"}')->>'status') = 'applied', 'a reading applies on Essential');

select pg_temp.assert(not has_function_privilege('authenticated','public.apply_offline_capture_once(uuid,timestamptz,text,text,uuid,jsonb)','execute')
  and not has_function_privilege('anon','public.apply_offline_capture_once(uuid,timestamptz,text,text,uuid,jsonb)','execute'),
  'only the service replays captures');
rollback;
