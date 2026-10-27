-- The activity log's read policy, decided once per query instead of once per row.
--
-- audit_sel (20260903074350) called is_rr_admin(), has_farm_access(), effective_farm_role()
-- and can_view_farm_costs() for EVERY row, each with queries of its own. On production
-- (2026-10-18) an owner counting their 4,900 rows took 3.7 s, about 0.75 ms a row, and the
-- log only grows: every change to anything is a row here.
--
-- Same rule, set-based: the farms whose log this person may read are worked out once (a
-- handful of farms, not thousands of rows) and each row is a lookup against that set. A row
-- is visible exactly when it was before:
--   - Rapid Rise (is_rr_admin) sees every row, now evaluated once per query;
--   - otherwise the row's farm must pass has_farm_access (so the WhatsApp narrowing and any
--     later one still apply) and, for an operator, the farm's cost visibility.
-- The candidate farms come from accessible_farm_ids(), which lists the same primary farm,
-- memberships and workshop links has_farm_access accepts.
create or replace function app.audit_readable_farm_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select a.farm_id
    from app.accessible_farm_ids() as a(farm_id)
   where app.has_farm_access(a.farm_id)
     and (
       app.effective_farm_role(auth.uid(), a.farm_id) is distinct from 'operator'
       or app.can_view_farm_costs(a.farm_id)
     );
$$;
revoke all on function app.audit_readable_farm_ids() from public, anon;
grant execute on function app.audit_readable_farm_ids() to authenticated;

drop policy if exists audit_sel on public.audit_log;
create policy audit_sel on public.audit_log for select to authenticated
  using (
    (select app.is_rr_admin())
    or farm_id in (select app.audit_readable_farm_ids())
  );
