-- Inviting somebody to a farm team, whether or not they already have a FleetWise login.
--
-- == What was wrong ===========================================================
-- `inviteUser` created a login and a profile and then sent nothing: the person was never
-- told, and found out only if the owner phoned them. An address that already had a login
-- failed outright with Supabase's "already registered", and that is most of the people a
-- farm actually invites: the worker who tried FleetWise on their own and never paid, the
-- one who moved from the farm down the road, the contractor who is on two farms.
--
-- == What this decides ========================================================
-- One answer per address, worked out in one transaction under a per-address lock:
--
--   none          no login has this address; the server action makes one and asks again
--   created       a login with no profile (the one just made, or a sign-up that stopped
--                 between the two writes): it gets a profile on this farm
--   already       on this farm and able to sign in; nothing changes, the link goes again
--   switched_off  this is their home farm and the farm switched them off; the list has a
--                 switch for that, and an invite does not overrule it
--   added         a member of this farm now, alongside the farm they already have
--   moved         this farm is their home farm now
--   refused       Rapid Rise staff, a workshop partner, a banned login, or a person erased
--                 at their own request: never a farm member
--
-- == Why some people move =====================================================
-- The billing gate (app.farm_billing_gate) reads the HOME farm only. A person whose home
-- farm is a sign-up that never paid is sent to /activate on every screen, whatever else
-- they belong to, and app.sweep_dormant_signups switches them off a week later. Adding a
-- membership would invite them into a farm they could not open. So they move when:
--   * their profile was swept, or their home farm switched them off,
--   * their home farm is gone, or is a sign-up that has never paid anything,
--   * their home farm is closed or unpaid and they are not its owner.
-- The OWNER of a farm that has ever paid never moves: they are the one who pays for it,
-- and /activate and /closed work from the home farm. They are added instead.
--
-- Moving away from a farm that switched somebody off leaves them switched off THERE, as a
-- membership row, so one farm's invite can never undo another farm's decision.

