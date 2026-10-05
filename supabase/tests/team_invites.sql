\set ON_ERROR_STOP on
-- public.team_invite_existing: what inviting an address to a farm does to the login that
-- already has it. Every outcome, the inviter check, the grants, and the reason some
-- people move: a person whose home farm is an unpaid sign-up must survive the sweep.
begin;
select set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, status, deleted_at) values
 ('ae000000-0000-4000-8000-0000000000b0', 'Inviting farm',      'active',    null),
 ('ae000000-0000-4000-8000-0000000000a1', 'Real farm',          'active',    null),
 ('ae000000-0000-4000-8000-0000000000a2', 'Abandoned sign-up',  'active',    null),
 ('ae000000-0000-4000-8000-0000000000a3', 'Closed farm',        'cancelled', null),
 ('ae000000-0000-4000-8000-0000000000a4', 'Lapsed, reopened',   'active',    null),
 ('ae000000-0000-4000-8000-0000000000a5', 'Swept sign-up',      'cancelled', now());
insert into public.billing_subscriptions (farm_id, plan, status, created_at) values
 ('ae000000-0000-4000-8000-0000000000a2', 'professional', 'pending', now() - interval '10 days'),
 ('ae000000-0000-4000-8000-0000000000a4', 'professional', 'pending', now() - interval '400 days');
-- The reopened farm paid once, long ago. The abandoned one never did.
insert into public.billing_payments (farm_id, amount_incl_cents) values
 ('ae000000-0000-4000-8000-0000000000a4', 49900);
insert into public.workshops (id, name) values
 ('ae600000-0000-4000-8000-000000000001', 'Partner workshop');

insert into auth.users (id, email, banned_until) values
 ('ae100000-0000-4000-8000-000000000001', 'owner@invite.test',          null),
 ('ae100000-0000-4000-8000-000000000002', 'operator@invite.test',       null),
 ('ae100000-0000-4000-8000-000000000003', 'already@invite.test',        null),
 ('ae100000-0000-4000-8000-000000000004', 'off@invite.test',            null),
 ('ae100000-0000-4000-8000-000000000005', 'member@invite.test',         null),
 ('ae100000-0000-4000-8000-000000000006', 'member-off@invite.test',     null),
 ('ae100000-0000-4000-8000-000000000007', 'real-owner@invite.test',     null),
 ('ae100000-0000-4000-8000-000000000008', 'abandoned@invite.test',      null),
 ('ae100000-0000-4000-8000-000000000009', 'closed-worker@invite.test',  null),
 ('ae100000-0000-4000-8000-000000000010', 'closed-owner@invite.test',   null),
 ('ae100000-0000-4000-8000-000000000011', 'lapsed-owner@invite.test',   null),
 ('ae100000-0000-4000-8000-000000000012', 'lapsed-worker@invite.test',  null),
 ('ae100000-0000-4000-8000-000000000013', 'swept@invite.test',          null),
 ('ae100000-0000-4000-8000-000000000014', 'left-home@invite.test',      null),
 ('ae100000-0000-4000-8000-000000000015', 'erased@invite.test',         null),
 ('ae100000-0000-4000-8000-000000000016', 'banned@invite.test',         now() + interval '100 years'),
 ('ae100000-0000-4000-8000-000000000017', 'staff@invite.test',          null),
 ('ae100000-0000-4000-8000-000000000018', 'workshop@invite.test',       null),
 ('ae100000-0000-4000-8000-000000000019', 'orphan@invite.test',         null),
 ('ae100000-0000-4000-8000-000000000020', 'abandoned-worker@invite.test', null);

