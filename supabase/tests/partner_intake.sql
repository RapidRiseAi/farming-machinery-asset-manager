\set ON_ERROR_STOP on
-- Partner applications are Rapid Rise's alone, and a contractor's link works for one person
-- (20261106100000, 20261106110000).
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, billing_period) values
  ('e4000000-0000-4000-9000-000000000001', 'Invite farm', 'complete', 'active', 'monthly');
insert into auth.users (id, email) values
  ('e4100000-0000-4000-9000-000000000001', 'farmer@invite.test');
insert into public.users (id, farm_id, role, name, email, active) values
  ('e4100000-0000-4000-9000-000000000001', 'e4000000-0000-4000-9000-000000000001', 'owner', 'Farmer', 'farmer@invite.test', true);
insert into public.partners (id, farm_id, name, kind) values
  ('e4200000-0000-4000-9000-000000000001', 'e4000000-0000-4000-9000-000000000001', 'Corner Parts', 'parts_supplier'),
  ('e4200000-0000-4000-9000-000000000002', 'e4000000-0000-4000-9000-000000000001', 'Second Shop', 'other');
insert into public.partner_invites (id, farm_id, partner_id, token_hash, code_hash, expires_at) values
  ('e4300000-0000-4000-9000-000000000001', 'e4000000-0000-4000-9000-000000000001',
   'e4200000-0000-4000-9000-000000000001', 'tok-a', 'code-a', now() + interval '7 days');

do $t$
declare r record;
begin
  -- Opening the page changes nothing and names only the sender.
  select * into r from public.partner_invite_peek('tok-a');
  if r.state <> 'open' or r.farm_name <> 'Invite farm' or r.business_name <> 'Corner Parts' then
    raise exception 'peek: %', row_to_json(r);
  end if;

  -- A wrong code counts; the right person still gets in.
  select * into r from public.partner_invite_redeem('tok-a', 'nope', 'shop@parts.test');
  if r.outcome <> 'wrong-code' or r.attempts_left <> 4 then raise exception 'wrong code: %', row_to_json(r); end if;

  -- A farmer's own login cannot be claimed, and that does not spend the link.
  select * into r from public.partner_invite_redeem('tok-a', 'code-a', 'FARMER@invite.test');
  if r.outcome <> 'email-taken' then raise exception 'farmer email: %', row_to_json(r); end if;
  if (select redeemed_at from public.partner_invites where token_hash = 'tok-a') is not null then
    raise exception 'a refused address spent the link';
  end if;

  select * into r from public.partner_invite_redeem('tok-a', 'code-a', ' Shop@Parts.test ');
  if r.outcome <> 'ok' or r.invite_partner <> 'e4200000-0000-4000-9000-000000000001' then
    raise exception 'first person: %', row_to_json(r);
  end if;

  -- One link, one person: a second address is refused, even holding the code.
  select * into r from public.partner_invite_redeem('tok-a', 'code-a', 'friend@other.test');
  if r.outcome <> 'used' or r.invite_id is not null then raise exception 'second person: %', row_to_json(r); end if;

  -- Wrong code and claimed reads the same as right code and claimed.
  select * into r from public.partner_invite_redeem('tok-a', 'nope', 'friend@other.test');
  if r.outcome <> 'used' then raise exception 'second person, wrong code: %', row_to_json(r); end if;

  -- The same person may come back, which is how a lost email is recovered.
  select * into r from public.partner_invite_redeem('tok-a', 'code-a', 'shop@parts.test');
  if r.outcome <> 'again' then raise exception 'same person: %', row_to_json(r); end if;

  select * into r from public.partner_invite_peek('tok-a');
  if r.state <> 'claimed' then raise exception 'peek after claim: %', row_to_json(r); end if;

  select * into r from public.partner_invite_redeem('no-such-token', 'code', 'a@b.test');
  if r.outcome <> 'invalid' then raise exception 'unknown link: %', row_to_json(r); end if;

  select * into r from public.partner_invite_redeem('tok-a', 'code-a', 'not an address');
  if r.outcome <> 'bad-email' then raise exception 'bad address: %', row_to_json(r); end if;
end $t$;

-- Five wrong codes lock it, for the right code too.
insert into public.partner_invites (id, farm_id, partner_id, token_hash, code_hash, expires_at) values
  ('e4300000-0000-4000-9000-000000000002', 'e4000000-0000-4000-9000-000000000001',
   'e4200000-0000-4000-9000-000000000002', 'tok-b', 'code-b', now() + interval '7 days');
do $t$
declare r record; i integer;
begin
  for i in 1..5 loop
    select * into r from public.partner_invite_redeem('tok-b', 'nope', 'x@y.test');
  end loop;
  if r.outcome <> 'locked' or r.attempts_left <> 0 then raise exception 'fifth try: %', row_to_json(r); end if;
  select * into r from public.partner_invite_redeem('tok-b', 'code-b', 'x@y.test');
  if r.outcome <> 'locked' then raise exception 'locked, right code: %', row_to_json(r); end if;
end $t$;

-- Expired and cancelled links open nothing.
update public.partner_invites set failed_attempts = 0, expires_at = now() - interval '1 minute' where token_hash = 'tok-b';
do $t$
declare r record;
begin
  select * into r from public.partner_invite_redeem('tok-b', 'code-b', 'x@y.test');
  if r.outcome <> 'expired' then raise exception 'expired: %', row_to_json(r); end if;
