\set ON_ERROR_STOP on
-- One matrix, plan x profile x feature, enforced at the table (20261114090200).
-- BRIEF section 23, scenarios 14 (equipment restrictions through direct writes, functions,
-- offline replay and every role), 15 (the trailer link) and 16 (Essential repair costs work
-- while Professional analytics stay gated).
set client_min_messages to warning;
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;

-- Runs one statement and answers the refusal slug it raised, or 'ok'.
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when raise_exception then
  return sqlerrm;
end $$;

insert into public.farms (id, name, plan, status, billing_period) values
  ('eb100000-0000-4000-9000-000000000001', 'Essential fleet', 'essential', 'active', 'monthly'),
  ('eb100000-0000-4000-9000-000000000002', 'Professional fleet', 'professional', 'active', 'monthly'),
  ('eb100000-0000-4000-9000-000000000003', 'Complete fleet', 'complete', 'active', 'monthly');
insert into auth.users (id, email) values
  ('eb110000-0000-4000-9000-000000000001', 'owner.e@restrict.test'),
  ('eb110000-0000-4000-9000-000000000002', 'owner.p@restrict.test'),
  ('eb110000-0000-4000-9000-000000000003', 'owner.c@restrict.test'),
  ('eb110000-0000-4000-9000-000000000004', 'operator.c@restrict.test'),
  ('eb110000-0000-4000-9000-000000000005', 'manager.c@restrict.test');
insert into public.users (id, farm_id, workshop_id, role, name, email, active) values
  ('eb110000-0000-4000-9000-000000000001', 'eb100000-0000-4000-9000-000000000001', null, 'owner', 'Owner E', 'owner.e@restrict.test', true),
  ('eb110000-0000-4000-9000-000000000002', 'eb100000-0000-4000-9000-000000000002', null, 'owner', 'Owner P', 'owner.p@restrict.test', true),
  ('eb110000-0000-4000-9000-000000000003', 'eb100000-0000-4000-9000-000000000003', null, 'owner', 'Owner C', 'owner.c@restrict.test', true),
  ('eb110000-0000-4000-9000-000000000004', 'eb100000-0000-4000-9000-000000000003', null, 'operator', 'Operator C', 'operator.c@restrict.test', true),
  ('eb110000-0000-4000-9000-000000000005', 'eb100000-0000-4000-9000-000000000003', null, 'manager', 'Manager C', 'manager.c@restrict.test', true);

insert into public.machines (id, farm_id, name, type, profile, meter_type, assigned_operator_id) values
  -- Complete
  ('eb120000-0000-4000-9000-000000000001', 'eb100000-0000-4000-9000-000000000003', 'Truck A', 'truck', 'full', 'km', null),
  ('eb120000-0000-4000-9000-000000000002', 'eb100000-0000-4000-9000-000000000003', 'Trailer B', 'trailer', 'equipment', 'none', null),
  ('eb120000-0000-4000-9000-000000000003', 'eb100000-0000-4000-9000-000000000003', 'Generator', 'pump_generator', 'equipment', 'hours', 'eb110000-0000-4000-9000-000000000004'),
  ('eb120000-0000-4000-9000-000000000004', 'eb100000-0000-4000-9000-000000000003', 'Compressor', 'compressor', 'equipment', 'hours', null),
  ('eb120000-0000-4000-9000-000000000005', 'eb100000-0000-4000-9000-000000000003', 'Full trailer', 'trailer', 'full', 'none', null),
  -- Essential
  ('eb120000-0000-4000-9000-000000000011', 'eb100000-0000-4000-9000-000000000001', 'Pump', 'pump_generator', 'equipment', 'hours', null),
  ('eb120000-0000-4000-9000-000000000012', 'eb100000-0000-4000-9000-000000000001', 'Bakkie', 'bakkie', 'full', 'km', null),
  -- Professional
  ('eb120000-0000-4000-9000-000000000021', 'eb100000-0000-4000-9000-000000000002', 'Tractor', 'tractor', 'full', 'hours', null),
  ('eb120000-0000-4000-9000-000000000022', 'eb100000-0000-4000-9000-000000000002', 'Plough', 'implement', 'equipment', 'none', null);
