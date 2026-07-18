-- 0204_settings.sql
-- Farm settings are RR-admin-only to UPDATE at the row level (tier/status are billing).
-- This guarded RPC lets a farm's owner/manager change only `settings` (thresholds,
-- approval, cost visibility, quiet hours, language) without opening up tier/status.

create or replace function public.update_farm_settings(p_farm uuid, p_settings jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_rr_admin()
     and not exists (
       select 1 from users
       where id = auth.uid() and farm_id = p_farm and role in ('owner','manager')
         and active and deleted_at is null
     ) then
    raise exception 'not allowed to change settings for this farm';
  end if;
  update farms set settings = coalesce(settings, '{}'::jsonb) || p_settings where id = p_farm;
end $$;

revoke execute on function public.update_farm_settings(uuid, jsonb) from public, anon;
grant execute on function public.update_farm_settings(uuid, jsonb) to authenticated;
