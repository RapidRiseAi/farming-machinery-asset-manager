-- 0100_rls_helpers.sql
-- Helper functions that drive every RLS policy. They are SECURITY DEFINER so they
-- can read users/workshop_links without being subject to those tables' RLS
-- (avoids infinite recursion in policies). On Supabase these are owned by `postgres`
-- (BYPASSRLS); locally by the migration superuser.
--
-- The tenancy model:
--   * rr_admin        → access to ALL farms
--   * farm user       → access to their own farm_id
--   * workshop staff  → access to farms with an ACTIVE workshop_link to their workshop

create schema if not exists app;

create or replace function app.current_app_role() returns user_role
language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.users
  where id = auth.uid() and active and deleted_at is null;
$$;

create or replace function app.is_rr_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role = 'rr_admin' and active and deleted_at is null
  );
$$;

create or replace function app.user_farm_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select farm_id from public.users
  where id = auth.uid() and active and deleted_at is null;
$$;

create or replace function app.user_workshop_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select workshop_id from public.users
  where id = auth.uid() and active and deleted_at is null;
$$;

-- The single predicate used by nearly every policy.
create or replace function app.has_farm_access(fid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select
    app.is_rr_admin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.active and u.deleted_at is null and u.farm_id = fid
    )
    or exists (
      select 1
      from public.workshop_links wl
      join public.users u on u.id = auth.uid() and u.active and u.deleted_at is null
      where wl.farm_id = fid
        and wl.workshop_id = u.workshop_id
        and wl.status = 'active'
        and wl.deleted_at is null
    );
$$;

-- Convenience: the set of farm ids the current user may touch (for app queries).
create or replace function app.accessible_farm_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select f.id from public.farms f
    where app.is_rr_admin() and f.deleted_at is null
  union
  select u.farm_id from public.users u
    where u.id = auth.uid() and u.farm_id is not null and u.active and u.deleted_at is null
  union
  select wl.farm_id
    from public.workshop_links wl
    join public.users u on u.id = auth.uid() and u.active and u.deleted_at is null
    where wl.workshop_id = u.workshop_id and wl.status = 'active' and wl.deleted_at is null;
$$;

grant usage on schema app to authenticated, service_role;
grant execute on all functions in schema app to authenticated, service_role;
