-- 20261014120000_test_account_fence.sql
-- Test accounts walled off from real ones (founder's decision, 2026-10-14).
--
-- FleetWise keeps test accounts on production: the founder's personas for every role and
-- partner type, and the click-through owner the automatic checks sign in as. Their
-- passwords are shared and live in a file, so they are the accounts most likely to leak.
-- Real customers and Rapid Rise's real admin must not depend on them staying secret. So:
--
--   1. Farms, workshops and accounts carry a test mark (farms.is_test since
--      20261014110000; workshops.is_test and users.is_test here). Today every farm and
--      workshop on production is a test one, and so is every account in them.
--   2. A test account never holds Rapid Rise's powers, whatever its role says: the gate
--      B9 put on them (the second factor) now also asks that the account is not a test one
--      (app.rr_admin_unlocked). The founder's real admin is team@rapidriseai.com.
--   3. Test and real never mix: every row that ties a farm to a workshop (every table with
--      both columns, checked by test_account_fence.sql) and the rows that tie a person to a
--      farm (accounts, memberships, permission grants, driver credentials, AI limits, report
--      recipients, a job card's mechanic) must be test on both sides or real on both.
--      Triggers check it, so it holds for every path that writes, the API and SECURITY
--      DEFINER functions alike. Records the server writes about a person's own actions
--      (audit, AI usage, notifications and the like) are deliberately not fenced; the test
--      lists them. A new account takes its mark from the farm or workshop it is created in.
--   4. Only Rapid Rise (or the server) changes a mark, and a farm or workshop only changes
--      sides in a direct database session that lifts the fence for one transaction
--      (set local app.test_fence = 'off'), never through the API.
--   5. Guardrails, because a test login is the easiest to lose: a test farm's AI and voice
--      spending is capped at the trial amount whatever the owner sets, and the mail the app
--      sends for it may only go to test addresses (public.email_recipients_allowed, asked by
--      the app's one sender before every message). Supabase Auth's own mail (sign-in links,
--      password resets) goes only to the account's own address and does not pass through it.

-- == The marks ======================================================================
alter table public.workshops add column if not exists is_test boolean not null default false;
alter table public.users add column if not exists is_test boolean not null default false;

comment on column public.workshops.is_test is
  'A workshop Rapid Rise uses for tests or demos. Never linked with a real farm. Set by Rapid Rise only.';
comment on column public.users.is_test is
  'A test account: never Rapid Rise, never in a real farm or workshop. Set by Rapid Rise only.';

-- Production's test data on 2026-10-14: every farm and workshop there, the accounts in
-- them, the founder's therandomneon personas (one of them a Rapid Rise admin with no farm)
-- and anything on fleetwise.test. The farm and workshop ids are production's; a database
-- seeded from supabase/seed/ has the demo ones too, which are test data there as well.
update public.farms set is_test = true
 where id in ('aa000000-0000-0000-0000-000000000001',   -- Weltevrede Boerdery
              'aa000000-0000-0000-0000-000000000002',   -- Rooikoppies Plaas
              'e9afc350-685d-4078-8480-03f19726275f',   -- Rapid Rise AI (sign-up test)
              'f0000000-0000-4000-8000-00000000fa01');  -- Click-through Test Farm
update public.workshops set is_test = true
 where id in ('bb000000-0000-0000-0000-000000000001', 'bb000000-0000-0000-0000-000000000002',
              'bb000000-0000-0000-0000-000000000003', 'bb000000-0000-0000-0000-000000000004',
              'bb000000-0000-0000-0000-000000000005', 'bb000000-0000-0000-0000-000000000006',
              'bb000000-0000-0000-0000-000000000007');
update public.users u set is_test = true
 where u.farm_id in (select id from public.farms where is_test)
    or u.workshop_id in (select id from public.workshops where is_test)
    or u.id in (select a.id from auth.users a
                 where lower(a.email) like 'therandomneon+%@gmail.com'
                    or lower(a.email) like '%@fleetwise.test');

-- == What is test ===================================================================
create or replace function app.farm_is_test(p_farm uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select is_test from public.farms where id = p_farm), false);
$$;

create or replace function app.workshop_is_test(p_workshop uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select is_test from public.workshops where id = p_workshop), false);
$$;

create or replace function app.user_is_test(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select is_test from public.users where id = p_user), false);
$$;

