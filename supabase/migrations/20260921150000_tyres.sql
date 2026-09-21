-- 20260921150000_tyres.sql
-- Tyres: where each one is fitted, how much tread is left, and what it cost per hour.
--
-- On a truck fleet tyres are the second largest running cost after diesel, and on a farm
-- they are the cost nobody measures. "Tyre" exists in this product only as a fault
-- category. A tyre is bought, fitted, rotated, run bald and replaced, and the whole of
-- that is invisible: there is no way to answer "how long did the last set last" or "which
-- position eats tyres on that trailer".
--
-- A TYRE IS A THING; A FITMENT IS WHERE IT IS
-- =============================================================================
-- Two tables, not one, because a tyre MOVES. Rotating front to back is the ordinary
-- maintenance this feature exists to support, and a single table with a position column
-- would either lose the history on every rotation or need a second table anyway. The tyre
-- carries what it is and what it cost; the fitment carries where and when.
--
-- WEAR IS MEASURED IN THE MACHINE'S OWN UNIT
-- =============================================================================
-- Hours for a tractor, kilometres for a truck. Both are `meter_reading` on the machine, so
-- a fitment records the reading it went on at and the reading it came off at, and cost per
-- unit is arithmetic on those. A tyre fitted to an hours machine and later to a km one
-- cannot be summed, and the function below refuses to rather than producing a number that
-- means nothing.
--
-- MONEY IS EX-VAT, like every other cost in this schema.

create type tyre_axle as enum ('steer', 'drive', 'trailer', 'implement', 'spare', 'other');

create type tyre_status as enum (
  'in_stock',   -- bought, not yet on a machine
  'fitted',     -- on a machine now
  'removed',    -- off, and keepable: a spare or a part-worn
  'scrapped'    -- done
);

create table tyres (
  id                 uuid primary key default gen_random_uuid(),
  farm_id            uuid not null,

  -- What it is. Serial is how a farm tells two identical tyres apart, and it is optional
  -- because most never record one.
  brand              text,
  pattern            text,
  size               text,
  serial_no          text,

  status             tyre_status not null default 'in_stock',
  purchase_date      date,
  -- Ex-VAT cents, like every other cost here.
  purchase_cost_cents bigint,
  supplier           text,

  -- The tread it started with, in millimetres. The baseline every later check is measured
  -- against; without it a 6mm reading is a number and not an answer.
  new_tread_mm       numeric(4,1),
  notes              text,

  created_by         uuid references users(id),
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_by         uuid,

  constraint tyres_farm_fk foreign key (farm_id) references farms(id),
  constraint tyres_id_farm_uq unique (id, farm_id),
  constraint tyres_money_ck check (purchase_cost_cents is null or purchase_cost_cents >= 0),
  constraint tyres_tread_ck check (new_tread_mm is null or (new_tread_mm > 0 and new_tread_mm <= 100))
);

create index tyres_farm_idx   on tyres(farm_id) where deleted_at is null;
create index tyres_status_idx on tyres(farm_id, status) where deleted_at is null;

comment on table tyres is
  'A tyre as an object that outlives any one position on any one machine. Where it is '
  'fitted lives in tyre_fitments, because rotating is ordinary maintenance.';

-- == Where it is, and when it was there ======================================
create table tyre_fitments (
  id              uuid primary key default gen_random_uuid(),
  farm_id         uuid not null,
  tyre_id         uuid not null,
  machine_id      uuid not null,

  axle            tyre_axle not null default 'other',
  -- "LF", "RR", "2L". Free text because axle layouts differ wildly between a bakkie, a
  -- six-wheel truck and a twelve-row planter, and an enum would be wrong by the second farm.
  position_label  text,

  fitted_on       date not null default current_date,
  -- The machine's meter when it went on, in the machine's own unit.
  fitted_reading  numeric(12,1),
  removed_on      date,
  removed_reading numeric(12,1),
  removal_reason  text,

  created_by      uuid references users(id),
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  deleted_by      uuid,

  constraint tyre_fitments_tyre_fk    foreign key (tyre_id, farm_id) references tyres(id, farm_id),
  constraint tyre_fitments_machine_fk foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint tyre_fitments_farm_fk    foreign key (farm_id) references farms(id),
  -- A tyre cannot come off before it went on, and the meter cannot run backwards while it
  -- is fitted. Both of those produce a negative life, and a negative life produces a
  -- cost-per-hour that reads like a bargain.
  constraint tyre_fitments_dates_ck check (removed_on is null or removed_on >= fitted_on),
  constraint tyre_fitments_reading_ck check (
    removed_reading is null or fitted_reading is null or removed_reading >= fitted_reading
  ),
  constraint tyre_fitments_removed_ck check (
    (removed_on is null and removal_reason is null) or removed_on is not null
  )
);

