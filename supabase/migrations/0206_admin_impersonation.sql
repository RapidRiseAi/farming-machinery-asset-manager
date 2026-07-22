-- 0206_admin_impersonation.sql
-- RR-admin "act into a farm" (support access) audit trail (Scope §4.9: impersonate
-- for support — logged). A guarded RPC writes one append-only audit_log row every
-- time an admin enters a farm's workspace. Service-template LIBRARY management needs
-- no new policy — the existing st_ins/st_upd/st_del policies (0101) already let an
-- rr_admin CRUD global templates (farm_id null).

create or replace function public.log_admin_farm_access(p_farm uuid, p_action text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_rr_admin() then
    raise exception 'only RR admin may record farm access';
  end if;
  insert into audit_log (farm_id, user_id, entity, entity_id, action, diff)
  values (
    p_farm, auth.uid(), 'admin_farm_access', p_farm,
    coalesce(nullif(btrim(p_action), ''), 'impersonate'),
    jsonb_build_object('admin', auth.uid(), 'at', now())
  );
end $$;

revoke execute on function public.log_admin_farm_access(uuid, text) from public, anon;
grant  execute on function public.log_admin_farm_access(uuid, text) to authenticated;
