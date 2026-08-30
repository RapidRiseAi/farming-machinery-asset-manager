-- 20260829130100_partner_guard_local_in_perm_policies.sql
-- Make the contractor guard LOCAL to the policies that depend on it.
--
-- Found by the G30 verification pass, and it is a hardening rather than a defect: the
-- behaviour today is correct and asserted.
--
-- 0507 added eleven permissive SELECT policies of the shape
--
--     using (deleted_at is null and app.has_permission(farm_id, 'see_all_vehicles'))
--
-- and `app.has_permission` calls `app.is_farm_side()` internally, which is what stops a
-- grant row lifting a LINKED CONTRACTOR clean out of the F16 access scope. That works. The
-- problem is its shape: one guard, inside one function, carrying the whole F16 model for
-- eleven tables that never mention it. Someone widening `is_farm_side` for an unrelated
-- reason has no local signal that eleven contractor boundaries move with it.
--
-- So the call is repeated in each policy. Both locks must now fail before a contractor sees
-- a farm's whole fleet, which is the same defence-in-depth `0507` already applies to
-- `users.active` (checked in `is_farm_side` AND `has_farm_access`) and to the global
-- `partners` rows (`farm_id is not null` in the policy AND a null check inside
-- `has_permission`). G30 mutation-tests those pairs; this section joins them.
--
-- THIS CHANGES NO VISIBILITY. `app.has_permission` already returns false for a workshop
-- user, so `is_farm_side() and has_permission(...)` is exactly `has_permission(...)` today.
-- The assertion accompanying this migration is therefore a NEGATIVE one: every persona's
-- counts must be identical before and after. If any cell moves, this migration is wrong.
--
-- DATED, not numbered: migrations apply in filename glob order, and the dated
-- voice-assistant / POPIA / selected-farm files sort after `05…`. `selected_farm_administration`
-- recreates the `upg_*` policies but leaves the `_perm` set alone — this must land after it
-- regardless, so that the file order matches the reasoning order.

do $do$
declare t text;
begin
  -- `machines` first and by name, because it is the one every other table hangs off and a
  -- reader should see it stated rather than buried in an array.
  drop policy if exists machines_sel_perm on public.machines;
  create policy machines_sel_perm on public.machines for select to authenticated
    using (
      deleted_at is null
      and app.is_farm_side()
      and app.has_permission(farm_id, 'see_all_vehicles')
    );

  foreach t in array array[
    'meter_readings','service_plan_lines','faults','job_cards','watch_items',
    'fuel_issues','usage_logs','licences','fines','work_requests'
  ] loop
    execute format('drop policy if exists %1$I_sel_perm on public.%1$I', t);
    execute format(
      'create policy %1$I_sel_perm on public.%1$I for select to authenticated '
      'using (deleted_at is null and app.is_farm_side() '
      '       and app.has_permission(farm_id, ''see_all_vehicles''))', t);
  end loop;
end $do$;

-- The count is asserted here as well as in the suite, because a `drop policy if exists`
-- that silently matched nothing would leave a table unprotected by the grant path and
-- everything downstream would still pass.
do $check$
declare n int;
begin
  select count(*) into n
    from pg_policies
   where schemaname = 'public'
     and policyname like '%\_sel\_perm'
     and qual like '%is_farm_side%';
  if n <> 11 then
    raise exception
      'expected 11 _sel_perm policies carrying the local is_farm_side guard, found %', n;
  end if;
end $check$;

comment on function app.is_farm_side() is
  'True when the caller is farm-side staff rather than a linked contractor. Called BOTH '
  'inside app.has_permission and directly by the eleven _perm SELECT policies '
  '(20260829130100) — two independent locks, deliberately. Widening this function moves '
  'eleven contractor boundaries at once; G30 asserts the current behaviour.';
