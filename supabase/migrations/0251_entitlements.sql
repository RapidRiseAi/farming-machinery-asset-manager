-- 0251_entitlements.sql  (FleetWise F5 — entitlement helper + asset-count trigger)
--
-- The DB-side entitlement check. This MIRRORS the single source of truth in
-- src/lib/entitlements.ts (the app enforces gates in-process from that TS map; this
-- helper is the defence-in-depth / SQL-callable / test-provable twin). If you change
-- one, change the other — the plan ranks and feature→min-plan table are identical.
--
-- Plan ranks:   essential 1 < professional 2 < complete 3 < done_for_you 4
-- Feature map:  dashboard/advanced_reports/fuel/tco → professional (2)
--               aarto/voice_ai/multi_site/whatsapp  → complete      (3)
--               api_access                          → done_for_you  (4)
--               (anything not listed is ungated → rank 1, always allowed)
--
-- All functions are SECURITY DEFINER with a pinned search_path; execute is revoked
-- from public/anon. `has_entitlement` is granted to authenticated (it is a read-only
-- gate, exactly like app.has_farm_access) and mirrored by a PostgREST-callable
-- public wrapper. `anon` gets nothing.

-- ── plan rank ─────────────────────────────────────────────────────
create or replace function app.plan_rank(p_plan farm_plan) returns int
language sql immutable security definer set search_path = public, pg_temp as $$
  select case p_plan
    when 'essential'    then 1
    when 'professional' then 2
    when 'complete'     then 3
    when 'done_for_you' then 4
    else 0
  end;
$$;

-- ── feature → minimum plan rank required (0 = ungated / always allowed) ──
create or replace function app.feature_min_rank(p_feature text) returns int
language sql immutable security definer set search_path = public, pg_temp as $$
  select case p_feature
    when 'dashboard'        then 2   -- professional+
    when 'advanced_reports' then 2   -- professional+
    when 'fuel'             then 2   -- professional+
    when 'tco'              then 2   -- professional+
    when 'aarto'            then 3   -- complete+
    when 'voice_ai'         then 3   -- complete+
    when 'multi_site'       then 3   -- complete+
    when 'whatsapp'         then 3   -- complete+
    when 'api_access'       then 4   -- done_for_you
    else 1                           -- ungated core feature
  end;
$$;

-- ── the gate ──────────────────────────────────────────────────────
-- Returns true iff the farm's plan unlocks the feature. Callers may only probe a farm
-- they can access (app.has_farm_access covers rr_admin + own-farm + active workshop
-- link), so this never leaks another tenant's plan.
create or replace function app.has_entitlement(p_farm uuid, p_feature text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_plan farm_plan;
begin
  if p_farm is null or not app.has_farm_access(p_farm) then
    return false;
  end if;
  select plan into v_plan from public.farms where id = p_farm and deleted_at is null;
  if v_plan is null then
    return false;
  end if;
  return app.plan_rank(v_plan) >= app.feature_min_rank(p_feature);
end;
$$;

-- PostgREST-callable wrapper (public schema) for RPC use from the app if needed.
create or replace function public.has_entitlement(p_farm uuid, p_feature text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_entitlement(p_farm, p_feature);
$$;

revoke execute on function app.plan_rank(farm_plan)          from public, anon;
revoke execute on function app.feature_min_rank(text)        from public, anon;
revoke execute on function app.has_entitlement(uuid, text)   from public, anon;
revoke execute on function public.has_entitlement(uuid, text) from public, anon;
grant  execute on function app.plan_rank(farm_plan)          to authenticated, service_role;
grant  execute on function app.feature_min_rank(text)        to authenticated, service_role;
grant  execute on function app.has_entitlement(uuid, text)   to authenticated, service_role;
grant  execute on function public.has_entitlement(uuid, text) to authenticated, service_role;

-- ══ Denormalised billable-asset count (subscription/billing seam; display only) ══
-- Billable = active, non-deleted machines that are NOT retired/sold (matches the
-- "assets tracked" dashboard semantics; out_of_service still counts as active-but-down).
create or replace function app.recount_farm_assets(p_farm uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_farm is null then return; end if;
  update public.farms f
     set asset_count = (
       select count(*) from public.machines m
       where m.farm_id = p_farm
         and m.deleted_at is null
         and m.status not in ('retired','sold')
     )
   where f.id = p_farm;
end;
$$;
revoke execute on function app.recount_farm_assets(uuid) from public, anon, authenticated;
grant  execute on function app.recount_farm_assets(uuid) to service_role;

-- Trigger keeps farms.asset_count current on any machine insert/update/delete. Runs
-- SECURITY DEFINER so a farm member's machine write can update the (RR-admin-only-RLS)
-- farms row. Trigger functions are invoked by the system, so no EXECUTE grant is needed.
create or replace function app.app_farm_asset_count() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    perform app.recount_farm_assets(old.farm_id);
    return old;
  end if;
  perform app.recount_farm_assets(new.farm_id);
  if tg_op = 'UPDATE' and new.farm_id is distinct from old.farm_id then
    perform app.recount_farm_assets(old.farm_id);
  end if;
  return new;
end;
$$;
revoke execute on function app.app_farm_asset_count() from public, anon, authenticated;

drop trigger if exists app_farm_asset_count on public.machines;
create trigger app_farm_asset_count
  after insert or update or delete on public.machines
  for each row execute function app.app_farm_asset_count();

-- Backfill existing farms once.
update public.farms f
   set asset_count = (
     select count(*) from public.machines m
     where m.farm_id = f.id and m.deleted_at is null and m.status not in ('retired','sold')
   );