create index tyre_fitments_farm_idx    on tyre_fitments(farm_id) where deleted_at is null;
create index tyre_fitments_tyre_idx    on tyre_fitments(tyre_id, fitted_on desc);
create index tyre_fitments_machine_idx on tyre_fitments(machine_id, fitted_on desc);

-- One tyre is in one place at a time. Physically true, and the thing that makes "which
-- tyres are on this machine" answerable at all.
create unique index tyre_fitments_one_live_per_tyre
  on tyre_fitments(tyre_id) where removed_on is null and deleted_at is null;

-- == Tread checks ============================================================
create table tyre_checks (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid not null,
  tyre_id      uuid not null,
  checked_on   date not null default current_date,
  tread_mm     numeric(4,1) not null,
  -- The machine's meter at the check, so wear per hour is arithmetic rather than a guess.
  reading      numeric(12,1),
  pressure_kpa numeric(6,1),
  notes        text,
  checked_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid,

  constraint tyre_checks_tyre_fk foreign key (tyre_id, farm_id) references tyres(id, farm_id),
  constraint tyre_checks_farm_fk foreign key (farm_id) references farms(id),
  constraint tyre_checks_tread_ck check (tread_mm >= 0 and tread_mm <= 100),
  constraint tyre_checks_pressure_ck check (pressure_kpa is null or pressure_kpa > 0)
);

create index tyre_checks_farm_idx on tyre_checks(farm_id) where deleted_at is null;
create index tyre_checks_tyre_idx on tyre_checks(tyre_id, checked_on desc);