end $t$;
update public.partner_invites set expires_at = now() + interval '7 days', revoked_at = now() where token_hash = 'tok-b';
do $t$
declare r record;
begin
  select * into r from public.partner_invite_redeem('tok-b', 'code-b', 'x@y.test');
  if r.outcome <> 'revoked' then raise exception 'revoked: %', row_to_json(r); end if;
end $t$;

-- Past its seven days a claimed link answers nobody, not even the person who claimed it.
update public.partner_invites set expires_at = now() - interval '1 minute' where token_hash = 'tok-a';
do $t$
declare r record;
begin
  select * into r from public.partner_invite_redeem('tok-a', 'code-a', 'shop@parts.test');
  if r.outcome <> 'used' then raise exception 'claimed and expired: %', row_to_json(r); end if;
  select * into r from public.partner_invite_peek('tok-a');
  if r.state <> 'used' then raise exception 'peek, claimed and expired: %', row_to_json(r); end if;
end $t$;
update public.partner_invites set expires_at = now() + interval '7 days' where token_hash = 'tok-a';

-- Disconnecting the contractor kills their link, even one they have already claimed.
insert into public.workshops (id, name) values ('e4400000-0000-4000-9000-000000000001', 'Corner Parts');
update public.partners set workshop_id = 'e4400000-0000-4000-9000-000000000001'
 where id = 'e4200000-0000-4000-9000-000000000001';
insert into public.workshop_links (workshop_id, farm_id, status)
values ('e4400000-0000-4000-9000-000000000001', 'e4000000-0000-4000-9000-000000000001', 'active');
update public.workshop_links set status = 'revoked'
 where workshop_id = 'e4400000-0000-4000-9000-000000000001';
do $t$
declare r record;
begin
  select * into r from public.partner_invite_redeem('tok-a', 'code-a', 'shop@parts.test');
  if r.outcome <> 'revoked' then raise exception 'a disconnected contractor reused their link: %', row_to_json(r); end if;
end $t$;

-- Removing the partner kills their link as well.
insert into public.partners (id, farm_id, name, kind) values
  ('e4200000-0000-4000-9000-000000000003', 'e4000000-0000-4000-9000-000000000001', 'Gone Shop', 'other');
insert into public.partner_invites (farm_id, partner_id, token_hash, code_hash, expires_at) values
  ('e4000000-0000-4000-9000-000000000001', 'e4200000-0000-4000-9000-000000000003', 'tok-c', 'code-c', now() + interval '7 days');
update public.partners set deleted_at = now() where id = 'e4200000-0000-4000-9000-000000000003';
do $t$
declare r record;
begin
  select * into r from public.partner_invite_peek('tok-c');
  if r.state <> 'revoked' then raise exception 'peek, removed partner: %', row_to_json(r); end if;
  select * into r from public.partner_invite_redeem('tok-c', 'code-c', 'a@b.test');
  if r.outcome <> 'revoked' then raise exception 'removed partner: %', row_to_json(r); end if;
end $t$;

-- Who may touch what.
do $t$
begin
  if has_function_privilege('anon', 'public.partner_invite_redeem(text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.partner_invite_redeem(text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.partner_invite_peek(text)', 'EXECUTE') then
    raise exception 'the invite functions are for the server alone';
  end if;
  if has_column_privilege('authenticated', 'public.partner_invites', 'token_hash', 'SELECT')
     or has_column_privilege('authenticated', 'public.partner_invites', 'code_hash', 'SELECT') then
    raise exception 'a signed-in reader can see the hashes';
  end if;
  if has_table_privilege('authenticated', 'public.partner_invites', 'INSERT')
     or has_table_privilege('authenticated', 'public.partner_invites', 'UPDATE') then
    raise exception 'partner_invites is written by the server alone';
  end if;
  if has_table_privilege('anon', 'public.partner_applications', 'SELECT')
     or has_table_privilege('anon', 'public.partner_applications', 'INSERT')
     or has_table_privilege('authenticated', 'public.partner_applications', 'INSERT') then
    raise exception 'partner_applications is written by the server alone';
  end if;
end $t$;

-- A signed-in farmer reads nothing of an application.
insert into public.partner_applications (business_name, kind, contact_name, email, phone, area, offer)
values ('TJ Service', 'mechanic', 'TJ', 'tj@service.test', '0825550134', 'Lowveld', 'Repairs');
select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"e4100000-0000-4000-9000-000000000001","role":"authenticated"}', true);
set local role authenticated;
do $t$
begin
  if (select count(*) from public.partner_applications) <> 0 then
    raise exception 'a farmer can read partner applications';
  end if;
  -- Their own farm's link, without its hashes.
  if (select count(*) from public.partner_invites where farm_id = 'e4000000-0000-4000-9000-000000000001') < 1 then
    raise exception 'the owner cannot see their own links';
  end if;
end $t$;
reset role;

-- One open application per address.
do $t$
begin
  begin
    insert into public.partner_applications (business_name, kind, contact_name, email, phone, area, offer)
    values ('TJ again', 'mechanic', 'TJ', 'TJ@Service.test', '0825550134', 'Lowveld', 'Repairs');
    raise exception 'a second open application was accepted';
  exception when unique_violation then null;
  end;
end $t$;

rollback;