create or replace function app.session_is_test() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.user_is_test(auth.uid());
$$;

-- Only a direct database session (a migration, or Rapid Rise in the SQL editor) can lift
-- the fence, for one transaction, to move a farm or workshop between test and real. An API
-- request runs as anon, authenticated or service_role and never can.
create or replace function app.test_fence_lifted() returns boolean
language sql stable set search_path = public, pg_temp as $$
  -- An allow-list: no role switched on (an API request always switches to one) and the
  -- session opened by the database's own administrators.
  select coalesce(current_setting('app.test_fence', true), '') = 'off'
     and coalesce(nullif(current_setting('role', true), ''), 'none') = 'none'
     and session_user in ('postgres', 'supabase_admin');
$$;

revoke execute on function app.farm_is_test(uuid), app.workshop_is_test(uuid), app.user_is_test(uuid),
  app.session_is_test(), app.test_fence_lifted() from public, anon;
grant execute on function app.farm_is_test(uuid), app.workshop_is_test(uuid), app.user_is_test(uuid),
  app.session_is_test(), app.test_fence_lifted() to authenticated, service_role;

-- == Rapid Rise's powers: the second factor, and never a test account ==================
create or replace function app.rr_admin_unlocked() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.session_mfa_verified() and not app.session_is_test();
$$;

comment on function app.rr_admin_unlocked() is
  'Whether this session may use Rapid Rise''s powers: it gave a second factor (B9) and is not a test account.';

revoke execute on function app.rr_admin_unlocked() from public, anon;
grant execute on function app.rr_admin_unlocked() to authenticated, service_role;

-- The app asks the database the same question before it uses the service key on Rapid
-- Rise's behalf, so the app and the database cannot disagree about who is Rapid Rise.
create or replace function public.session_is_rapid_rise() returns boolean
language sql stable security invoker set search_path = public, pg_temp as $$
  select app.is_rr_admin();
$$;

revoke execute on function public.session_is_rapid_rise() from public, anon;
grant execute on function public.session_is_rapid_rise() to authenticated, service_role;

-- The five functions B9 gave the second-factor check, unchanged apart from asking
-- app.rr_admin_unlocked() instead (generated from 20261014100000).

create or replace function app.current_app_role() returns user_role
language sql stable security definer set search_path = public, pg_temp as $$
  -- Rapid Rise without the code given this session has no role at all.
  select case when role = 'rr_admin' and not app.rr_admin_unlocked() then null else role end
    from public.users
   where id = auth.uid() and active and deleted_at is null;
$$;

create or replace function app.is_rr_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role = 'rr_admin' and active and deleted_at is null
  ) and app.rr_admin_unlocked();
$$;

create or replace function app.effective_farm_role(
  p_user uuid,
  p_farm uuid
) returns user_role
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user public.users%rowtype;
  v_role user_role;
begin
  -- Do not make this helper an arbitrary-user role oracle. Every app call asks for
  -- the caller's own effective role; SECURITY DEFINER only bypasses users/membership
  -- RLS so the answer cannot be distorted by the selected farm.
  if p_user is null or p_farm is null or auth.uid() is distinct from p_user then
    return null;
  end if;

  select * into v_user
    from public.users
   where id = p_user
     and active
     and deleted_at is null;
  if not found then
    return null;
  end if;

  if v_user.role = 'rr_admin' then
    -- Rapid Rise only with the code given in this session (20261014100000).
    return case when app.rr_admin_unlocked() then 'rr_admin'::user_role end;
  end if;
  if v_user.role = 'workshop' then
    return null;
  end if;

  -- An active membership is authoritative on every selected farm, including the
  -- primary farm. users.role is a compatibility fallback only for older primary-farm
  -- rows that predate the membership backfill.
  select m.role into v_role
    from public.user_farm_memberships m
   where m.user_id = p_user
     and m.farm_id = p_farm
     and m.active
     and m.deleted_at is null;

  if v_role is not null then
    return v_role;
  end if;

  if v_user.farm_id = p_farm
     and v_user.role in ('owner','manager','mechanic','operator') then
    return v_user.role;
  end if;

  return null;
end $$;

