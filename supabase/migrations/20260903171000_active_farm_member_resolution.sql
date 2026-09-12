-- Resolve a chosen teammate without relying on the caller's ability to SELECT that
-- teammate's secondary-farm membership row. The answer is a single boolean and only for
-- a farm the caller can already access, so it does not expose the team directory.

create or replace function app.user_belongs_to_farm(p_user uuid, p_farm uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_user is not null
     and p_farm is not null
     and app.has_farm_access(p_farm)
     and exists (
       select 1
         from public.users u
        where u.id = p_user
          and u.active
          and u.deleted_at is null
          and (
            (u.farm_id = p_farm and u.role in ('owner','manager','mechanic','operator'))
            or exists (
              select 1
                from public.user_farm_memberships m
               where m.user_id = u.id
                 and m.farm_id = p_farm
                 and m.active
                 and m.deleted_at is null
            )
          )
     );
$$;

revoke execute on function app.user_belongs_to_farm(uuid, uuid)
  from public, anon;
grant execute on function app.user_belongs_to_farm(uuid, uuid)
  to authenticated, service_role;

create or replace function public.is_active_farm_member(p_farm uuid, p_user uuid)
returns boolean
language sql stable security invoker set search_path = public, app, pg_temp as $$
  select app.user_belongs_to_farm(p_user, p_farm);
$$;

comment on function public.is_active_farm_member(uuid, uuid) is
  'RLS-safe yes/no validation for assigning an active user on a farm the caller can access.';

revoke execute on function public.is_active_farm_member(uuid, uuid)
  from public, anon;
grant execute on function public.is_active_farm_member(uuid, uuid)
  to authenticated, service_role;

