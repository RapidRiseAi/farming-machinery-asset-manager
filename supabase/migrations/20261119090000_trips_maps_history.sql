-- 20261119090000_trips_maps_history.sql
-- Trips and maps by plan, after a downgrade as well as before one (task B3).
--
-- 20261114090200 refuses NEW trips, loads, trip income and expenses below Professional, and
-- NEW planned routes and positions below Complete. Two gaps remained, both found by B3:
--
--  1. An existing row could still be worked on below the plan. A manager on Essential could
--     start a planned trip, sign a delivery off, change the income figure or redraw a planned
--     route by updating the rows directly. Decision 37: after a downgrade, saved trips stay
--     readable and exportable, but no new use of the tool. So an update is refused below
--     the plan, with two exceptions that only FINISH what was already in hand when the plan
--     changed: a planned trip may be cancelled, and a trip already underway may be finished
--     (with its deliveries signed off), so the vehicle and the driver are not left stuck on
--     a trip nobody may close. Nothing else on the row may change in the same update.
--
--  2. The `map` readiness flag (20261107120000) was checked only by the app. Maps, routes,
--     reported positions and recorded paths need Complete AND the flag (decision 18, BRIEF
--     section 8: "apply gates to provider requests and history writes as well as screens").
--     The database now refuses a new position or route, and an edited route, unless both
--     hold. A delivery's location is a reported position too: it is kept only with maps,
--     and dropped (the delivery itself still records) without them.
--
-- Additive: new functions and triggers only. No existing row is touched; reads are
-- unchanged, so every saved trip, route and position stays readable on any plan.

-- == Helpers ==========================================================================

-- The map released to everyone, or to this business while it is in testing.
create or replace function app.maps_ready(p_farm uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.feature_flags f
     where f.key = 'map'
       and (f.released or exists (
             select 1 from public.farm_feature_access a where a.key = 'map' and a.farm_id = p_farm)));
$$;
revoke all on function app.maps_ready(uuid) from public, anon, authenticated;
grant execute on function app.maps_ready(uuid) to service_role;

-- Complete AND released: what every map write needs.
create or replace function app.maps_allowed(p_farm uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.farm_plan_allows(p_farm, 'maps') and app.maps_ready(p_farm);
$$;
revoke all on function app.maps_allowed(uuid) from public, anon, authenticated;
grant execute on function app.maps_allowed(uuid) to service_role;

-- True when the two rows differ in nothing but the named columns.
create or replace function app.only_changed(p_old jsonb, p_new jsonb, p_allowed text[])
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select (p_old - p_allowed) = (p_new - p_allowed);
$$;
revoke all on function app.only_changed(jsonb, jsonb, text[]) from public, anon, authenticated;
grant execute on function app.only_changed(jsonb, jsonb, text[]) to service_role;

-- == Saved trips below Professional ===================================================

create or replace function app.trips_history_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if app.farm_plan_allows(new.farm_id, 'trips') then
    return new;
  end if;
  -- Nothing changed: no new use.
  if to_jsonb(new) = to_jsonb(old) then
    return new;
  end if;
  -- Put away (soft delete), and nothing else.
  if old.deleted_at is null and new.deleted_at is not null
     and app.only_changed(to_jsonb(old), to_jsonb(new), array['deleted_at', 'deleted_by']) then
    return new;
  end if;
  -- A planned trip cancelled, nothing else.
  if old.status = 'planned' and new.status = 'cancelled'
     and app.only_changed(to_jsonb(old), to_jsonb(new), array['status']) then
    return new;
  end if;
  -- A trip already underway finished: its end, its closing reading, and the driving record
  -- it closes. Nothing else.
  if old.status = 'underway' and new.status = 'completed'
     and app.only_changed(to_jsonb(old), to_jsonb(new), array['status', 'ended_at', 'closing_reading', 'driving_session_id']) then
    return new;
  end if;
  raise exception 'plan-feature-trips' using errcode = 'P0001', hint = 'Saved trips stay readable; new trip work needs Professional.';
end
$$;
revoke all on function app.trips_history_guard() from public, anon, authenticated;
drop trigger if exists trips_history_guard on public.trips;
create trigger trips_history_guard before update on public.trips
  for each row execute function app.trips_history_guard();

-- A load: below Professional, only a delivery on a trip already underway, or putting it away.
-- With or without the plan, a delivery's location is kept only where maps are allowed.
create or replace function app.trip_jobs_history_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.pod_lat is not null or new.pod_lng is not null)
     and (new.pod_lat is distinct from old.pod_lat or new.pod_lng is distinct from old.pod_lng)
     and not app.maps_allowed(new.farm_id) then
    new.pod_lat := null;
    new.pod_lng := null;
  end if;
  if app.farm_plan_allows(new.farm_id, 'trips') or to_jsonb(new) = to_jsonb(old) then
    return new;
  end if;
  if old.deleted_at is null and new.deleted_at is not null
     and app.only_changed(to_jsonb(old), to_jsonb(new), array['deleted_at']) then
    return new;
  end if;
  if old.status = 'pending' and new.status in ('delivered', 'failed')
     and exists (select 1 from public.trips t where t.id = new.trip_id and t.status = 'underway' and t.deleted_at is null)
     and app.only_changed(to_jsonb(old), to_jsonb(new),
           array['status', 'delivered_at', 'received_by', 'pod_note', 'pod_photo_path', 'pod_signature_path', 'pod_lat', 'pod_lng']) then
    return new;
  end if;
  raise exception 'plan-feature-trips' using errcode = 'P0001', hint = 'Saved trips stay readable; new trip work needs Professional.';