create or replace function app.job_card_worker(p_actor uuid, p_card uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.job_cards j
    join public.users actor on actor.id = p_actor and actor.active and actor.deleted_at is null
    left join public.user_farm_memberships membership on membership.user_id = actor.id
      and membership.farm_id = j.farm_id and membership.active and membership.deleted_at is null
    where j.id = p_card and j.deleted_at is null
      and (auth.uid() = p_actor or current_setting('role',true) = 'service_role') and (
      (actor.role = 'rr_admin' and not actor.is_test and (app.rr_admin_unlocked() or current_setting('role',true) = 'service_role'))
      or (actor.role <> 'workshop' and j.workshop_id is null
          and coalesce(membership.role, case when actor.farm_id = j.farm_id then actor.role end)
            in ('owner','manager','mechanic') and
          (j.work_mode = 'internal' or coalesce(membership.role,
            case when actor.farm_id = j.farm_id then actor.role end) in ('owner','manager')))
      or exists (select 1 from public.users u join public.workshop_links l
          on l.workshop_id = u.workshop_id and l.farm_id = j.farm_id
        where u.id = p_actor and u.active and u.deleted_at is null and u.role = 'workshop'
          and u.workshop_id = j.workshop_id and l.status = 'active' and l.deleted_at is null)
    ));
$$;

create or replace function app.app_machines_guard_public_token() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid;
  v_role user_role;
begin
  if new.public_token is not distinct from old.public_token then
    return new;
  end if;

  begin v_uid := auth.uid(); exception when others then v_uid := null; end;

  -- No session at all: a migration, the seed, or a service-role server route. `anon` has
  -- zero table privileges in this schema (0102) and so can never reach an UPDATE here,
  -- and service_role is trusted by definition, it is the role that runs the public QR
  -- flow. There is nobody else in this branch.
  if v_uid is null then
    return new;
  end if;

  -- The role IN THIS FARM. An active membership is authoritative (multi-site, 0340);
  -- the profile's primary-farm role is the fallback for a user with no membership row,
  -- which is how the F7 backfill left every pre-existing account.
  select m.role into v_role
    from public.user_farm_memberships m
   where m.user_id = v_uid and m.farm_id = new.farm_id
     and m.active and m.deleted_at is null
   limit 1;

  if v_role is null then
    select u.role into v_role
      from public.users u
     where u.id = v_uid and u.active and u.deleted_at is null
       and ((u.role = 'rr_admin' and app.rr_admin_unlocked()) or u.farm_id = new.farm_id);
  end if;

  if v_role is null or v_role not in ('owner', 'manager', 'rr_admin') then
    raise exception
      'Only an owner or manager may re-issue a QR code for this vehicle'
      using errcode = '42501';
  end if;

  insert into public.audit_log(farm_id, user_id, entity, entity_id, action, diff)
  values (new.farm_id, v_uid, 'machines', new.id, 'qr_reissue',
          jsonb_build_object('machine', new.name, 'at', now()));

  return new;
end $$;

-- == Test and real never mix ===========================================================
-- An account: a new one takes its mark from the farm or workshop it is created in; after
-- that only Rapid Rise (or the server) changes it, and it must always match its farm and
-- workshop. Moving a test account into a real farm is refused even for Rapid Rise: the
-- point is that a leaked test password never opens a real farm.
create or replace function app.fence_users() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if app.test_fence_lifted() then return new; end if;
  if tg_op = 'INSERT' then
    if new.farm_id is not null then
      new.is_test := app.farm_is_test(new.farm_id);
    elsif new.workshop_id is not null then
      new.is_test := app.workshop_is_test(new.workshop_id);
    end if;
  elsif new.is_test is distinct from old.is_test and auth.uid() is not null and not app.is_rr_admin() then
    raise exception 'Only Rapid Rise can mark an account as a test account or a real one.'
      using errcode = '42501';
  end if;
  if new.farm_id is not null and app.farm_is_test(new.farm_id) is distinct from new.is_test then
    raise exception '%', case when new.is_test then 'A test account cannot join a real farm.'
                              else 'A real account cannot join a test farm.' end
      using errcode = '42501';
  end if;
  if new.workshop_id is not null and app.workshop_is_test(new.workshop_id) is distinct from new.is_test then
    raise exception '%', case when new.is_test then 'A test account cannot join a real workshop.'
                              else 'A real account cannot join a test workshop.' end
      using errcode = '42501';
  end if;
  return new;
end $$;

