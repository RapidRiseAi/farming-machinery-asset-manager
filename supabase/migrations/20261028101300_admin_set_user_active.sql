-- 20261028101300_admin_set_user_active.sql
-- Rapid Rise switches a person on a client's farm off or on again.
--
-- The client page's Deactivate button posted to the team action, which requires the
-- person pressing it to be an owner or manager OF THAT FARM, so for Rapid Rise it refused
-- every time. This is the admin's own path: SECURITY DEFINER behind app.is_rr_admin()
-- (two-step this session, never a test account), granted to `authenticated` and called
-- with the admin's own session, so auth.uid() names who did it and no page needs the
-- service key.
--
-- What it changes, and nothing more (deactivating never deletes):
--   * the person's home farm is this farm: their account (users.active), as /team does;
--   * they are a member from elsewhere: their membership of this farm only.
-- Never a Rapid Rise admin, never a contractor's account, never the admin themself.

create or replace function public.admin_set_user_active(p_farm uuid, p_user uuid, p_active boolean)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user public.users%rowtype;
begin
  if not app.is_rr_admin() then
    raise exception 'Rapid Rise only.' using errcode = '42501';
  end if;
  if p_farm is null or p_user is null or p_active is null then
    raise exception 'admin-user-invalid' using errcode = '22023';
  end if;
  if p_user = auth.uid() then
    raise exception 'admin-user-self' using errcode = '22023';
  end if;

  select * into v_user from public.users u where u.id = p_user and u.deleted_at is null for update;
  if not found or v_user.role in ('rr_admin', 'workshop') or v_user.workshop_id is not null then
    raise exception 'admin-user-invalid' using errcode = '22023';
  end if;

  if v_user.farm_id = p_farm then
    update public.users set active = p_active where id = p_user;
    return 'account';
  end if;

  update public.user_farm_memberships
     set active = p_active
   where user_id = p_user and farm_id = p_farm and deleted_at is null;
  if not found then
    raise exception 'admin-user-invalid' using errcode = '22023';
  end if;
  return 'membership';
end $$;

comment on function public.admin_set_user_active(uuid, uuid, boolean) is
  'Rapid Rise (two-step, real account) switches a person off or on for one client farm: their '
  'account when it is their home farm, else their membership. Never deletes; never an admin.';

revoke execute on function public.admin_set_user_active(uuid, uuid, boolean) from public, anon;
grant execute on function public.admin_set_user_active(uuid, uuid, boolean) to authenticated;
