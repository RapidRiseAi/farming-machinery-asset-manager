-- 20261114090200_equipment_entitlements.sql
-- One entitlement matrix, plan x profile x feature, enforced where the data is written
-- (BRIEF sections 6 and 7; decision register of 12 November 2026, decisions 3, 16, 18, 19,
-- 32 and 33). Mirrors src/lib/entitlements.ts; entitlements.test.ts reads this file and
-- keeps the two equal.
--
-- == The plan part: app.feature_min_rank =========================================
-- Unchanged ranks for every existing key. New keys:
--   trips        2  trip scheduling, assignments, deliveries, trip income and expenses
--   maps         3  in-app maps, route planning, reported positions, driving paths
--                   (Complete; the `map` feature flag is the readiness switch on top)
--   budgets      2  budgets (the screens already gate them as `tco`)
--   depreciation 2  depreciation and book value (the screens already gate them as `tco`)
-- and the every-plan capabilities the profile rules name: driving_log, driver_workflow,
-- road_licensing, finance_agreements, tyre_detail, sale_warranty_packs, general_chat.
--
-- == The profile part: app.profile_refuses =======================================
-- Support equipment never has, on any plan (Complete included): its own driver workflow
-- or driving log, its own trips, maps or tracking, road licensing, fuel use, TCO and
-- running costs, depreciation, loan and lease agreements, budgets, detailed tyre fitment.
-- It keeps everything else: identification, photos, a written location, hour readings,
-- service reminders, faults, checklists and inspections, repair jobs with ordinary parts,
-- labour and cost lines, documents, QR codes, sale and warranty packs.
--
-- == Enforced at the table, so no path is missed ===================================
-- A trigger on each table that records restricted work refuses a NEW row (or a row moved
-- onto another asset) for an equipment asset, whatever wrote it: a screen, the offline
-- replay (apply_offline_capture), the assistant and WhatsApp (apply_assistant_proposal),
-- QR capture, imports, the public API, a tracker feed or the service key. Rows written
-- before an asset was converted stay as they are, readable and exportable (decision 27).
-- The refusal is raised as P0001 with a slug (equipment-refused-<feature>) that the app
-- turns into a sentence in the person's language (src/lib/errors.ts).
--
-- A trailer on the equipment profile may still be the trailer on a full vehicle's trip
-- (decision 32): the trip belongs to the vehicle, and the link gives the trailer no trip,
-- route or profit of its own. Any other equipment asset cannot be a trip's trailer.
--
-- Ordinary leases are refused for equipment, but a service contract, maintenance plan,
-- extended warranty or insurance policy is upkeep and stays. Licence records for road use
-- (licence disc, roadworthy, permit, cross-border) are refused; insurance and other dates
-- stay.
--
-- == New plan gates on new work =====================================================
-- A new trip, load, trip income or expense needs Professional; a planned route or a
-- reported position needs Complete. Existing rows are untouched and stay readable after a
-- downgrade (decision 37). Driving logs stay on every plan.
--
-- Safe on live data: functions and triggers only; no row changes, no table rewrite. The
-- triggers fire on new writes. Every live business on Essential with trips keeps them.

-- == The plan part ===================================================================
create or replace function app.feature_min_rank(p_feature text) returns int
language sql immutable security definer set search_path = public, pg_temp as $$
  select case p_feature
    when 'dashboard'           then 2
    when 'advanced_reports'    then 2
    when 'fuel'                then 2
    when 'tco'                 then 2
    when 'budgets'             then 2
    when 'depreciation'        then 2
    when 'trips'               then 2
    when 'maps'                then 3
    when 'aarto'               then 3
    when 'voice_ai'            then 3
    when 'multi_site'          then 3
    when 'whatsapp'            then 3
    when 'api_access'          then 4
    when 'driving_log'         then 1
    when 'driver_workflow'     then 1
    when 'road_licensing'      then 1
    when 'finance_agreements'  then 1
    when 'tyre_detail'         then 1
    when 'sale_warranty_packs' then 1
    when 'general_chat'        then 1
    else 1
  end;
$$;

-- == The profile part ================================================================
create or replace function app.profile_refuses(p_profile public.asset_profile, p_feature text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_profile = 'equipment' and p_feature in (
    'driving_log', 'driver_workflow', 'trips', 'maps', 'road_licensing', 'fuel', 'tco',
    'depreciation', 'finance_agreements', 'budgets', 'tyre_detail');
$$;
revoke all on function app.profile_refuses(public.asset_profile, text) from public, anon;
grant execute on function app.profile_refuses(public.asset_profile, text) to authenticated, service_role;

-- The plan of a business, with no question about who asks: for triggers and owner-run
-- functions that have already decided the caller may act. Not reachable over REST.
create or replace function app.farm_plan_allows(p_farm uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select app.plan_rank(f.plan) >= app.feature_min_rank(p_feature)
                     from public.farms f where f.id = p_farm), false);
$$;
revoke all on function app.farm_plan_allows(uuid, text) from public, anon, authenticated;
grant execute on function app.farm_plan_allows(uuid, text) to service_role;