insert into public.users (id, farm_id, workshop_id, role, name, email, language, active, deleted_at) values
 ('ae100000-0000-4000-8000-000000000001', 'ae000000-0000-4000-8000-0000000000b0', null, 'owner',    'Owner',          'owner@invite.test',         'en', true,  null),
 ('ae100000-0000-4000-8000-000000000002', 'ae000000-0000-4000-8000-0000000000b0', null, 'operator', 'Operator',       'operator@invite.test',      'en', true,  null),
 ('ae100000-0000-4000-8000-000000000003', 'ae000000-0000-4000-8000-0000000000b0', null, 'operator', 'Already',        'already@invite.test',       'af', true,  null),
 ('ae100000-0000-4000-8000-000000000004', 'ae000000-0000-4000-8000-0000000000b0', null, 'operator', 'Off',            'off@invite.test',           'en', false, null),
 ('ae100000-0000-4000-8000-000000000005', 'ae000000-0000-4000-8000-0000000000a1', null, 'operator', 'Member',         'member@invite.test',        'en', true,  null),
 ('ae100000-0000-4000-8000-000000000006', 'ae000000-0000-4000-8000-0000000000a1', null, 'operator', 'Member off',     'member-off@invite.test',    'en', true,  null),
 ('ae100000-0000-4000-8000-000000000007', 'ae000000-0000-4000-8000-0000000000a1', null, 'owner',    'Real owner',     'real-owner@invite.test',    'af', true,  null),
 ('ae100000-0000-4000-8000-000000000008', 'ae000000-0000-4000-8000-0000000000a2', null, 'owner',    'Abandoned',      'abandoned@invite.test',     'en', true,  null),
 ('ae100000-0000-4000-8000-000000000009', 'ae000000-0000-4000-8000-0000000000a3', null, 'operator', 'Closed worker',  'closed-worker@invite.test', 'en', true,  null),
 ('ae100000-0000-4000-8000-000000000010', 'ae000000-0000-4000-8000-0000000000a3', null, 'owner',    'Closed owner',   'closed-owner@invite.test',  'en', true,  null),
 ('ae100000-0000-4000-8000-000000000011', 'ae000000-0000-4000-8000-0000000000a4', null, 'owner',    'Lapsed owner',   'lapsed-owner@invite.test',  'en', true,  null),
 ('ae100000-0000-4000-8000-000000000012', 'ae000000-0000-4000-8000-0000000000a4', null, 'mechanic', 'Lapsed worker',  'lapsed-worker@invite.test', 'en', true,  null),
 ('ae100000-0000-4000-8000-000000000013', 'ae000000-0000-4000-8000-0000000000a5', null, 'owner',    'Swept',          'swept@invite.test',         'en', false, now() - interval '3 days'),
 ('ae100000-0000-4000-8000-000000000014', 'ae000000-0000-4000-8000-0000000000a1', null, 'operator', 'Left home',      'left-home@invite.test',     'en', false, null),
 ('ae100000-0000-4000-8000-000000000015', 'ae000000-0000-4000-8000-0000000000a1', null, 'operator', '[erased]',       null,                        'en', false, now() - interval '1 day'),
 ('ae100000-0000-4000-8000-000000000016', 'ae000000-0000-4000-8000-0000000000a1', null, 'operator', 'Banned',         'banned@invite.test',        'en', true,  null),
 ('ae100000-0000-4000-8000-000000000017', null,                                   null, 'rr_admin', 'Staff',          'staff@invite.test',         'en', true,  null),
 ('ae100000-0000-4000-8000-000000000018', null, 'ae600000-0000-4000-8000-000000000001', 'workshop', 'Workshop', 'workshop@invite.test',              'en', true,  null),
 ('ae100000-0000-4000-8000-000000000020', 'ae000000-0000-4000-8000-0000000000a2', null, 'operator', 'Abandoned worker', 'abandoned-worker@invite.test', 'en', true, null);

insert into public.user_farm_memberships (user_id, farm_id, role, active) values
 ('ae100000-0000-4000-8000-000000000001', 'ae000000-0000-4000-8000-0000000000b0', 'owner',    true),
 ('ae100000-0000-4000-8000-000000000005', 'ae000000-0000-4000-8000-0000000000b0', 'operator', true),
 ('ae100000-0000-4000-8000-000000000006', 'ae000000-0000-4000-8000-0000000000b0', 'operator', false),
 ('ae100000-0000-4000-8000-000000000008', 'ae000000-0000-4000-8000-0000000000a2', 'owner',    true),
 ('ae100000-0000-4000-8000-000000000014', 'ae000000-0000-4000-8000-0000000000a1', 'operator', true);

-- == Only the service role may call it =======================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"ae100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.team_invite_existing('ae000000-0000-4000-8000-0000000000b0',
      'ae100000-0000-4000-8000-000000000001', 'nobody@invite.test', 'operator', 'Nobody', 'en');
    raise exception 'a signed-in owner called the service-role invite function directly';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

set local role service_role;
do $$
declare
  B  constant uuid := 'ae000000-0000-4000-8000-0000000000b0';
  A1 constant uuid := 'ae000000-0000-4000-8000-0000000000a1';
  OWNER constant uuid := 'ae100000-0000-4000-8000-000000000001';
  r jsonb;
  u public.users%rowtype;
  function_outcome text;