create or replace function public.team_invite_existing(
  p_farm     uuid,
  p_actor    uuid,
  p_email    text,
  p_role     text,
  p_name     text,
  p_language text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email       text := lower(trim(coalesce(p_email, '')));
  v_actor_role  text;
  v_auth_id     uuid;
  v_blocked     boolean;
  v_user        public.users%rowtype;
  v_member      public.user_farm_memberships%rowtype;
  v_has_member  boolean;
  v_home_gone   boolean;
  v_gate        text;
  v_never_paid  boolean;
  v_move        boolean;
  v_lang        text := case when p_language = 'af' then 'af' else 'en' end;
begin
  if p_farm is null or p_actor is null or position('@' in v_email) < 2 then
    raise exception 'A farm, an inviter and an email address are required.'
      using errcode = '22023';
  end if;
  if p_role is null or p_role not in ('manager', 'mechanic', 'operator') then
    raise exception 'A farm invite is for a manager, a mechanic or an operator.'
      using errcode = '22023';
  end if;

  -- The server action checks this first. It is repeated because this runs as the service
  -- role, and a function that trusts whoever calls it is one bug away from a hole. Worked
  -- out the way lib/auth.ts effectiveFarmRole does: an active membership is authoritative
  -- for its farm, the profile role is the fallback for the home farm.
  select coalesce(
           (select m.role::text
              from public.user_farm_memberships m
             where m.user_id = a.id and m.farm_id = p_farm
               and m.active and m.deleted_at is null),
           case when a.farm_id = p_farm then a.role::text end)
    into v_actor_role
    from public.users a
   where a.id = p_actor and a.active and a.deleted_at is null;
  if v_actor_role is null or v_actor_role not in ('owner', 'manager')
     or not exists (select 1 from public.farms f where f.id = p_farm and f.deleted_at is null) then
    raise exception 'Only an owner or manager of this farm can invite people to it.'
      using errcode = '42501';
  end if;

  -- Two invites for one address at once must not both decide. The second waits, then
  -- finds what the first one did.
  perform pg_advisory_xact_lock(hashtextextended('team-invite:' || v_email, 0));

  select u.id,
         (u.deleted_at is not null or coalesce(u.banned_until > now(), false))
    into v_auth_id, v_blocked
    from auth.users u
   where lower(u.email) = v_email
   limit 1;
  if v_auth_id is null then
    return jsonb_build_object('outcome', 'none');
  end if;
  if v_blocked then
    return jsonb_build_object('outcome', 'refused');
  end if;

  select * into v_user from public.users where id = v_auth_id for update;
  if not found then
    insert into public.users (id, farm_id, workshop_id, role, name, email, language, active)
    values (
      v_auth_id, p_farm, null, p_role::user_role,
      coalesce(nullif(trim(p_name), ''), split_part(v_email, '@', 1)),
      v_email, v_lang::app_language, true
    );
    insert into public.user_farm_memberships (user_id, farm_id, role, active)
    values (v_auth_id, p_farm, p_role::user_role, true)
    on conflict (user_id, farm_id) do update
       set role = excluded.role, active = true, deleted_at = null, deleted_by = null;
    return jsonb_build_object(
      'outcome', 'created', 'user_id', v_auth_id,
      'name', coalesce(nullif(trim(p_name), ''), split_part(v_email, '@', 1)),
      'language', v_lang);
  end if;

  if v_user.role in ('rr_admin', 'workshop') or v_user.workshop_id is not null then
    return jsonb_build_object('outcome', 'refused');
  end if;
  -- erase_personal_data blanks the address and soft-deletes the profile. A person who
  -- asked to be forgotten is not brought back by somebody else typing their email.
  if v_user.deleted_at is not null and v_user.email is null then
    return jsonb_build_object('outcome', 'refused');
  end if;

  select * into v_member
    from public.user_farm_memberships
   where user_id = v_user.id and farm_id = p_farm and deleted_at is null;
  v_has_member := found;

  if v_user.deleted_at is null and v_user.active then
    if v_user.farm_id = p_farm or (v_has_member and v_member.active) then
      return jsonb_build_object(
        'outcome', 'already', 'user_id', v_user.id,
        'name', v_user.name, 'language', v_user.language::text);
    end if;
  end if;

  if v_user.deleted_at is null and not v_user.active and v_user.farm_id = p_farm then
    return jsonb_build_object('outcome', 'switched_off', 'user_id', v_user.id);
  end if;

  select f.id is null or f.deleted_at is not null
    into v_home_gone
    from (select 1) one
    left join public.farms f on f.id = v_user.farm_id;
  v_gate := case when v_home_gone then 'closed' else app.farm_billing_gate(v_user.farm_id) end;
  -- The sweep's own test for a dormant sign-up: no payment row, ever.
  v_never_paid := not exists (
    select 1 from public.billing_payments p
     where p.farm_id = v_user.farm_id and p.deleted_at is null
  );

  v_move := v_user.deleted_at is not null
         or not v_user.active
         or v_home_gone
         or (v_gate = 'pending' and v_never_paid)
         or (v_gate <> 'ok' and v_user.role <> 'owner');

  if v_move then
    if v_user.deleted_at is null and not v_user.active then
      -- Their home farm switched them off. They stay off there.
      insert into public.user_farm_memberships (user_id, farm_id, role, active)
      values (v_user.id, v_user.farm_id, v_user.role, false)
      on conflict (user_id, farm_id) do update set active = false;
    end if;

    update public.users
       set farm_id = p_farm,
           workshop_id = null,
           role = p_role::user_role,
           active = true,
           deleted_at = null,
           deleted_by = null,
           email = coalesce(nullif(trim(email), ''), v_email)
     where id = v_user.id;
  end if;

  insert into public.user_farm_memberships (user_id, farm_id, role, active)
  values (v_user.id, p_farm, p_role::user_role, true)
  on conflict (user_id, farm_id) do update
     set role = excluded.role, active = true, deleted_at = null, deleted_by = null;

  return jsonb_build_object(
    'outcome', case when v_move then 'moved' else 'added' end,
    'user_id', v_user.id,
    'name', v_user.name,
    'language', v_user.language::text);
end $$;

comment on function public.team_invite_existing(uuid, uuid, text, text, text, text) is
  'Decides, under a per-address lock, what inviting this address to this farm does: '
  'none, created, already, switched_off, added, moved or refused. Service role only; the '
  'team invite action calls it and sends the sign-in email. See the migration header.';

revoke execute on function public.team_invite_existing(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.team_invite_existing(uuid, uuid, text, text, text, text)
  to service_role;