-- Plan x profile x feature for one asset, with no question about who asks.
create or replace function app.asset_allows(p_machine uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select app.plan_rank(f.plan) >= app.feature_min_rank(p_feature)
                          and not app.profile_refuses(m.profile, p_feature)
                     from public.machines m join public.farms f on f.id = m.farm_id
                    where m.id = p_machine), false);
$$;
revoke all on function app.asset_allows(uuid, text) from public, anon, authenticated;
grant execute on function app.asset_allows(uuid, text) to service_role;

-- The same answer for a person, only about an asset they can reach. Mirrors
-- public.has_entitlement (0251): no answer about another business's assets.
create or replace function public.has_asset_entitlement(p_machine uuid, p_feature text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_farm uuid;
begin
  select m.farm_id into v_farm from public.machines m where m.id = p_machine and m.deleted_at is null;
  if v_farm is null or not app.has_farm_access(v_farm) then
    return false;
  end if;
  return app.asset_allows(p_machine, p_feature);
end
$$;
revoke all on function public.has_asset_entitlement(uuid, text) from public, anon;
grant execute on function public.has_asset_entitlement(uuid, text) to authenticated, service_role;

-- == Refusing restricted work for equipment, at the table =============================
-- tg_argv[0]: the feature; tg_argv[1]: the column holding the asset (default machine_id).
create or replace function app.refuse_equipment_work()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_col  text := coalesce(tg_argv[1], 'machine_id');
  v_new  uuid := nullif(to_jsonb(new) ->> v_col, '')::uuid;
  v_old  uuid;
begin
  if v_new is null then return new; end if;
  if tg_op = 'UPDATE' then
    v_old := nullif(to_jsonb(old) ->> v_col, '')::uuid;
    if v_old is not distinct from v_new then return new; end if;
  end if;
  if exists (select 1 from public.machines m where m.id = v_new and m.profile = 'equipment') then
    raise exception 'equipment-refused-%', tg_argv[0]
      using errcode = 'P0001', hint = 'Support equipment does not have this tool; convert it to a full space first.';
  end if;
  return new;
end
$$;
revoke all on function app.refuse_equipment_work() from public, anon, authenticated;

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('driving_sessions',       'driver_workflow',    'machine_id'),
      ('driver_device_links',    'maps',               'machine_id'),
      ('asset_positions',        'maps',               'machine_id'),
      ('fuel_issues',            'fuel',               'machine_id'),
      ('fuel_card_transactions', 'fuel',               'machine_id'),
      ('budgets',                'budgets',            'machine_id'),
      ('finance_agreements',     'finance_agreements', 'machine_id'),
      ('tyre_fitments',          'tyre_detail',        'machine_id'),
      ('trips',                  'trips',              'machine_id')
    ) as t(tbl, feature, col)
  loop
    execute format('drop trigger if exists %I on public.%I', r.tbl || '_equipment_refuse', r.tbl);
    execute format(
      'create trigger %I before insert or update of %I on public.%I for each row execute function app.refuse_equipment_work(%L, %L)',
      r.tbl || '_equipment_refuse', r.col, r.tbl, r.feature, r.col);
  end loop;
end $$;

-- A trip's trailer may be an equipment TRAILER; no other equipment rides on a trip.
create or replace function app.trips_trailer_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_first  uuid := new.trailer_id;
  v_second uuid := new.second_trailer_id;
begin
  -- On an update only a trailer newly put on the trip is judged.
  if tg_op = 'UPDATE' then
    if v_first is not distinct from old.trailer_id then v_first := null; end if;
    if v_second is not distinct from old.second_trailer_id then v_second := null; end if;
  end if;
  if exists (select 1 from public.machines m
              where m.id in (v_first, v_second)
                and m.profile = 'equipment' and m.type::text <> 'trailer') then
    raise exception 'equipment-refused-trips' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function app.trips_trailer_guard() from public, anon, authenticated;
drop trigger if exists trips_trailer_guard on public.trips;
create trigger trips_trailer_guard before insert or update of trailer_id, second_trailer_id on public.trips
  for each row execute function app.trips_trailer_guard();

-- Road licensing: a licence disc, roadworthy, permit or cross-border permit.
create or replace function app.licences_equipment_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.type is not distinct from old.type and new.machine_id is not distinct from old.machine_id then
    return new;
  end if;
  if new.type::text in ('vehicle_licence', 'roadworthy', 'permit', 'crossborder')
     and exists (select 1 from public.machines m where m.id = new.machine_id and m.profile = 'equipment') then
    raise exception 'equipment-refused-road_licensing' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function app.licences_equipment_guard() from public, anon, authenticated;
drop trigger if exists licences_equipment_guard on public.licences;
create trigger licences_equipment_guard before insert or update of type, machine_id on public.licences
  for each row execute function app.licences_equipment_guard();