begin
  -- == The inviter must run this farm ========================================
  begin
    perform public.team_invite_existing(B, 'ae100000-0000-4000-8000-000000000002',
      'nobody@invite.test', 'operator', 'Nobody', 'en');
    raise exception 'an operator invited somebody';
  exception when insufficient_privilege then null; end;
  begin
    perform public.team_invite_existing(B, 'ae100000-0000-4000-8000-000000000007',
      'nobody@invite.test', 'operator', 'Nobody', 'en');
    raise exception 'the owner of another farm invited somebody into this one';
  exception when insufficient_privilege then null; end;
  begin
    perform public.team_invite_existing(B, OWNER, 'nobody@invite.test', 'owner', 'Nobody', 'en');
    raise exception 'an invite made somebody an owner';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.team_invite_existing(B, OWNER, 'not-an-address', 'operator', 'Nobody', 'en');
    raise exception 'an invite accepted something that is not an email address';
  exception when invalid_parameter_value then null; end;

  -- == No login: the server action makes one =================================
  r := public.team_invite_existing(B, OWNER, 'nobody@invite.test', 'operator', 'Nobody', 'en');
  if r->>'outcome' <> 'none' then raise exception 'unknown address: %', r; end if;

  -- == A login with no profile gets one on this farm =========================
  r := public.team_invite_existing(B, OWNER, '  Orphan@Invite.TEST ', 'mechanic', 'Orphan', 'af');
  if r->>'outcome' <> 'created' or r->>'language' <> 'af' then raise exception 'orphan: %', r; end if;
  select * into u from public.users where id = 'ae100000-0000-4000-8000-000000000019';
  if u.farm_id <> B or u.role <> 'mechanic' or not u.active or u.email <> 'orphan@invite.test' then
    raise exception 'orphan profile is wrong: %', row_to_json(u);
  end if;
  if not exists (select 1 from public.user_farm_memberships
                  where user_id = u.id and farm_id = B and role = 'mechanic' and active) then
    raise exception 'orphan has no membership';
  end if;
  r := public.team_invite_existing(B, OWNER, 'orphan@invite.test', 'operator', 'Orphan', 'en');
  if r->>'outcome' <> 'already' then raise exception 'a second invite of the orphan: %', r; end if;

  -- == Already here: nothing changes =========================================
  r := public.team_invite_existing(B, OWNER, 'ALREADY@invite.test', 'manager', 'X', 'en');
  if r->>'outcome' <> 'already' or r->>'name' <> 'Already' or r->>'language' <> 'af' then
    raise exception 'already: %', r;
  end if;
  if (select role from public.users where id = 'ae100000-0000-4000-8000-000000000003') <> 'operator' then
    raise exception 'an invite of somebody already here changed their role';
  end if;
  r := public.team_invite_existing(B, OWNER, 'member@invite.test', 'manager', 'X', 'en');
  if r->>'outcome' <> 'already' then raise exception 'active secondary member: %', r; end if;

  -- == Switched off here: the list's switch decides, not an invite ===========
  r := public.team_invite_existing(B, OWNER, 'off@invite.test', 'operator', 'X', 'en');
  if r->>'outcome' <> 'switched_off' then raise exception 'switched off: %', r; end if;
  if (select active from public.users where id = 'ae100000-0000-4000-8000-000000000004') then
    raise exception 'an invite switched a person back on over the list';
  end if;

  -- == This farm's own switched-off membership is reopened ===================
  r := public.team_invite_existing(B, OWNER, 'member-off@invite.test', 'mechanic', 'X', 'en');
  if r->>'outcome' <> 'added' then raise exception 'reopened membership: %', r; end if;
  if not exists (select 1 from public.user_farm_memberships
                  where user_id = 'ae100000-0000-4000-8000-000000000006' and farm_id = B
                    and active and role = 'mechanic') then
    raise exception 'membership was not reopened';
  end if;

  -- == A person on a real farm is added, and keeps their home farm ===========
  r := public.team_invite_existing(B, OWNER, 'real-owner@invite.test', 'manager', 'X', 'en');
  if r->>'outcome' <> 'added' or r->>'language' <> 'af' then raise exception 'real owner: %', r; end if;
  select * into u from public.users where id = 'ae100000-0000-4000-8000-000000000007';
  if u.farm_id <> A1 or u.role <> 'owner' then raise exception 'a real owner was moved'; end if;
  r := public.team_invite_existing(B, OWNER, 'real-owner@invite.test', 'manager', 'X', 'en');
  if r->>'outcome' <> 'already' then raise exception 'second invite of a member: %', r; end if;

  -- == An abandoned sign-up's owner moves, so the gate and the sweep leave them be
  r := public.team_invite_existing(B, OWNER, 'abandoned@invite.test', 'operator', 'X', 'en');
  if r->>'outcome' <> 'moved' then raise exception 'abandoned owner: %', r; end if;
  select * into u from public.users where id = 'ae100000-0000-4000-8000-000000000008';
  if u.farm_id <> B or u.role <> 'operator' or not u.active then
    raise exception 'abandoned owner did not move: %', row_to_json(u);
  end if;

  -- == A worker on a closed farm moves; its owner is added and stays =========
  r := public.team_invite_existing(B, OWNER, 'closed-worker@invite.test', 'operator', 'X', 'en');
  if r->>'outcome' <> 'moved' then raise exception 'closed worker: %', r; end if;
  r := public.team_invite_existing(B, OWNER, 'closed-owner@invite.test', 'operator', 'X', 'en');
  if r->>'outcome' <> 'added' then raise exception 'closed owner: %', r; end if;
  if (select farm_id from public.users where id = 'ae100000-0000-4000-8000-000000000010')
     <> 'ae000000-0000-4000-8000-0000000000a3' then
    raise exception 'the owner of a closed farm was moved off it';
  end if;

  -- == A farm that has paid before is a real farm: its owner stays ===========
  r := public.team_invite_existing(B, OWNER, 'lapsed-owner@invite.test', 'operator', 'X', 'en');
  if r->>'outcome' <> 'added' then raise exception 'lapsed owner: %', r; end if;
  r := public.team_invite_existing(B, OWNER, 'lapsed-worker@invite.test', 'operator', 'X', 'en');
  if r->>'outcome' <> 'moved' then raise exception 'lapsed worker: %', r; end if;

  -- == A swept profile comes back, on this farm ==============================
  r := public.team_invite_existing(B, OWNER, 'swept@invite.test', 'operator', 'X', 'en');
  if r->>'outcome' <> 'moved' then raise exception 'swept: %', r; end if;
  select * into u from public.users where id = 'ae100000-0000-4000-8000-000000000013';
  if u.farm_id <> B or not u.active or u.deleted_at is not null or u.role <> 'operator' then
    raise exception 'swept profile did not come back: %', row_to_json(u);
  end if;

  -- == Switched off by their home farm: they move, and stay off there ========
  r := public.team_invite_existing(B, OWNER, 'left-home@invite.test', 'operator', 'X', 'en');
  if r->>'outcome' <> 'moved' then raise exception 'left home: %', r; end if;
  select * into u from public.users where id = 'ae100000-0000-4000-8000-000000000014';
  if u.farm_id <> B or not u.active then raise exception 'left-home did not move'; end if;
  if exists (select 1 from public.user_farm_memberships
              where user_id = u.id and farm_id = A1 and active and deleted_at is null) then
    raise exception 'an invite undid the home farm switching this person off';
  end if;

  -- == Never a farm member ===================================================
  foreach function_outcome in array array['erased@invite.test', 'banned@invite.test',
                                          'staff@invite.test', 'workshop@invite.test'] loop
    r := public.team_invite_existing(B, OWNER, function_outcome, 'operator', 'X', 'en');
    if r->>'outcome' <> 'refused' then raise exception '% was not refused: %', function_outcome, r; end if;
  end loop;
  if (select deleted_at from public.users where id = 'ae100000-0000-4000-8000-000000000015') is null then
    raise exception 'an erased person was brought back';
  end if;
  if exists (select 1 from public.user_farm_memberships
              where user_id in ('ae100000-0000-4000-8000-000000000015', 'ae100000-0000-4000-8000-000000000016',
                                'ae100000-0000-4000-8000-000000000017', 'ae100000-0000-4000-8000-000000000018')) then
    raise exception 'a refused invite still wrote a membership';
  end if;
end $$;
reset role;

-- == The reason for moving: the sweep keeps the person who was moved =========
-- The abandoned sign-up is ten days old and never paid. The sweep cancels it and
-- switches off everybody whose HOME farm it is: its other worker, not the owner who was
-- invited away from it.
select app.sweep_dormant_signups(7);
do $$ begin
  if not (select active from public.users where id = 'ae100000-0000-4000-8000-000000000008') then
    raise exception 'the sweep switched off a person who had been invited onto a real farm';
  end if;
  if (select active from public.users where id = 'ae100000-0000-4000-8000-000000000020') then
    raise exception 'the sweep did not run, so the test above proves nothing';
  end if;
end $$;

rollback;