end
$$;
revoke all on function app.trip_jobs_history_guard() from public, anon, authenticated;
drop trigger if exists trip_jobs_history_guard on public.trip_jobs;
create trigger trip_jobs_history_guard before update on public.trip_jobs
  for each row execute function app.trip_jobs_history_guard();

-- Trip income and expenses: no change below Professional (a new one is refused by
-- 20261114090200). Removing one is the owner's own record keeping and stays allowed.
create or replace function app.trip_money_history_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if app.farm_plan_allows(new.farm_id, 'trips') or to_jsonb(new) = to_jsonb(old) then
    return new;
  end if;
  raise exception 'plan-feature-trips' using errcode = 'P0001', hint = 'Saved trips stay readable; new trip work needs Professional.';
end
$$;
revoke all on function app.trip_money_history_guard() from public, anon, authenticated;
drop trigger if exists trip_income_history_guard on public.trip_income;
create trigger trip_income_history_guard before update on public.trip_income
  for each row execute function app.trip_money_history_guard();
drop trigger if exists trip_expenses_history_guard on public.trip_expenses;
create trigger trip_expenses_history_guard before update on public.trip_expenses
  for each row execute function app.trip_money_history_guard();

-- == Map writes need Complete AND the released map ===================================
-- A new route or position, and a route redrawn. 20261114090200's plan gate stays; this adds
-- the readiness flag in the database, and covers the update a direct call could make.
create or replace function app.require_maps_ready()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then
    return new;
  end if;
  if not app.farm_plan_allows(new.farm_id, 'maps') then
    raise exception 'plan-feature-maps' using errcode = 'P0001', hint = 'This needs a higher plan.';
  end if;
  if not app.maps_ready(new.farm_id) then
    raise exception 'maps-not-ready' using errcode = 'P0001', hint = 'Maps are not available to this business yet.';
  end if;
  return new;
end
$$;
revoke all on function app.require_maps_ready() from public, anon, authenticated;

drop trigger if exists trip_routes_maps_ready on public.trip_routes;
create trigger trip_routes_maps_ready before insert or update on public.trip_routes
  for each row execute function app.require_maps_ready();
drop trigger if exists asset_positions_maps_ready on public.asset_positions;
create trigger asset_positions_maps_ready before insert or update on public.asset_positions
  for each row execute function app.require_maps_ready();