insert into public.fuel_tanks (id, farm_id, name) values
  ('eb130000-0000-4000-9000-000000000001', 'eb100000-0000-4000-9000-000000000003', 'Bowser');
-- Map writes need the readiness flag as well as Complete (20261119090000).
insert into public.farm_feature_access (farm_id, key) values ('eb100000-0000-4000-9000-000000000003', 'map');

-- == Every table that records restricted work carries the rule ===========================
do $t$
declare v text;
begin
  select string_agg(t, ', ') into v
    from unnest(array['driving_sessions', 'driver_device_links', 'asset_positions', 'fuel_issues',
                      'fuel_card_transactions', 'budgets', 'finance_agreements', 'tyre_fitments', 'trips']) t
   where not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                      where g.tgrelid = ('public.' || t)::regclass and p.proname = 'refuse_equipment_work'
                        and not g.tgisinternal);
  if v is not null then raise exception 'tables without the equipment rule: %', v; end if;
end $t$;

-- == The matrix answers ================================================================
do $t$ begin
  -- The profile refuses its list on every plan, Complete included.
  if app.asset_allows('eb120000-0000-4000-9000-000000000003', 'tco')
     or app.asset_allows('eb120000-0000-4000-9000-000000000003', 'fuel')
     or app.asset_allows('eb120000-0000-4000-9000-000000000003', 'trips')
     or app.asset_allows('eb120000-0000-4000-9000-000000000003', 'maps')
     or app.asset_allows('eb120000-0000-4000-9000-000000000003', 'budgets')
     or app.asset_allows('eb120000-0000-4000-9000-000000000003', 'depreciation')
     or app.asset_allows('eb120000-0000-4000-9000-000000000003', 'finance_agreements')
     or app.asset_allows('eb120000-0000-4000-9000-000000000003', 'tyre_detail')
     or app.asset_allows('eb120000-0000-4000-9000-000000000003', 'road_licensing')
     or app.asset_allows('eb120000-0000-4000-9000-000000000003', 'driver_workflow') then
    raise exception 'Complete unlocked a refused tool for support equipment';
  end if;
  -- What equipment keeps, on the cheapest plan.
  if not app.asset_allows('eb120000-0000-4000-9000-000000000011', 'sale_warranty_packs')
     or not app.asset_allows('eb120000-0000-4000-9000-000000000011', 'general_chat') then
    raise exception 'Essential equipment lost packs or chat';
  end if;
  -- A full asset follows its plan.
  if not app.asset_allows('eb120000-0000-4000-9000-000000000001', 'tco')
     or not app.asset_allows('eb120000-0000-4000-9000-000000000001', 'maps')
     or app.asset_allows('eb120000-0000-4000-9000-000000000012', 'tco')
     or app.asset_allows('eb120000-0000-4000-9000-000000000012', 'trips')
     or not app.asset_allows('eb120000-0000-4000-9000-000000000012', 'finance_agreements')
     or not app.asset_allows('eb120000-0000-4000-9000-000000000012', 'tyre_detail')
     or not app.asset_allows('eb120000-0000-4000-9000-000000000021', 'trips')
     or app.asset_allows('eb120000-0000-4000-9000-000000000021', 'maps') then
    raise exception 'a full asset did not follow its plan';
  end if;
end $t$;