-- A person and a farm on one row: memberships and permission grants.
create or replace function app.fence_user_farm() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if app.test_fence_lifted() then return new; end if;
  if new.user_id is not null and new.farm_id is not null
     and app.user_is_test(new.user_id) is distinct from app.farm_is_test(new.farm_id) then
    raise exception 'Test accounts and real farms never mix.' using errcode = '42501';
  end if;
  return new;
end $$;

-- A farm and a workshop on one row: links, partner entries, job cards, requests, documents.
create or replace function app.fence_farm_workshop() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if app.test_fence_lifted() then return new; end if;
  if new.farm_id is not null and new.workshop_id is not null
     and app.farm_is_test(new.farm_id) is distinct from app.workshop_is_test(new.workshop_id) then
    raise exception 'Test and real never mix: a test workshop cannot work with a real farm, nor a real workshop with a test farm.'
      using errcode = '42501';
  end if;
  return new;
end $$;

-- A farm or workshop changing sides: only Rapid Rise or the server, and never with
-- anything of the other kind still attached (which in practice means only in a direct
-- database session with the fence lifted, moving everything together).
create or replace function app.fence_entity_mark() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.is_test is not distinct from old.is_test or app.test_fence_lifted() then
    return new;
  end if;
  if auth.uid() is not null and not app.is_rr_admin() then
    raise exception 'Only Rapid Rise can mark a farm or workshop as test or real.' using errcode = '42501';
  end if;
  if tg_table_name = 'farms' then
    if exists (select 1 from public.users u where u.farm_id = new.id and u.is_test is distinct from new.is_test)
       or exists (select 1 from public.user_farm_memberships m join public.users u on u.id = m.user_id
                   where m.farm_id = new.id and u.is_test is distinct from new.is_test)
       or exists (select 1 from public.workshop_links l join public.workshops w on w.id = l.workshop_id
                   where l.farm_id = new.id and w.is_test is distinct from new.is_test) then
      raise exception 'This farm still has people or workshops of the other kind on it.' using errcode = '23514';
    end if;
  else
    if exists (select 1 from public.users u where u.workshop_id = new.id and u.is_test is distinct from new.is_test)
       or exists (select 1 from public.workshop_links l join public.farms f on f.id = l.farm_id
                   where l.workshop_id = new.id and f.is_test is distinct from new.is_test) then
      raise exception 'This workshop still has people or farms of the other kind on it.' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

revoke execute on function app.fence_users(), app.fence_user_farm(), app.fence_farm_workshop(),
  app.fence_entity_mark() from public, anon, authenticated;

drop trigger if exists users_test_fence on public.users;
create trigger users_test_fence before insert or update on public.users
  for each row execute function app.fence_users();
drop trigger if exists user_farm_memberships_test_fence on public.user_farm_memberships;
create trigger user_farm_memberships_test_fence before insert or update on public.user_farm_memberships
  for each row execute function app.fence_user_farm();
drop trigger if exists user_permission_grants_test_fence on public.user_permission_grants;
create trigger user_permission_grants_test_fence before insert or update on public.user_permission_grants
  for each row execute function app.fence_user_farm();
drop trigger if exists document_emails_test_fence on public.document_emails;
create trigger document_emails_test_fence before insert or update on public.document_emails
  for each row execute function app.fence_farm_workshop();
drop trigger if exists job_cards_test_fence on public.job_cards;
create trigger job_cards_test_fence before insert or update on public.job_cards
  for each row execute function app.fence_farm_workshop();
drop trigger if exists partner_clients_test_fence on public.partner_clients;
create trigger partner_clients_test_fence before insert or update on public.partner_clients
  for each row execute function app.fence_farm_workshop();
drop trigger if exists partner_document_revisions_test_fence on public.partner_document_revisions;
create trigger partner_document_revisions_test_fence before insert or update on public.partner_document_revisions
  for each row execute function app.fence_farm_workshop();
drop trigger if exists partner_documents_test_fence on public.partner_documents;
create trigger partner_documents_test_fence before insert or update on public.partner_documents
  for each row execute function app.fence_farm_workshop();
drop trigger if exists partners_test_fence on public.partners;
create trigger partners_test_fence before insert or update on public.partners
  for each row execute function app.fence_farm_workshop();
drop trigger if exists recurring_invoices_test_fence on public.recurring_invoices;
create trigger recurring_invoices_test_fence before insert or update on public.recurring_invoices
  for each row execute function app.fence_farm_workshop();
