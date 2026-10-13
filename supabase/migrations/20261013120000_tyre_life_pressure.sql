-- 20261013120000_tyre_life_pressure.sql
-- The latest tyre check's pressure, beside its tread.
--
-- The assistant's tyre answer now reads every tyre once from tyre_life (one row per tyre,
-- its latest check included) rather than the newest thousand tread checks, which reached
-- back only weeks on a large fleet. tyre_life carried the latest tread but not the pressure
-- recorded with it, so the answer lost the pressure it used to give. Added here; the rows,
-- their order and everything else are unchanged.
--
-- A function's result type cannot change in place, so both are dropped and created again,
-- public wrapper first. Nothing else in the database calls them.

drop function if exists public.tyre_life(uuid);
drop function if exists app.tyre_life(uuid);

create function app.tyre_life(p_farm uuid)
returns table (
  tyre_id            uuid,
  brand              text,
  pattern            text,
  size               text,
  serial_no          text,
  status             tyre_status,
  purchase_cost_cents bigint,
  new_tread_mm       numeric,
  latest_tread_mm    numeric,
  latest_checked_on  date,
  latest_pressure_kpa numeric,
  machine_id         uuid,
  machine_name       text,
  position_label     text,
  axle               tyre_axle,
  fitted_on          date,
  units_run          numeric,
  meter_type         text,
  cost_per_unit_cents numeric
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with spans as (
    select f.tyre_id,
           m.meter_type::text as meter_type,
           sum(
             greatest(
               coalesce(f.removed_reading, m.current_reading) - coalesce(f.fitted_reading, 0), 0)
           ) as units
      from public.tyre_fitments f
      join public.machines m on m.id = f.machine_id
     where f.farm_id = p_farm and f.deleted_at is null
       and f.fitted_reading is not null
     group by f.tyre_id, m.meter_type
  ),
  life as (
    select tyre_id,
           sum(units) as units,
           -- One unit or none. Two different meter types cannot be added.
           case when count(distinct meter_type) = 1 then min(meter_type) else null end as meter_type
      from spans group by tyre_id
  ),
  current_fit as (
    select distinct on (f.tyre_id)
           f.tyre_id, f.machine_id, m.name as machine_name,
           f.position_label, f.axle, f.fitted_on
      from public.tyre_fitments f
      join public.machines m on m.id = f.machine_id
     where f.farm_id = p_farm and f.deleted_at is null and f.removed_on is null
     order by f.tyre_id, f.fitted_on desc
  ),
  latest_check as (
    select distinct on (c.tyre_id) c.tyre_id, c.tread_mm, c.checked_on, c.pressure_kpa
      from public.tyre_checks c
     where c.farm_id = p_farm and c.deleted_at is null
     order by c.tyre_id, c.checked_on desc, c.created_at desc
  )
  select
    t.id, t.brand, t.pattern, t.size, t.serial_no, t.status,
    t.purchase_cost_cents, t.new_tread_mm,
    lc.tread_mm, lc.checked_on, lc.pressure_kpa,
    cf.machine_id, cf.machine_name, cf.position_label, cf.axle, cf.fitted_on,
    l.units, l.meter_type,
    case
      when t.purchase_cost_cents is null or l.units is null or l.units <= 0
        or l.meter_type is null then null
      else round(t.purchase_cost_cents::numeric / l.units, 2)
    end
  from public.tyres t
  left join life l        on l.tyre_id = t.id
  left join current_fit cf on cf.tyre_id = t.id
  left join latest_check lc on lc.tyre_id = t.id
  where t.farm_id = p_farm and t.deleted_at is null
  order by cf.machine_name nulls last, cf.position_label nulls last, t.created_at;
$$;

revoke execute on function app.tyre_life(uuid) from public, anon;
grant  execute on function app.tyre_life(uuid) to authenticated, service_role;

create function public.tyre_life(p_farm uuid)
returns table (
  tyre_id            uuid,
  brand              text,
  pattern            text,
  size               text,
  serial_no          text,
  status             tyre_status,
  purchase_cost_cents bigint,
  new_tread_mm       numeric,
  latest_tread_mm    numeric,
  latest_checked_on  date,
  latest_pressure_kpa numeric,
  machine_id         uuid,
  machine_name       text,
  position_label     text,
  axle               tyre_axle,
  fitted_on          date,
  units_run          numeric,
  meter_type         text,
  cost_per_unit_cents numeric
)
language sql stable security invoker set search_path = public, app, pg_temp as $$
  select * from app.tyre_life(p_farm);
$$;

revoke execute on function public.tyre_life(uuid) from public, anon;
grant  execute on function public.tyre_life(uuid) to authenticated, service_role;

comment on function public.tyre_life(uuid) is
  'Every tyre on a farm with where it is fitted, its latest tread and pressure, how far it has '
  'run and what that has cost per hour or per kilometre. A tyre run on both an hours machine '
  'and a km machine gets no rate, because those cannot be added.';