-- Leases and rentals are the loan/lease module; upkeep contracts stay.
create or replace function app.asset_contracts_equipment_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.kind is not distinct from old.kind and new.machine_id is not distinct from old.machine_id then
    return new;
  end if;
  if new.kind in ('operating_lease', 'rental') and new.machine_id is not null
     and exists (select 1 from public.machines m where m.id = new.machine_id and m.profile = 'equipment') then
    raise exception 'equipment-refused-finance_agreements' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function app.asset_contracts_equipment_guard() from public, anon, authenticated;
drop trigger if exists asset_contracts_equipment_guard on public.asset_contracts;
create trigger asset_contracts_equipment_guard before insert or update of kind, machine_id on public.asset_contracts
  for each row execute function app.asset_contracts_equipment_guard();

-- Depreciation is set on the asset itself: equipment keeps its purchase details but no
-- method. The conversion to equipment clears the method (its other settings stay).
create or replace function app.machines_depreciation_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.depreciation_method is not distinct from old.depreciation_method
     and new.profile is not distinct from old.profile then
    return new;
  end if;
  if new.profile = 'equipment' and new.depreciation_method <> 'none' then
    raise exception 'equipment-refused-depreciation' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function app.machines_depreciation_guard() from public, anon, authenticated;
drop trigger if exists machines_depreciation_guard on public.machines;
create trigger machines_depreciation_guard before insert or update of depreciation_method, profile on public.machines
  for each row execute function app.machines_depreciation_guard();

-- == Plan gates on new work ==========================================================
-- tg_argv[0]: the feature. The business is the row's own farm_id.
create or replace function app.require_plan_feature()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not app.farm_plan_allows(new.farm_id, tg_argv[0]) then
    raise exception 'plan-feature-%', tg_argv[0]
      using errcode = 'P0001', hint = 'This needs a higher plan.';
  end if;
  return new;
end
$$;
revoke all on function app.require_plan_feature() from public, anon, authenticated;

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('trips', 'trips'), ('trip_jobs', 'trips'), ('trip_income', 'trips'), ('trip_expenses', 'trips'),
      ('trip_routes', 'maps'), ('asset_positions', 'maps')
    ) as t(tbl, feature)
  loop
    execute format('drop trigger if exists %I on public.%I', r.tbl || '_plan_gate', r.tbl);
    execute format(
      'create trigger %I before insert on public.%I for each row execute function app.require_plan_feature(%L)',
      r.tbl || '_plan_gate', r.tbl, r.feature);
  end loop;
end $$;

-- == Lists that offer an asset for restricted work ==================================
-- The driver's vehicle list leaves support equipment out: it has no driving log.
create or replace function public.driving_vehicles(p_farm uuid)
 returns table(id uuid, name text)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select m.id,m.name from machines m where app.require_open_farm(p_farm, false) and m.farm_id=p_farm and m.deleted_at is null
    and m.status not in ('retired','sold') and m.profile = 'full' and app.driver_member(auth.uid(),p_farm) order by m.name;
$function$;

-- The book value register is depreciation analytics: full assets only, Professional up.
create or replace function public.farm_book_values(p_farm uuid, p_on date default null::date)
 returns table(machine_id uuid, name text, reg_no text, type machine_type, status machine_status, purchase_date date, purchase_price_cents bigint, method depreciation_method, rate_bps integer, life_months integer, residual_value_cents bigint, start_date date, months_held integer, book_value_cents bigint, depreciated_cents bigint)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select
    m.id,
    m.name,
    m.reg_no,
    m.type,
    m.status,
    m.purchase_date,
    m.purchase_price_cents,
    m.depreciation_method,
    m.depreciation_rate_bps,
    m.useful_life_months,
    m.residual_value_cents,
    coalesce(m.depreciation_start_date, m.purchase_date),
    app.months_between(
      coalesce(m.depreciation_start_date, m.purchase_date),
      coalesce(p_on, current_date)),
    app.book_value_cents(
      m.purchase_price_cents, m.depreciation_method, m.depreciation_rate_bps,
      m.useful_life_months, m.residual_value_cents,
      coalesce(m.depreciation_start_date, m.purchase_date), coalesce(p_on, current_date)),
    m.purchase_price_cents - app.book_value_cents(
      m.purchase_price_cents, m.depreciation_method, m.depreciation_rate_bps,
      m.useful_life_months, m.residual_value_cents,
      coalesce(m.depreciation_start_date, m.purchase_date), coalesce(p_on, current_date))
  from public.machines m
  where m.farm_id = p_farm
    and app.require_open_farm(p_farm, false)
    and m.deleted_at is null
    -- Sold and retired machines are left out of a register of what to insure.
    and m.status not in ('sold', 'retired')
    -- Support equipment keeps its purchase details but has no depreciation (decision 33).
    and m.profile = 'full'
    and app.can_view_farm_costs(m.farm_id)
    and (app.is_rr_admin() or app.has_entitlement(m.farm_id, 'depreciation'))
    and (
      app.row_visible_to_role(m.farm_id, m.id)
      or (app.is_farm_side() and app.has_permission(m.farm_id, 'see_all_vehicles'))
    )
  order by m.name;
$function$;
