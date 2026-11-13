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

-- == Before sign-in: a hashed key the server supplies (20261113090000) =========
set local role service_role;
do $$
declare r record; seen boolean[] := '{}';
begin
  for i in 1..3 loop
    select * into r from public.rate_limit_take_key('signin_password', repeat('a', 64), 900, 2);
    seen := seen || r.allowed;
  end loop;
  if seen is distinct from array[true, true, false] then
    raise exception 'expected two allowed then one refused, got %', seen;
  end if;
  -- Another subject, and the same subject under another scope, count separately.
  select * into r from public.rate_limit_take_key('signin_password', repeat('b', 64), 900, 2);
  if not r.allowed then raise exception 'one address''s limit was charged to another'; end if;
  select * into r from public.rate_limit_take_key('signin_email', repeat('a', 64), 900, 2);
  if not r.allowed then raise exception 'one scope''s limit spilled into another'; end if;
  -- An address or an IP in the clear is refused rather than stored.
  begin
    perform public.rate_limit_take_key('signin_password', 'someone@example.test', 900, 2);
    raise exception 'a raw email address was accepted as a subject';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.rate_limit_take_key('signin_ip', '203.0.113.9', 900, 2);
    raise exception 'a raw IP was accepted as a subject';
  exception when invalid_parameter_value then null; end;
end $$;
reset role;

do $$
declare n int;
begin
  select hits into n from app.rate_limit_windows where key = concat('anon', ':', 'signin_password', ':', repeat('a', 64));
  if n is distinct from 3 then raise exception 'the hashed sign-in count is %, expected 3', n; end if;
  if exists (select 1 from app.rate_limit_windows where key like 'anon:%' and key !~ '^anon:[a-z_]+:[0-9a-f]{64}$') then
    raise exception 'an anonymous counter key is not scope plus a SHA-256 digest';
  end if;
end $$;

-- == Nobody but the server may choose a key ====================================
select set_config('request.jwt.claims', '', true);
set local role anon;
do $$ begin
  begin
    perform public.rate_limit_take_key('signin_password', repeat('c', 64), 900, 2);
    raise exception 'anonymous rate_limit_take_key';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"b0100000-0000-4000-9000-000000000001","role":"authenticated"}', true);
set local role authenticated;
do $$ begin
  begin
    perform public.rate_limit_take_key('signin_password', repeat('c', 64), 900, 2);
    raise exception 'a signed-in user called rate_limit_take_key';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

rollback;
