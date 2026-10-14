-- 20261014100000_admin_requires_two_step.sql
-- Rapid Rise's powers need the second factor, in the database too (B9).
--
-- A Rapid Rise account reaches every farm. The app now asks its staff for a code from an
-- authenticator app before anything else (src/lib/mfa.ts), but a stolen password used
-- straight against the API never sees the app. So the database decides as well: a session
-- counts as Rapid Rise only when the code was given in it (`aal2` in its token). With the
-- password alone it is a signed-in person with no farm, who can read their own profile and
-- set their code up, and nothing more. Farm users' sessions are judged exactly as before.
--
-- Admin power reaches the policies through three helpers, all changed here: is_rr_admin()
-- (and has_farm_access(), which uses it), current_app_role() and effective_farm_role().
-- Two functions read users.role themselves to GRANT something, and are changed too:
-- job_card_worker(), which lets Rapid Rise work any job card, and the QR re-issue guard.
-- Every other mention of 'rr_admin' in the database either goes through these helpers or
-- refuses rather than grants (audited on production before this was written).

create or replace function app.session_mfa_verified() returns boolean
language sql stable set search_path = public, pg_temp as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

comment on function app.session_mfa_verified() is
  'Whether the current session gave a second factor (aal2). Rapid Rise''s powers need it.';

revoke execute on function app.session_mfa_verified() from public, anon;
grant execute on function app.session_mfa_verified() to authenticated, service_role;

create or replace function app.current_app_role() returns user_role
language sql stable security definer set search_path = public, pg_temp as $$
  -- Rapid Rise without the code given this session has no role at all.
  select case when role = 'rr_admin' and not app.session_mfa_verified() then null else role end
    from public.users
   where id = auth.uid() and active and deleted_at is null;
$$;

create or replace function app.is_rr_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.session_mfa_verified() and exists (
    select 1 from public.users
    where id = auth.uid() and role = 'rr_admin' and active and deleted_at is null
  );
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
    return case when app.session_mfa_verified() then 'rr_admin'::user_role end;
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
      (actor.role = 'rr_admin' and (app.session_mfa_verified() or current_setting('role',true) = 'service_role'))
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
       and ((u.role = 'rr_admin' and app.session_mfa_verified()) or u.farm_id = new.farm_id);
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
