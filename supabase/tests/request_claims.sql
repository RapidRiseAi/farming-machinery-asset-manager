\set ON_ERROR_STOP on
-- One request, one effect (20261018090000): a request id is claimed once; a replay gets the
-- first outcome or "running"; a failed attempt releases; ids belong to one person and one
-- action; a dead claim is taken over; anonymous callers cannot claim.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

do $bootstrap$
begin
  if to_regprocedure('public._t_login(uuid)') is null then
    execute $f$
      create function public._t_login(uid uuid) returns void language sql as $b$
        select set_config('request.jwt.claims',
                          json_build_object('sub', uid, 'role', 'authenticated', 'aal', 'aal2')::text, false);
      $b$;
    $f$;
    execute 'grant execute on function public._t_login(uuid) to public';
  end if;
end $bootstrap$;

insert into public.farms (id, name, plan, status, billing_period) values
  ('e2000000-0000-4000-9000-000000000001', 'Claims farm', 'complete', 'active', 'monthly');
insert into auth.users (id, email) values
  ('e2100000-0000-4000-9000-000000000001', 'claims.owner@example.test'),
  ('e2100000-0000-4000-9000-000000000002', 'claims.other@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('e2100000-0000-4000-9000-000000000001', 'e2000000-0000-4000-9000-000000000001', 'owner', 'Owner', 'claims.owner@example.test'),
  ('e2100000-0000-4000-9000-000000000002', 'e2000000-0000-4000-9000-000000000001', 'manager', 'Other', 'claims.other@example.test');

set local role authenticated;

do $t$
declare
  v jsonb;
  r1 constant uuid := 'e2900000-0000-4000-9000-000000000001';
  r2 constant uuid := 'e2900000-0000-4000-9000-000000000002';
  failed boolean;
begin
  perform public._t_login('e2100000-0000-4000-9000-000000000001');

  v := public.claim_request(r1, 'documents:record-payment');
  if v->>'state' <> 'new' then raise exception 'first claim should be new, got %', v; end if;

  v := public.claim_request(r1, 'documents:record-payment');
  if v->>'state' <> 'running' then raise exception 'replay while running should be running, got %', v; end if;

  perform public.finish_request(r1, '/documents/abc?paid=1');
  v := public.claim_request(r1, 'documents:record-payment');
  if v->>'state' <> 'done' or v->>'outcome' <> '/documents/abc?paid=1' then
    raise exception 'replay after finish should return the outcome, got %', v;
  end if;

  -- The same id for another action is refused, never answered with the first outcome.
  failed := false;
  begin
    perform public.claim_request(r1, 'documents:record-refund');
  exception when unique_violation then failed := true;
  end;
  if not failed then raise exception 'one id must not serve two actions'; end if;

  -- A failed attempt releases, and the retry runs.
  v := public.claim_request(r2, 'expenses:create');
  perform public.release_request(r2);
  v := public.claim_request(r2, 'expenses:create');
  if v->>'state' <> 'new' then raise exception 'a released claim should run again, got %', v; end if;

  -- Another person cannot use, finish or release this person's id.
  perform public._t_login('e2100000-0000-4000-9000-000000000002');
  failed := false;
  begin
    perform public.claim_request(r2, 'expenses:create');
  exception when unique_violation then failed := true;
  end;
  if not failed then raise exception 'an id must belong to the person who claimed it'; end if;
  perform public.finish_request(r2, '/elsewhere');
  perform public.release_request(r2);
  perform public._t_login('e2100000-0000-4000-9000-000000000001');
  v := public.claim_request(r2, 'expenses:create');
  if v->>'state' <> 'running' then raise exception 'another person must not finish or release it, got %', v; end if;
end $t$;

-- A claim whose attempt died (older than any function may run) is taken over.
reset role;
update public.request_claims set claimed_at = now() - interval '6 minutes'
 where request_id = 'e2900000-0000-4000-9000-000000000002';
set local role authenticated;
do $t$
declare v jsonb;
begin
  perform public._t_login('e2100000-0000-4000-9000-000000000001');
  v := public.claim_request('e2900000-0000-4000-9000-000000000002', 'expenses:create');
  if v->>'state' <> 'new' then raise exception 'a dead claim should be taken over, got %', v; end if;

  -- Nobody reads the table directly.
  begin
    perform 1 from public.request_claims;
    raise exception 'request_claims must not be readable by authenticated';
  exception when insufficient_privilege then null;
  end;
end $t$;

-- Signed out: no claim.
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);
set local role anon;
do $t$
begin
  perform public.claim_request('e2900000-0000-4000-9000-000000000003', 'x');
  raise exception 'anon must not claim';
exception when insufficient_privilege then null;
end $t$;

reset role;
rollback;