drop trigger if exists work_requests_test_fence on public.work_requests;
create trigger work_requests_test_fence before insert or update on public.work_requests
  for each row execute function app.fence_farm_workshop();
drop trigger if exists workshop_links_test_fence on public.workshop_links;
create trigger workshop_links_test_fence before insert or update on public.workshop_links
  for each row execute function app.fence_farm_workshop();
drop trigger if exists farms_test_mark on public.farms;
create trigger farms_test_mark before update of is_test on public.farms
  for each row execute function app.fence_entity_mark();
drop trigger if exists workshops_test_mark on public.workshops;
create trigger workshops_test_mark before update of is_test on public.workshops
  for each row execute function app.fence_entity_mark();

-- == Guardrail: a test farm's AI and voice spending stays at the trial amount ===========
-- Unchanged from 20261004100000 apart from treating a test farm as one that has not paid.
create or replace function app.ai_effective_limit(p_farm uuid) returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_own bigint;
  v_trial bigint;
  v_default bigint;
begin
  select monthly_limit_cents into v_own from public.farm_ai_settings where farm_id = p_farm;
  select ai_trial_limit_cents, ai_default_limit_cents into v_trial, v_default
    from public.billing_settings where singleton limit 1;
  v_trial := coalesce(v_trial, 5000);
  v_default := coalesce(v_default, 20000);
  if app.farm_is_test(p_farm) or not app.ai_farm_has_paid(p_farm) then
    return least(coalesce(v_own, v_trial), v_trial);
  end if;
  return coalesce(v_own, v_default);
end $$;

create or replace function app.ai_max_owner_limit(p_farm uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case when app.ai_farm_has_paid(p_farm) and not app.farm_is_test(p_farm)
                 then ai_max_owner_limit_cents else ai_trial_limit_cents end
       from public.billing_settings where singleton limit 1),
    5000)
$$;

-- == Guardrail: a test farm, workshop or account only emails test addresses ============
-- Test addresses are a domain reserved for tests (example.com, .net and .org, and anything
-- under .example, .test, .invalid or .localhost) or an inbox on Rapid Rise's own list.
-- Never an address a test account typed in itself: a person can edit their own profile
-- email, so trusting it would let a leaked test login allow any address it liked.
create table if not exists app.test_email_inboxes (
  pattern text primary key check (pattern = lower(pattern) and pattern like '%@%'),
  note    text not null default ''
);
comment on table app.test_email_inboxes is
  'Inboxes test farms may email besides reserved test domains (LIKE patterns). Rapid Rise only.';
alter table app.test_email_inboxes enable row level security;
revoke all on app.test_email_inboxes from public, anon, authenticated;
insert into app.test_email_inboxes (pattern, note) values
  ('therandomneon@gmail.com', 'the founder''s test inbox'),
  ('therandomneon+%@gmail.com', 'the founder''s test personas')
on conflict (pattern) do nothing;

create or replace function public.email_recipients_allowed(p_farm uuid, p_workshop uuid, p_user uuid, p_to text[])
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_addr text;
begin
  if not (app.farm_is_test(p_farm) or app.workshop_is_test(p_workshop) or app.user_is_test(p_user)) then
    return true;
  end if;
  foreach v_addr in array coalesce(p_to, '{}'::text[]) loop
    v_addr := lower(btrim(v_addr));
    continue when v_addr = '';
    -- One bare address, nothing else: a list ("victim@gmail.com, x@example.com") or a
    -- display name would otherwise pass on whatever came last.
    if v_addr !~ '^[^@\s,;<>"()]+@[^@\s,;<>"()]+$' then
      return false;
    end if;
    continue when v_addr ~ '^[^@]+@(([a-z0-9-]+\.)*example\.(com|net|org)|([a-z0-9-]+\.)+(example|test|invalid|localhost))$';
    continue when exists (select 1 from app.test_email_inboxes i where v_addr like i.pattern);
    return false;
  end loop;
  return true;
end $$;

