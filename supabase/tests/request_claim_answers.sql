-- A replayed answer fits in a claim; old claims are swept (B3, 20261119110000).
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',true);
insert into public.farms(id,name,status,plan) values ('cd000000-0000-4000-9000-000000000001','Claims','active','complete');
insert into auth.users(id,email) values
 ('cd100000-0000-4000-9000-000000000001','claims1@example.test'),
 ('cd100000-0000-4000-9000-000000000002','claims2@example.test');
insert into public.users(id,farm_id,role,name,email) values
 ('cd100000-0000-4000-9000-000000000001','cd000000-0000-4000-9000-000000000001','owner','One','claims1@example.test'),
 ('cd100000-0000-4000-9000-000000000002','cd000000-0000-4000-9000-000000000001','manager','Two','claims2@example.test');
create function pg_temp.login(n integer) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub','cd100000-0000-4000-9000-00000000000'||n,'role','authenticated')::text, true)
$$;
create function pg_temp.assert(ok boolean, why text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'CLAIM: %', why; end if; end
$$;

-- An assistant answer is longer than the 2,000 characters a claim used to keep.
select pg_temp.login(1); set local role authenticated;
select pg_temp.assert((public.claim_request('cd300000-0000-4000-9000-000000000001','assistant:turn')->>'state') = 'new', 'a first claim is new');
select public.finish_request('cd300000-0000-4000-9000-000000000001', '{"kind":"answer","text":"' || repeat('a', 30000) || '"}');
select pg_temp.assert(length(public.claim_request('cd300000-0000-4000-9000-000000000001','assistant:turn')->>'outcome') = 30000 + 27,
  'a replay gets the whole answer back, not the first 2,000 characters');
-- Another person cannot read it through the same id.
select pg_temp.login(2);
select pg_temp.assert(not has_table_privilege('authenticated','public.request_claims','SELECT'), 'claims are not readable by a signed-in person');
do $t$ begin
  perform public.claim_request('cd300000-0000-4000-9000-000000000001','assistant:turn');
  raise exception 'CLAIM: another person replayed somebody else''s answer';
exception when unique_violation then null;
end $t$;
reset role; select set_config('request.jwt.claims','',true);
-- Past the cap the outcome is cut rather than refused; the app never sends one that long.
select pg_temp.assert((select char_length(outcome) <= 65536 from public.request_claims where request_id = 'cd300000-0000-4000-9000-000000000001'), 'outcome within the cap');

-- The nightly sweep removes claims older than two days, everybody's, and keeps the recent.
insert into public.request_claims(request_id,user_id,action,claimed_at,finished_at,outcome) values
 ('cd300000-0000-4000-9000-000000000002','cd100000-0000-4000-9000-000000000002','work:media',now() - interval '3 days',now() - interval '3 days','{"ok":true}'),
 ('cd300000-0000-4000-9000-000000000003','cd100000-0000-4000-9000-000000000001','assistant:transcribe',now() - interval '1 day',now() - interval '1 day','{"hearings":[]}');
select pg_temp.assert(public.cron_sweep_request_claims() = 1, 'one old claim swept');
select pg_temp.assert((select count(*) = 2 from public.request_claims), 'recent claims kept');
select pg_temp.assert(not has_function_privilege('authenticated','public.cron_sweep_request_claims()','execute')
  and not has_function_privilege('anon','public.cron_sweep_request_claims()','execute'), 'the sweep is the service''s');
rollback;
