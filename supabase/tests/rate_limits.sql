\set ON_ERROR_STOP on
-- Rate limits every server instance shares (20261014090000): counted per person, per scope,
-- per window, and nobody can spend another person's.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('b0000000-0000-4000-9000-000000000001', 'Limit farm', 'complete', 'active');
insert into auth.users (id, email) values
  ('b0100000-0000-4000-9000-000000000001', 'limit.one@example.test'),
  ('b0100000-0000-4000-9000-000000000002', 'limit.two@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('b0100000-0000-4000-9000-000000000001', 'b0000000-0000-4000-9000-000000000001', 'owner',    'One', 'limit.one@example.test'),
  ('b0100000-0000-4000-9000-000000000002', 'b0000000-0000-4000-9000-000000000001', 'operator', 'Two', 'limit.two@example.test');

-- == The first person: three allowed in the window, the fourth refused ==========
select set_config('request.jwt.claims', '{"sub":"b0100000-0000-4000-9000-000000000001","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r record; seen boolean[] := '{}';
begin
  for i in 1..4 loop
    select * into r from public.rate_limit_take('transcribe', 3600, 3);
    seen := seen || r.allowed;
  end loop;
  if seen is distinct from array[true, true, true, false] then
    raise exception 'expected three allowed then one refused, got %', seen;
  end if;
  if r.retry_after is null or r.retry_after < 1 or r.retry_after > 3600 then
    raise exception 'retry_after % is not within the window', r.retry_after;
  end if;
  -- A different scope is a different limit.
  select * into r from public.rate_limit_take('speech_token', 3600, 3);
  if not r.allowed then raise exception 'one scope''s limit spilled into another'; end if;
  -- A malformed scope is refused rather than written.
  begin
    perform public.rate_limit_take('Bad Scope!', 60, 3);
    raise exception 'a malformed scope was accepted';
  exception when invalid_parameter_value then null; end;
  -- And the counters themselves are out of reach.
  begin
    perform 1 from app.rate_limit_windows;
    raise exception 'a signed-in user read the counters';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- == The second person has their own count ======================================
select set_config('request.jwt.claims', '{"sub":"b0100000-0000-4000-9000-000000000002","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r record;
begin
  select * into r from public.rate_limit_take('transcribe', 3600, 3);
  if not r.allowed then raise exception 'one person''s limit was charged to another'; end if;
end $$;
reset role;

-- == Each person's count is keyed by their own session ==========================
do $$
declare n int;
begin
  select count(*) into n from app.rate_limit_windows
   where key in ('transcribe:b0100000-0000-4000-9000-000000000001',
                 'speech_token:b0100000-0000-4000-9000-000000000001',
                 'transcribe:b0100000-0000-4000-9000-000000000002');
  if n <> 3 then raise exception 'expected 3 counter rows keyed by person and scope, found %', n; end if;
  select hits into n from app.rate_limit_windows where key = 'transcribe:b0100000-0000-4000-9000-000000000001';
  if n <> 4 then raise exception 'the first person''s transcribe count is %, expected 4', n; end if;
end $$;

-- == No session, no limit to take: anon is refused outright ====================
select set_config('request.jwt.claims', '', true);
set local role anon;
do $$ begin
  begin
    perform public.rate_limit_take('transcribe', 60, 3);
    raise exception 'anonymous rate_limit_take';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

rollback;