revoke execute on function public.email_recipients_allowed(uuid, uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.email_recipients_allowed(uuid, uuid, uuid, text[]) to service_role;

-- == Rapid Rise's alerts go to the real Rapid Rise only =================================
-- Unchanged from 20260910200000 apart from leaving test accounts out: these alerts carry
-- real farms' support tickets and disputes, and a test admin must never be sent them.
create or replace function app.notify_rr_billing(
  p_farm uuid, p_template text, p_payload jsonb
) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sent integer;
begin
  if p_farm is null then
    return 0;   -- notifications.farm_id is NOT NULL; an event we cannot place is not an alert
  end if;

  insert into public.notifications (farm_id, user_id, channel, template, payload, status)
  select p_farm, u.id, 'inapp', p_template, p_payload, 'queued'
  from public.users u
  where u.role = 'rr_admin' and u.active and u.deleted_at is null and not u.is_test
    and coalesce(u.notify_inapp, true);

  get diagnostics v_sent = row_count;
  return v_sent;
end $$;

-- == The service role's own Rapid Rise checks leave test accounts out ===================
-- A service-role call carries no session, so it cannot ask for the second factor; it can
-- still refuse a test account. Callers must pass a person the app has confirmed
-- (public.session_is_rapid_rise()), which the app's profile loader guarantees.
-- Unchanged from 20261004100000 apart from the test check.
create or replace function app.ai_member_role(p_user uuid, p_farm uuid) returns user_role
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_user public.users%rowtype;
  v_role user_role;
begin
  if p_user is null or p_farm is null then
    return null;
  end if;
  select * into v_user from public.users where id = p_user and active and deleted_at is null;
  if not found then
    return null;
  end if;
  if v_user.role = 'rr_admin' then
    return case when v_user.is_test then null else 'rr_admin'::user_role end;
  end if;
  if v_user.role = 'workshop' then
    return null;
  end if;
  select m.role into v_role from public.user_farm_memberships m
   where m.user_id = p_user and m.farm_id = p_farm and m.active and m.deleted_at is null;
  if v_role is not null then
    return v_role;
  end if;
  if v_user.farm_id = p_farm and v_user.role in ('owner', 'manager', 'mechanic', 'operator') then
    return v_user.role;
  end if;
  return null;
end $$;

-- The service-only offline capture: a test account with a Rapid Rise role is refused, even
-- through the server. Rewritten in place, as 20260927160340 rewrote it, so that every later
-- change to it is kept; it stops if the line it changes has moved.
do $$
declare
  v_definition text;
  v_old text;
begin
  v_definition := pg_get_functiondef('public.apply_offline_capture(uuid,timestamp with time zone,text,text,uuid,jsonb)'::regprocedure);
  if position('A test account is never Rapid Rise (20261014120000)' in v_definition) > 0 then
    return;  -- already rewritten by an earlier run of this migration
  end if;
  v_old := $old$    if v_user.role in ('rr_admin','workshop') then
      v_role := v_user.role;$old$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Offline capture role branch changed: review before applying';
  end if;
  v_definition := replace(v_definition, v_old, $new$    -- A test account is never Rapid Rise (20261014120000), even through the server.
    if v_user.role = 'rr_admin' and v_user.is_test then
      raise exception 'forbidden' using errcode = '42501';
    elsif v_user.role in ('rr_admin','workshop') then
      v_role := v_user.role;$new$);
  execute v_definition;
end $$;

-- == More person-and-farm rows behind the fence ==========================================
-- A driver's credentials, a member's AI limit and a report's recipient each tie a person to
-- a farm. A job card's mechanic does too; a real Rapid Rise admin may still be assigned to
-- any farm's work, a test account only to a test farm's.
drop trigger if exists driver_credentials_test_fence on public.driver_credentials;
create trigger driver_credentials_test_fence before insert or update on public.driver_credentials
  for each row execute function app.fence_user_farm();
drop trigger if exists farm_member_ai_limits_test_fence on public.farm_member_ai_limits;
create trigger farm_member_ai_limits_test_fence before insert or update on public.farm_member_ai_limits
  for each row execute function app.fence_user_farm();
drop trigger if exists report_schedule_recipients_test_fence on public.report_schedule_recipients;
create trigger report_schedule_recipients_test_fence before insert or update on public.report_schedule_recipients
  for each row execute function app.fence_user_farm();

create or replace function app.fence_job_card_mechanic() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if app.test_fence_lifted() or new.mechanic_user_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.mechanic_user_id is not distinct from old.mechanic_user_id
     and new.farm_id is not distinct from old.farm_id then
    return new;
  end if;
  if app.user_is_test(new.mechanic_user_id) is distinct from app.farm_is_test(new.farm_id)
     and not exists (select 1 from public.users u where u.id = new.mechanic_user_id
                      and u.role = 'rr_admin' and not u.is_test) then
    raise exception 'Test accounts and real farms never mix.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function app.fence_job_card_mechanic() from public, anon, authenticated;
drop trigger if exists job_cards_mechanic_test_fence on public.job_cards;
create trigger job_cards_mechanic_test_fence before insert or update on public.job_cards
  for each row execute function app.fence_job_card_mechanic();

-- == The marks agree everywhere before this commits ====================================
do $$
declare v text;
begin
  select string_agg(problem, '; ') into v from (
    select 'account ' || u.id || ' and its farm' as problem from public.users u join public.farms f on f.id = u.farm_id where u.is_test <> f.is_test
    union all select 'account ' || u.id || ' and its workshop' from public.users u join public.workshops w on w.id = u.workshop_id where u.is_test <> w.is_test
    union all select 'membership ' || m.id from public.user_farm_memberships m join public.users u on u.id = m.user_id join public.farms f on f.id = m.farm_id where u.is_test <> f.is_test
    union all select 'grant ' || g.id from public.user_permission_grants g join public.users u on u.id = g.user_id join public.farms f on f.id = g.farm_id where u.is_test <> f.is_test
    union all select 'driver credential ' || d.id from public.driver_credentials d join public.users u on u.id = d.user_id join public.farms f on f.id = d.farm_id where u.is_test <> f.is_test
    union all select 'AI limit ' || a.farm_id || '/' || a.user_id from public.farm_member_ai_limits a join public.users u on u.id = a.user_id join public.farms f on f.id = a.farm_id where u.is_test <> f.is_test
    union all select 'report recipient ' || r.id from public.report_schedule_recipients r join public.users u on u.id = r.user_id join public.farms f on f.id = r.farm_id where u.is_test <> f.is_test
    union all select 'workshop link ' || l.id from public.workshop_links l join public.farms f on f.id = l.farm_id join public.workshops w on w.id = l.workshop_id where f.is_test <> w.is_test
    union all select 'partner ' || p.id from public.partners p join public.farms f on f.id = p.farm_id join public.workshops w on w.id = p.workshop_id where f.is_test <> w.is_test
    union all select 'client ' || c.id from public.partner_clients c join public.farms f on f.id = c.farm_id join public.workshops w on w.id = c.workshop_id where f.is_test <> w.is_test
    union all select 'job card ' || j.id from public.job_cards j join public.farms f on f.id = j.farm_id join public.workshops w on w.id = j.workshop_id where f.is_test <> w.is_test
    union all select 'work request ' || r.id from public.work_requests r join public.farms f on f.id = r.farm_id join public.workshops w on w.id = r.workshop_id where f.is_test <> w.is_test
    union all select 'document email ' || e.id from public.document_emails e join public.farms f on f.id = e.farm_id join public.workshops w on w.id = e.workshop_id where f.is_test <> w.is_test
    union all select 'partner document ' || d.id from public.partner_documents d join public.farms f on f.id = d.farm_id join public.workshops w on w.id = d.workshop_id where f.is_test <> w.is_test
    union all select 'document revision ' || d.id from public.partner_document_revisions d join public.farms f on f.id = d.farm_id join public.workshops w on w.id = d.workshop_id where f.is_test <> w.is_test
    union all select 'recurring invoice ' || r.id from public.recurring_invoices r join public.farms f on f.id = r.farm_id join public.workshops w on w.id = r.workshop_id where f.is_test <> w.is_test
    union all select 'job card mechanic ' || j.id from public.job_cards j join public.users u on u.id = j.mechanic_user_id join public.farms f on f.id = j.farm_id
               where u.is_test <> f.is_test and not (u.role = 'rr_admin' and not u.is_test)
  ) x;
  if v is not null then
    raise exception 'test marks disagree after marking: %', left(v, 500);
  end if;
  -- And Rapid Rise keeps a real admin: wherever team@rapidriseai.com has an account it must
  -- be an active, real Rapid Rise admin after the marking, never swept up as a test one.
  if exists (select 1 from auth.users a left join public.users u on u.id = a.id
              where lower(a.email) = 'team@rapidriseai.com'
                and u.id is not null and (u.is_test or u.role <> 'rr_admin' or not u.active)) then
    raise exception 'team@rapidriseai.com would not be a real, active Rapid Rise admin after this migration';
  end if;
end $$;