-- == RLS =====================================================================
-- Role-aware where there is a machine to be aware of. `tyres` and `tyre_checks` are not
-- machine-keyed (a tyre in the store is on no machine at all), so they are farm-scoped;
-- the cost on a tyre is the farm's cost and sits behind the same reasoning as any other.
do $$
declare t text;
begin
  foreach t in array array['tyres', 'tyre_checks'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format(
      'create policy %I on %I for select to authenticated using (deleted_at is null and app.has_farm_access(farm_id))',
      t || '_sel', t);
    execute format(
      'create policy %I on %I for insert to authenticated with check (app.has_farm_access(farm_id))',
      t || '_ins', t);
    execute format(
      'create policy %I on %I for update to authenticated using (app.has_farm_access(farm_id)) with check (app.has_farm_access(farm_id))',
      t || '_upd', t);
    execute format(
      'create policy %I on %I for delete to authenticated using (app.has_farm_access(farm_id))',
      t || '_del', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
    execute format(
      'create trigger %I after insert or update or delete on %I for each row execute function app_audit()',
      t || '_audit', t);
  end loop;
end $$;

alter table tyre_fitments enable row level security;
alter table tyre_fitments force  row level security;
create policy tyre_fitments_sel on tyre_fitments for select to authenticated
  using (deleted_at is null and app.row_visible_to_role(farm_id, machine_id));
create policy tyre_fitments_ins on tyre_fitments for insert to authenticated
  with check (app.has_farm_access(farm_id));
create policy tyre_fitments_upd on tyre_fitments for update to authenticated
  using (app.has_farm_access(farm_id)) with check (app.has_farm_access(farm_id));
create policy tyre_fitments_del on tyre_fitments for delete to authenticated
  using (app.has_farm_access(farm_id));
grant select, insert, update, delete on tyre_fitments to authenticated;
grant all on tyre_fitments to service_role;
create trigger tyre_fitments_audit
  after insert or update or delete on tyre_fitments
  for each row execute function app_audit();

-- == Fitting and removing, atomically ========================================
--
-- Two writes that must not come apart: the fitment row and the tyre's status. Done in the
-- app they would be two round trips, and a tyre marked `fitted` with no fitment row is a
-- tyre nobody can find.
create or replace function app.fit_tyre(
  p_tyre uuid, p_machine uuid, p_axle tyre_axle, p_position text,
  p_on date default null, p_reading numeric default null
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_farm uuid;
  v_id   uuid;
begin
  select farm_id into v_farm from public.tyres
   where id = p_tyre and deleted_at is null;
  if v_farm is null then
    raise exception 'That tyre is not here.' using errcode = 'P0002';
  end if;

  -- Taking it off whatever it was on first. A rotation is a removal and a fitment, and
  -- doing them in one call is what stops a farm recording only half of it.
  update public.tyre_fitments
     set removed_on = coalesce(p_on, current_date),
         removed_reading = p_reading,
         removal_reason = coalesce(removal_reason, 'moved')
   where tyre_id = p_tyre and removed_on is null and deleted_at is null;

  insert into public.tyre_fitments
    (farm_id, tyre_id, machine_id, axle, position_label, fitted_on, fitted_reading, created_by)
  values (v_farm, p_tyre, p_machine, coalesce(p_axle, 'other'), nullif(btrim(p_position), ''),
          coalesce(p_on, current_date), p_reading, auth.uid())
  returning id into v_id;

  update public.tyres set status = 'fitted' where id = p_tyre;
  return v_id;
end $$;

grant execute on function app.fit_tyre(uuid, uuid, tyre_axle, text, date, numeric)
  to authenticated, service_role;

create or replace function public.fit_tyre(
  p_tyre uuid, p_machine uuid, p_axle tyre_axle, p_position text,
  p_on date default null, p_reading numeric default null
) returns uuid
language sql security invoker set search_path = public, app, pg_temp as $$
  select app.fit_tyre(p_tyre, p_machine, p_axle, p_position, p_on, p_reading);
$$;
revoke execute on function public.fit_tyre(uuid, uuid, tyre_axle, text, date, numeric) from public, anon;
grant  execute on function public.fit_tyre(uuid, uuid, tyre_axle, text, date, numeric)
  to authenticated, service_role;

create or replace function app.remove_tyre(
  p_tyre uuid, p_reason text, p_on date default null, p_reading numeric default null,
  p_scrap boolean default false
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare v_rows integer;
begin
  update public.tyre_fitments
     set removed_on = coalesce(p_on, current_date),
         removed_reading = p_reading,
         removal_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where tyre_id = p_tyre and removed_on is null and deleted_at is null;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'That tyre is not fitted to anything.' using errcode = 'P0002';
  end if;

  update public.tyres
     set status = case when p_scrap then 'scrapped'::tyre_status else 'removed'::tyre_status end
   where id = p_tyre and deleted_at is null;
end $$;

grant execute on function app.remove_tyre(uuid, text, date, numeric, boolean)
  to authenticated, service_role;

create or replace function public.remove_tyre(
  p_tyre uuid, p_reason text, p_on date default null, p_reading numeric default null,
  p_scrap boolean default false
) returns void
language sql security invoker set search_path = public, app, pg_temp as $$
  select app.remove_tyre(p_tyre, p_reason, p_on, p_reading, p_scrap);
$$;
revoke execute on function public.remove_tyre(uuid, text, date, numeric, boolean) from public, anon;
grant  execute on function public.remove_tyre(uuid, text, date, numeric, boolean)
  to authenticated, service_role;

-- == What each tyre has cost, per hour or per kilometre ======================
--
-- The number the whole feature is for. Life is the sum of every fitment's reading span, so
-- a tyre rotated three times still has one life.
--
-- A tyre that has run on BOTH an hours machine and a km machine gets a null rate rather
-- than a sum, because adding hours to kilometres produces a figure that reads like an
-- answer and is not one.
create or replace function app.tyre_life(p_farm uuid)
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
    select distinct on (c.tyre_id) c.tyre_id, c.tread_mm, c.checked_on
      from public.tyre_checks c
     where c.farm_id = p_farm and c.deleted_at is null
     order by c.tyre_id, c.checked_on desc, c.created_at desc
  )
  select
    t.id, t.brand, t.pattern, t.size, t.serial_no, t.status,
    t.purchase_cost_cents, t.new_tread_mm,
    lc.tread_mm, lc.checked_on,
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

grant execute on function app.tyre_life(uuid) to authenticated, service_role;

create or replace function public.tyre_life(p_farm uuid)
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
  'Every tyre on a farm with where it is fitted, its latest tread, how far it has run and '
  'what that has cost per hour or per kilometre. A tyre run on both an hours machine and a '
  'km machine gets no rate, because those cannot be added.';