-- == Any path at all: the table refuses (run as the database owner, as a job would) ======
do $t$
declare v text;
begin
  v := pg_temp.try($s$insert into public.driving_sessions (farm_id, machine_id, driver_id, started_at)
                      values ('eb100000-0000-4000-9000-000000000003', 'eb120000-0000-4000-9000-000000000003',
                              'eb110000-0000-4000-9000-000000000004', now())$s$);
  if v <> 'equipment-refused-driver_workflow' then raise exception 'driving log on equipment: %', v; end if;

  v := pg_temp.try($s$insert into public.asset_positions (farm_id, machine_id, recorded_at, lat, lng)
                      values ('eb100000-0000-4000-9000-000000000003', 'eb120000-0000-4000-9000-000000000003', now(), -25.4, 31.0)$s$);
  if v <> 'equipment-refused-maps' then raise exception 'tracking on equipment: %', v; end if;

  v := pg_temp.try($s$insert into public.fuel_issues (farm_id, tank_id, machine_id, litres)
                      values ('eb100000-0000-4000-9000-000000000003', 'eb130000-0000-4000-9000-000000000001',
                              'eb120000-0000-4000-9000-000000000003', 40)$s$);
  if v <> 'equipment-refused-fuel' then raise exception 'fuel on equipment: %', v; end if;
  -- A draw with no asset still records the diesel, so the tank still balances.
  v := pg_temp.try($s$insert into public.fuel_issues (farm_id, tank_id, machine_id, litres, activity)
                      values ('eb100000-0000-4000-9000-000000000003', 'eb130000-0000-4000-9000-000000000001', null, 40, 'Generator')$s$);
  if v <> 'ok' then raise exception 'a farm-level draw was refused: %', v; end if;

  v := pg_temp.try($s$insert into public.budgets (farm_id, machine_id, period_start, period_end, amount_cents)
                      values ('eb100000-0000-4000-9000-000000000003', 'eb120000-0000-4000-9000-000000000003',
                              date '2026-11-01', date '2026-11-30', 100000)$s$);
  if v <> 'equipment-refused-budgets' then raise exception 'budget on equipment: %', v; end if;

  insert into public.tyres (id, farm_id) values ('eb140000-0000-4000-9000-000000000001', 'eb100000-0000-4000-9000-000000000003');
  v := pg_temp.try($s$insert into public.tyre_fitments (farm_id, tyre_id, machine_id)
                      values ('eb100000-0000-4000-9000-000000000003', 'eb140000-0000-4000-9000-000000000001',
                              'eb120000-0000-4000-9000-000000000002')$s$);
  if v <> 'equipment-refused-tyre_detail' then raise exception 'tyre fitment on equipment: %', v; end if;

  v := pg_temp.try($s$insert into public.licences (farm_id, machine_id, type, number, expiry_date)
                      values ('eb100000-0000-4000-9000-000000000003', 'eb120000-0000-4000-9000-000000000002',
                              'vehicle_licence', 'DISC-1', date '2027-06-30')$s$);
  if v <> 'equipment-refused-road_licensing' then raise exception 'licence disc on equipment: %', v; end if;
  -- A certificate of fitness is a road paper too (20261114090400).
  v := pg_temp.try($s$insert into public.licences (farm_id, machine_id, type, number, expiry_date)
                      values ('eb100000-0000-4000-9000-000000000003', 'eb120000-0000-4000-9000-000000000002',
                              'cof', 'COF-9', date '2027-06-30')$s$);
  if v <> 'equipment-refused-road_licensing' then raise exception 'a COF on equipment: %', v; end if;
  v := pg_temp.try($s$insert into public.licences (farm_id, machine_id, type, number, expiry_date)
                      values ('eb100000-0000-4000-9000-000000000003', 'eb120000-0000-4000-9000-000000000003',
                              'insurance', 'POL-1', date '2027-06-30')$s$);
  if v <> 'ok' then raise exception 'insurance dates on equipment were refused: %', v; end if;

  v := pg_temp.try($s$insert into public.asset_contracts (farm_id, machine_id, kind, party, start_date)
                      values ('eb100000-0000-4000-9000-000000000003', 'eb120000-0000-4000-9000-000000000003',
                              'operating_lease', 'Lessor', date '2026-11-01')$s$);
  if v <> 'equipment-refused-finance_agreements' then raise exception 'lease on equipment: %', v; end if;
  v := pg_temp.try($s$insert into public.asset_contracts (farm_id, machine_id, kind, party, start_date)
                      values ('eb100000-0000-4000-9000-000000000003', 'eb120000-0000-4000-9000-000000000003',
                              'maintenance_plan', 'Dealer', date '2026-11-01')$s$);
  if v <> 'ok' then raise exception 'a maintenance plan on equipment was refused: %', v; end if;

  v := pg_temp.try($s$update public.machines set depreciation_method = 'straight_line', useful_life_months = 60
                      where id = 'eb120000-0000-4000-9000-000000000003'$s$);
  if v <> 'equipment-refused-depreciation' then raise exception 'depreciation on equipment: %', v; end if;

  -- An existing record is not moved onto equipment either.
  insert into public.budgets (id, farm_id, machine_id, period_start, period_end, amount_cents) values
    ('eb150000-0000-4000-9000-000000000001', 'eb100000-0000-4000-9000-000000000003', 'eb120000-0000-4000-9000-000000000001',
     date '2026-11-01', date '2026-11-30', 100000);
  v := pg_temp.try($s$update public.budgets set machine_id = 'eb120000-0000-4000-9000-000000000004'
                      where id = 'eb150000-0000-4000-9000-000000000001'$s$);
  if v <> 'equipment-refused-budgets' then raise exception 'a budget moved onto equipment: %', v; end if;
  -- Editing it where it is stays possible.
  update public.budgets set amount_cents = 120000 where id = 'eb150000-0000-4000-9000-000000000001';
end $t$;

-- == The trailer link (scenario 15) =====================================================
select pg_temp.as_user('eb110000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$
declare v text;
begin
  -- Truck A took Trailer B: allowed, and it is Truck A's trip.
  insert into public.trips (id, farm_id, number, machine_id, trailer_id, origin, destination) values
    ('eb160000-0000-4000-9000-000000000001', 'eb100000-0000-4000-9000-000000000003', 0,
     'eb120000-0000-4000-9000-000000000001', 'eb120000-0000-4000-9000-000000000002', 'Hazyview', 'Nelspruit');
  -- The trailer gets no trip of its own.
  v := pg_temp.try($s$insert into public.trips (farm_id, number, machine_id) values
                      ('eb100000-0000-4000-9000-000000000003', 0, 'eb120000-0000-4000-9000-000000000002')$s$);
  if v <> 'equipment-refused-trips' then raise exception 'an equipment trailer got its own trip: %', v; end if;
  -- Other equipment does not ride along as a "trailer".
  v := pg_temp.try($s$insert into public.trips (farm_id, number, machine_id, trailer_id) values
                      ('eb100000-0000-4000-9000-000000000003', 0, 'eb120000-0000-4000-9000-000000000001',
                       'eb120000-0000-4000-9000-000000000004')$s$);
  if v <> 'equipment-refused-trips' then raise exception 'a compressor rode as a trailer: %', v; end if;
  v := pg_temp.try($s$update public.trips set second_trailer_id = 'eb120000-0000-4000-9000-000000000003'
                      where id = 'eb160000-0000-4000-9000-000000000001'$s$);
  if v <> 'equipment-refused-trips' then raise exception 'a generator was added as a second trailer: %', v; end if;
  -- Editing the trip leaves its legitimate trailer alone.
  update public.trips set destination = 'Mbombela' where id = 'eb160000-0000-4000-9000-000000000001';
  -- No route, position or profit for the trailer: its tracking stays refused.
  if public.has_asset_entitlement('eb120000-0000-4000-9000-000000000002', 'trips')
     or public.has_asset_entitlement('eb120000-0000-4000-9000-000000000002', 'maps') then
    raise exception 'the trailer link gave the trailer trip or tracking tools';
  end if;
  -- The owner's own direct writes meet the same rules.
  v := pg_temp.try($s$insert into public.budgets (farm_id, machine_id, period_start, period_end, amount_cents)
                      values ('eb100000-0000-4000-9000-000000000003', 'eb120000-0000-4000-9000-000000000003',
                              date '2026-12-01', date '2026-12-31', 1000)$s$);
  if v <> 'equipment-refused-budgets' then raise exception 'the owner budgeted a generator: %', v; end if;
  -- A person can ask about their own asset; never about another business's.
  if public.has_asset_entitlement('eb120000-0000-4000-9000-000000000003', 'tco')
     or not public.has_asset_entitlement('eb120000-0000-4000-9000-000000000001', 'tco')
     or public.has_asset_entitlement('eb120000-0000-4000-9000-000000000021', 'trips') then
    raise exception 'has_asset_entitlement answered wrongly for the Complete owner';
  end if;
end $t$;
reset role;

-- A manager is held to the same rule.
select pg_temp.as_user('eb110000-0000-4000-9000-000000000005');
set local role authenticated;
do $t$
declare v text;
begin
  v := pg_temp.try($s$insert into public.trips (farm_id, number, machine_id) values
                      ('eb100000-0000-4000-9000-000000000003', 0, 'eb120000-0000-4000-9000-000000000003')$s$);
  if v <> 'equipment-refused-trips' then raise exception 'a manager sent a generator on a trip: %', v; end if;
end $t$;
reset role;

-- == Offline replay (the operator's queued diesel draw) ===================================
do $t$
declare v jsonb; v_text text;
begin
  begin
    v := public.apply_offline_capture(
      'eb170000-0000-4000-9000-000000000001', now() - interval '1 hour', 'log_fuel', 'app',
      'eb110000-0000-4000-9000-000000000004',
      jsonb_build_object('machine_id', 'eb120000-0000-4000-9000-000000000003',
                         'tank_id', 'eb130000-0000-4000-9000-000000000001', 'litres', '30'));
    v_text := coalesce(v->>'status', '?');
  exception when raise_exception then
    v_text := sqlerrm;
  end;
  if v_text = 'applied' then raise exception 'the offline queue drew diesel for a generator'; end if;
  if exists (select 1 from public.fuel_issues where machine_id = 'eb120000-0000-4000-9000-000000000003') then
    raise exception 'a fuel draw reached the generator through the offline queue';
  end if;
end $t$;

-- == A move between the customer's own sites keeps the profile (20261114090400) ===========
insert into public.farms (id, name, plan, status, billing_period, billed_through) values
  ('eb100000-0000-4000-9000-000000000004', 'Complete second site', 'complete', 'active', 'monthly', 'eb100000-0000-4000-9000-000000000003');
insert into public.user_farm_memberships (user_id, farm_id, role, active) values
  ('eb110000-0000-4000-9000-000000000003', 'eb100000-0000-4000-9000-000000000004', 'owner', true)
on conflict (user_id, farm_id) do update set role = excluded.role, active = true;
do $t$
declare v_new uuid;
begin
  v_new := public.move_machine_to_site('eb120000-0000-4000-9000-000000000004', 'eb100000-0000-4000-9000-000000000004',
                                       'eb110000-0000-4000-9000-000000000003');
  if (select profile from public.machines where id = v_new) <> 'equipment' then
    raise exception 'a moved compressor arrived as a full asset';
  end if;
end $t$;

-- == Plan gates on new work ===========================================================
do $t$
declare v text;
begin
  -- Essential keeps the driving log but schedules no trips.
  v := pg_temp.try($s$insert into public.trips (farm_id, number, machine_id) values
                      ('eb100000-0000-4000-9000-000000000001', 0, 'eb120000-0000-4000-9000-000000000012')$s$);
  if v <> 'plan-feature-trips' then raise exception 'Essential scheduled a trip: %', v; end if;
  v := pg_temp.try($s$insert into public.driving_sessions (farm_id, machine_id, driver_id, started_at)
                      values ('eb100000-0000-4000-9000-000000000001', 'eb120000-0000-4000-9000-000000000012',
                              'eb110000-0000-4000-9000-000000000001', now())$s$);
  if v <> 'ok' then raise exception 'Essential lost its driving log: %', v; end if;

  -- Professional schedules trips without maps.
  insert into public.trips (id, farm_id, number, machine_id) values
    ('eb160000-0000-4000-9000-000000000021', 'eb100000-0000-4000-9000-000000000002', 0, 'eb120000-0000-4000-9000-000000000021');
  insert into public.trip_income (trip_id, farm_id, amount_cents) values
    ('eb160000-0000-4000-9000-000000000021', 'eb100000-0000-4000-9000-000000000002', 50000);
  v := pg_temp.try($s$insert into public.trip_routes (trip_id, farm_id, waypoints, geometry, distance_m, duration_s, provider)
                      values ('eb160000-0000-4000-9000-000000000021', 'eb100000-0000-4000-9000-000000000002',
                              '[]', '[]', 1000, 60, 'mapbox')$s$);
  if v <> 'plan-feature-maps' then raise exception 'Professional saved a map route: %', v; end if;
  v := pg_temp.try($s$insert into public.asset_positions (farm_id, machine_id, recorded_at, lat, lng)
                      values ('eb100000-0000-4000-9000-000000000002', 'eb120000-0000-4000-9000-000000000021', now(), -25.4, 31.0)$s$);
  if v <> 'plan-feature-maps' then raise exception 'Professional recorded a position: %', v; end if;

  -- Complete has them for full assets.
  v := pg_temp.try($s$insert into public.asset_positions (farm_id, machine_id, recorded_at, lat, lng)
                      values ('eb100000-0000-4000-9000-000000000003', 'eb120000-0000-4000-9000-000000000001', now(), -25.4, 31.0)$s$);
  if v <> 'ok' then raise exception 'Complete could not record a position: %', v; end if;

  -- The driver's vehicle list leaves equipment out.
  if exists (select 1 from public.machines m
              where m.profile = 'equipment' and m.id in (select x.id from public.machines x where x.farm_id = 'eb100000-0000-4000-9000-000000000003')
                and m.id in (select d.id from public.driving_vehicles('eb100000-0000-4000-9000-000000000003') d)) then
    raise exception 'equipment is offered for a driving log';
  end if;
end $t$;

-- == Scenario 16: Essential repair costs, Professional analytics ===========================
select pg_temp.as_user('eb110000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$ begin
  -- "Replaced trailer tyre, R1,200": an ordinary repair with its cost, on Essential equipment.
  insert into public.job_cards (id, farm_id, machine_id, type) values
    ('eb180000-0000-4000-9000-000000000001', 'eb100000-0000-4000-9000-000000000001', 'eb120000-0000-4000-9000-000000000011', 'repair');
  insert into public.job_card_lines (farm_id, job_card_id, kind, description, qty, unit_cost_cents) values
    ('eb100000-0000-4000-9000-000000000001', 'eb180000-0000-4000-9000-000000000001', 'part', 'Impeller', 1, 85000),
    ('eb100000-0000-4000-9000-000000000001', 'eb180000-0000-4000-9000-000000000001', 'labour', 'Fitting', 2, 17500);
  insert into public.cost_entries (farm_id, machine_id, type, amount_cents, note) values
    ('eb100000-0000-4000-9000-000000000001', 'eb120000-0000-4000-9000-000000000011', 'other', 120000, 'Replaced pump seal');
  -- And the full bakkie keeps its finance and tyre records on Essential.
  if not public.has_asset_entitlement('eb120000-0000-4000-9000-000000000012', 'finance_agreements')
     or not public.has_asset_entitlement('eb120000-0000-4000-9000-000000000012', 'tyre_detail') then
    raise exception 'Essential lost core finance or tyre records for a full asset';
  end if;
  -- Analytics stay Professional: no book value register, no TCO.
  if exists (select 1 from public.farm_book_values('eb100000-0000-4000-9000-000000000001')) then
    raise exception 'Essential reads the book value register';
  end if;
  if public.has_asset_entitlement('eb120000-0000-4000-9000-000000000012', 'tco') then
    raise exception 'Essential has TCO analytics';
  end if;
end $t$;
reset role;
do $t$ begin
  if (select count(*) from public.job_card_lines where job_card_id = 'eb180000-0000-4000-9000-000000000001') <> 2 then
    raise exception 'the repair lines on Essential equipment were not kept';
  end if;
end $t$;

-- On Professional the register lists the tractor, not the plough.
update public.machines set purchase_price_cents = 50000000, purchase_date = date '2024-01-01'
 where id in ('eb120000-0000-4000-9000-000000000021', 'eb120000-0000-4000-9000-000000000022');
select pg_temp.as_user('eb110000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$ begin
  if (select array_agg(machine_id::text) from public.farm_book_values('eb100000-0000-4000-9000-000000000002'))
     is distinct from array['eb120000-0000-4000-9000-000000000021'] then
    raise exception 'the book value register did not list exactly the full asset';
  end if;
end $t$;
reset role;

-- Another business learns nothing about these assets.
select pg_temp.as_user('eb110000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$ begin
  if public.has_asset_entitlement('eb120000-0000-4000-9000-000000000001', 'tco') then
    raise exception 'an outsider read another business''s entitlement';
  end if;
end $t$;
reset role;

rollback;
